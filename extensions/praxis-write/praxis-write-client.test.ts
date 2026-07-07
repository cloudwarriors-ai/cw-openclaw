import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fileIssue,
  getApiToken,
  getIssue,
  ingestIssue,
  mapStateToUatKindPrefix,
  praxisFetch,
  runSelfHeal,
  startGithubLink,
  submitCommand,
  submitVerdict,
} from "./praxis-write-client.js";

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

describe("mapStateToUatKindPrefix", () => {
  it("maps dev_uat to uat1", () => {
    expect(mapStateToUatKindPrefix("dev_uat")).toBe("uat1");
  });

  it("maps user_uat to uat2", () => {
    expect(mapStateToUatKindPrefix("user_uat")).toBe("uat2");
  });

  it("returns undefined for non-UAT states", () => {
    expect(mapStateToUatKindPrefix("blocked")).toBeUndefined();
    expect(mapStateToUatKindPrefix("in_progress")).toBeUndefined();
    expect(mapStateToUatKindPrefix("done")).toBeUndefined();
    expect(mapStateToUatKindPrefix("")).toBeUndefined();
  });
});

describe("submitVerdict", () => {
  it("POSTs the verdict body with channel_user_id and returns the raw result", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { applied: true, state: "done" } }),
    );
    const res = await submitVerdict(7, {
      kind: "uat1_pass",
      reason: "feature verified",
      requested_by: "alice",
      channel: "zoom",
      channel_user_id: "alice",
    });
    expect(res).toEqual({ ok: true, status: 200, data: { applied: true, state: "done" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/issues/7/events`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      kind: "uat1_pass",
      reason: "feature verified",
      requested_by: "alice",
      channel: "zoom",
      channel_user_id: "alice",
    });
  });

  it("returns structured 403 on identity_not_linked without throwing", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 403, body: { error: "identity_not_linked" } }),
    );
    const res = await submitVerdict(7, {
      kind: "uat2_fail",
      reason: "broken",
      requested_by: "alice",
      channel: "zoom",
      channel_user_id: "alice",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect((res.data as Record<string, unknown>).error).toBe("identity_not_linked");
  });
});

describe("startGithubLink", () => {
  it("POSTs channel + channel_user_id and returns the url", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { url: "https://github.com/login/oauth/authorize?state=abc" },
      }),
    );
    const res = await startGithubLink({ channel: "zoom", channel_user_id: "alice" });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).url).toBe(
      "https://github.com/login/oauth/authorize?state=abc",
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/identity/link`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ channel: "zoom", channel_user_id: "alice" });
  });

  it("returns 400 linking_not_configured without throwing", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 400, body: { error: "linking_not_configured" } }),
    );
    const res = await startGithubLink({ channel: "zoom", channel_user_id: "alice" });
    expect(res.ok).toBe(false);
    expect((res.data as Record<string, unknown>).error).toBe("linking_not_configured");
  });
});

describe("runSelfHeal", () => {
  it("POSTs the self-heal run body and returns the result", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { mode: "create-issues", target_repo: "cw/foo", issues_created: 1 },
      }),
    );
    const res = await runSelfHeal({ repo: "cw/foo", mode: "create-issues", since_minutes: 90 });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).issues_created).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/self-heal/run`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ repo: "cw/foo", mode: "create-issues", since_minutes: 90 });
  });
});

describe("ingestIssue", () => {
  it("POSTs the ingest body with audit context and returns the raw result", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { ingested: true, source_issue: 1015, state: "assessing", already_tracked: false },
      }),
    );
    const res = await ingestIssue({
      full_name: "cw/foo",
      number: 1015,
      requested_by: "john",
      channel: "zoom:room",
      message_id: "m-9",
      idempotency_key: "ingest:cw/foo:1015",
    });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).source_issue).toBe(1015);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/issues/ingest`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      full_name: "cw/foo",
      number: 1015,
      requested_by: "john",
      channel: "zoom:room",
      message_id: "m-9",
      idempotency_key: "ingest:cw/foo:1015",
    });
  });

  it("returns a structured 404 repo_not_onboarded without throwing", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 404, body: { error: "repo_not_onboarded" } }),
    );
    const res = await ingestIssue({
      full_name: "cw/ghost",
      number: 5,
      requested_by: "john",
      channel: "zoom",
      message_id: "m-1",
      idempotency_key: "ingest:cw/ghost:5",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect((res.data as Record<string, unknown>).error).toBe("repo_not_onboarded");
  });
});

describe("fileIssue", () => {
  it("POSTs the file body (omitting labels when not given) and returns the raw result", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { filed: true, full_name: "cloudwarriors-ai/praxis", number: 42 },
      }),
    );
    const res = await fileIssue({
      full_name: "cloudwarriors-ai/praxis",
      title: "Fix retry",
      body: "details",
      requested_by: "john",
      channel: "zoom:room",
      message_id: "m-9",
      idempotency_key: "file-issue:cloudwarriors-ai/praxis:Fix retry",
    });
    expect(res.ok).toBe(true);
    expect((res.data as Record<string, unknown>).number).toBe(42);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/issues/file`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent.full_name).toBe("cloudwarriors-ai/praxis");
    expect(sent.title).toBe("Fix retry");
    expect(sent.labels).toBeUndefined();
  });

  it("includes labels when provided", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { filed: true, number: 1 } }),
    );
    await fileIssue({
      full_name: "cw/other",
      title: "t",
      body: "",
      labels: ["bug"],
      requested_by: "john",
      channel: "zoom",
      message_id: "m-1",
      idempotency_key: "file-issue:cw/other:t",
    });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(sent.labels).toEqual(["bug"]);
  });
});
