import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

class MockWebSocket extends EventEmitter {
  static mode: "challenge" | "no-challenge" = "challenge";
  static instances: MockWebSocket[] = [];
  sentFrames: Array<Record<string, unknown>> = [];

  constructor(_url: string) {
    super();
    MockWebSocket.instances.push(this);
    setImmediate(() => {
      this.emit("open");
      if (MockWebSocket.mode === "challenge") {
        this.emit(
          "message",
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce: "nonce-123" },
          }),
        );
      }
    });
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.sentFrames.push(frame);

    if (frame.method === "connect") {
      this.emit(
        "message",
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            server: { version: "test", host: "test", connId: "conn-1" },
            features: { methods: [], events: [] },
            snapshot: { presence: [], stateVersion: { presence: 0, health: 0 } },
            policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 30_000 },
          },
        }),
      );
      return;
    }

    this.emit(
      "message",
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { ok: true },
      }),
    );
  }

  close() {
    this.emit("close", 1000, Buffer.from(""));
  }
}

vi.mock("ws", () => ({
  WebSocket: MockWebSocket,
}));

describe("GatewayRpcClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    MockWebSocket.mode = "challenge";
    MockWebSocket.instances = [];
  });

  it("signs connect payload with challenge nonce and invokes method", async () => {
    const { GatewayRpcClient } = await import("./gateway-client.js");
    const client = new GatewayRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
      timeoutMs: 2_000,
    });

    const result = await client.request<{ ok: boolean }>("slm.control.qa.list", {
      tenant_id: "tenant-a",
    });
    expect(result.ok).toBe(true);

    const socket = MockWebSocket.instances[0];
    const connectFrame = socket?.sentFrames.find((frame) => frame.method === "connect");
    const params = connectFrame?.params as Record<string, unknown> | undefined;
    const device = (params?.device ?? {}) as Record<string, unknown>;

    expect(params?.scopes).toEqual(["operator.admin"]);
    expect(device.id).toEqual(expect.any(String));
    expect(device.publicKey).toEqual(expect.any(String));
    expect(device.signature).toEqual(expect.any(String));
    expect(device.nonce).toBe("nonce-123");
  });

  it("falls back to nonce-less connect when no challenge arrives", async () => {
    MockWebSocket.mode = "no-challenge";
    vi.useFakeTimers();

    const { GatewayRpcClient } = await import("./gateway-client.js");
    const client = new GatewayRpcClient({
      url: "ws://127.0.0.1:18789",
      token: "test-token",
      timeoutMs: 2_000,
    });

    const requestPromise = client.request<{ ok: boolean }>("slm.control.qa.list", {
      tenant_id: "tenant-a",
    });
    await vi.advanceTimersByTimeAsync(600);
    const result = await requestPromise;
    expect(result.ok).toBe(true);
  });
});
