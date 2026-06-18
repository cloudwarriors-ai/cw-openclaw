import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiToken, getIssue, praxisFetch, submitCommand } from "./praxis-write-client.js";

const BASE = "http://praxis:8000";

function mockResponse(opts: { ok: boolean; status: number; body: unknown }): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => opts.body,
    text: async () => JSON.stringify(opts.body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("PRAXIS_API_TOKEN", "test-token");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getApiToken", () => {
  it("returns the env token", () => {
    expect(getApiToken()).toBe("test-token");
  });

  it("throws when unset", () => {
    vi.stubEnv("PRAXIS_API_TOKEN", "");
    expect(() => getApiToken()).toThrow("PRAXIS_API_TOKEN env var required");
  });
});

describe("praxisFetch", () => {
  it("attaches the bearer and does not throw on non-2xx", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 409, body: { error: "x" } }));
    const res = await praxisFetch("/api/v1/issues/5/events", { method: "POST", body: "{}" });
    expect(res).toEqual({ ok: false, status: 409, data: { error: "x" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/issues/5/events`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });
});

describe("getIssue", () => {
  it("returns the issue state body", async () => {
    const body = { id: 5, state: "blocked", state_reason: "no_response", version: 12 };
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body }));
    expect(await getIssue(5)).toEqual(body);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v1/issues/5`);
  });

  it("throws on a 404 without echoing the token", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404, body: { detail: "x" } }));
    await expect(getIssue(999)).rejects.toThrow(/Praxis API 404 on \/api\/v1\/issues\/999/);
    await expect(getIssue(999)).rejects.not.toThrow(/test-token/);
  });
});

describe("submitCommand", () => {
  it("POSTs the command + audit context and returns the raw structured result", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { error: "", applied: true, state: "needs_info" },
      }),
    );
    const res = await submitCommand(5, {
      kind: "unblock",
      reason: "reporter idle",
      requested_by: "alice",
      channel: "dev_praxis",
      message_id: "m-1",
      idempotency_key: "unblock:5:12",
    });
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { error: "", applied: true, state: "needs_info" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/issues/5/events`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      kind: "unblock",
      reason: "reporter idle",
      requested_by: "alice",
      channel: "dev_praxis",
      message_id: "m-1",
      idempotency_key: "unblock:5:12",
    });
    // No client-supplied payload or actor_id: the server derives + binds those.
    expect(sent.payload).toBeUndefined();
    expect(sent.actor_id).toBeUndefined();
  });
});
