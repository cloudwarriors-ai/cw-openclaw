import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("bigheadbot tool scoping", () => {
  it("registers every tool as optional so per-agent allowlists can scope them", () => {
    // Non-optional plugin tools bypass allowlists and leak into every agent's
    // menu; optional ones are only visible to agents whose tools.allow opts in.
    process.env.OPENCLAW_WORKSPACE = os.tmpdir();
    const optionalFlags: Array<boolean | undefined> = [];
    const api = {
      registerTool: vi.fn((_tool: unknown, opts?: { optional?: boolean }) => {
        optionalFlags.push(opts?.optional);
      }),
      on: vi.fn(),
    } as never;

    plugin.register(api, undefined);

    expect(optionalFlags.length).toBeGreaterThan(0);
    expect(optionalFlags.every((flag) => flag === true)).toBe(true);
  });
});

// Six gated bots register the same first-claim-wins before_dispatch hook; each must
// only claim CONFIRMs from its OWN agent sessions (2026-07-20 incident: pulsebot
// claimed a scopelybot confirm and answered "expired" from its own empty store).
describe("bigheadbot confirm claim scoping", () => {
  type Handler = (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ handled: boolean; text?: string } | undefined>;

  function registerAndGetBeforeDispatch(): Handler {
    process.env.OPENCLAW_WORKSPACE = os.tmpdir();
    const handlers = new Map<string, Handler>();
    const api = {
      registerTool: vi.fn(),
      on: vi.fn((name: string, fn: Handler) => {
        handlers.set(name, fn);
      }),
    } as never;
    plugin.register(api, undefined);
    const handler = handlers.get("before_dispatch");
    if (!handler) throw new Error("before_dispatch handler not registered");
    return handler;
  }

  it("declines a CONFIRM from another agent's zoom session (does not steal it)", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 8248" },
      {
        channelId: "zoom",
        conversationId: "thread-1",
        sessionKey: "agent:scopelybot:zoom:channel:thread-1",
        senderId: "someone",
      },
    );
    expect(result).toBeUndefined();
  });

  it("claims a CONFIRM from its own zoom session", async () => {
    const handler = registerAndGetBeforeDispatch();
    const result = await handler(
      { content: "CONFIRM 8248" },
      {
        channelId: "zoom",
        conversationId: "thread-1",
        sessionKey: "agent:bigheadbot:zoom:channel:thread-1",
        senderId: "someone",
      },
    );
    expect(result?.handled).toBe(true);
  });
});
