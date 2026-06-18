import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { mintConfirmToken } from "./policy.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const ISSUE = { id: 5, state: "blocked", state_reason: "no_response", version: 12 };

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

const DEFAULT_CTX = {
  requesterSenderId: "alice",
  deliveryContext: { channel: "dev_praxis", threadId: 1 },
  sessionId: "s1",
};

function buildTools(opts?: { pluginConfig?: unknown; toolContext?: unknown }): {
  tools: Record<string, ToolDef>;
  registerOpts: Record<string, unknown>[];
} {
  const tools: Record<string, ToolDef> = {};
  const registerOpts: Record<string, unknown>[] = [];
  const toolContext = opts?.toolContext ?? DEFAULT_CTX;
  const api = {
    pluginConfig: opts?.pluginConfig,
    registerTool: (factory: unknown, opt?: unknown) => {
      const t = typeof factory === "function" ? factory(toolContext) : factory;
      tools[(t as ToolDef).name] = t as ToolDef;
      registerOpts.push((opt ?? {}) as Record<string, unknown>);
    },
  } as never;
  plugin.register(api);
  return { tools, registerOpts };
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

const ALLOW_ALICE = { allowedUsers: ["alice"], allowedChannels: ["dev_praxis"] };

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

describe("praxis-write registration", () => {
  it("registers exactly the two write tools, both optional", () => {
    const { tools, registerOpts } = buildTools();
    expect(Object.keys(tools).toSorted()).toEqual(["praxis_cancel", "praxis_unblock"]);
    expect(registerOpts).toHaveLength(2);
    expect(registerOpts.every((o) => o.optional === true)).toBe(true);
  });
});

describe("policy gate (no mutation reaches Praxis)", () => {
  it("fails closed when the allowlist is unconfigured", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(await tools.praxis_unblock.execute("c1", { issue_id: 5, reason: "go" }));
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies a requester not on the allowlist", async () => {
    const { tools } = buildTools({ pluginConfig: { allowedUsers: ["bob"] } });
    const out = parse(await tools.praxis_unblock.execute("c1", { issue_id: 5, reason: "go" }));
    expect(out).toEqual({ ok: false, denied: "requester_not_allowlisted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies when the runtime gives no requester identity (cannot be spoofed via args)", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: { deliveryContext: { channel: "dev_praxis" } },
    });
    const out = parse(
      await tools.praxis_unblock.execute("c1", {
        issue_id: 5,
        reason: "go",
        requested_by: "alice", // model-supplied arg is ignored; identity is trusted-context only
      }),
    );
    expect(out).toEqual({ ok: false, denied: "no_requester_identity" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a reason before any fetch", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_unblock.execute("c1", { issue_id: 5, reason: "   " }));
    expect(out).toEqual({ ok: false, error: "reason_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("two-step dry-run / confirm", () => {
  it("first call previews and mutates nothing", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: ISSUE }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_unblock.execute("c1", { issue_id: 5, reason: "reporter idle" }),
    );

    expect(out.preview).toBe(true);
    expect(out.action).toBe("unblock");
    expect(out.issue).toEqual(ISSUE);
    expect(typeof out.confirm_token).toBe("string");
    // Exactly one call (the GET) — no POST mutation.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("a fabricated/wrong confirm token re-previews instead of executing", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: ISSUE }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_unblock.execute("c1", {
        issue_id: 5,
        reason: "reporter idle",
        confirm: "deadbeefdeadbeef",
      }),
    );
    expect(out.preview).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only, still no POST
  });

  it("executes on a valid confirm token, sending the trusted actor context", async () => {
    // The flow does GET (fetch issue) then POST (submit) — mock them in that order.
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: { error: "", applied: true, state: "needs_info" },
        }),
      );
    const token = mintConfirmToken({ secret: "test-token", kind: "unblock", issue: ISSUE });

    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_unblock.execute("c9", {
        issue_id: 5,
        reason: "reporter idle",
        confirm: token,
      }),
    );

    expect(out).toEqual({ ok: true, status: 200, error: "", applied: true, state: "needs_info" });
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(post?.[0]).toBe("http://praxis:8000/api/v1/issues/5/events");
    const body = JSON.parse(post?.[1].body as string);
    expect(body).toEqual({
      kind: "unblock",
      reason: "reporter idle",
      requested_by: "alice",
      channel: "dev_praxis",
      message_id: "1",
      idempotency_key: "unblock:5:12",
    });
  });
});

describe("praxis_cancel", () => {
  it("rejects an unsupported kind before any fetch", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_cancel.execute("c1", {
        issue_id: 5,
        kind: "manual_override",
        reason: "x",
      }),
    );
    expect(out.error).toBe("unsupported_kind");
    expect(out.allowed).toContain("cancelled");
    expect(out.allowed).not.toContain("manual_override");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews a valid cancel kind", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: ISSUE }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_cancel.execute("c1", {
        issue_id: 5,
        kind: "duplicate",
        reason: "dupe of #4",
      }),
    );
    expect(out.preview).toBe(true);
    expect(out.action).toBe("duplicate");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
