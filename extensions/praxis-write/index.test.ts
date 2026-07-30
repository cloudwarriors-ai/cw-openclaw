import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  conversationIdempotencyKey,
  mintConfirmToken,
  mintFileIssueConfirmToken,
  mintIngestConfirmToken,
  mintRepoConfirmToken,
  mintSelfHealConfirmToken,
} from "./policy.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const ISSUE = {
  id: 5,
  repo: "cw/app",
  source_issue: 5,
  state: "blocked",
  state_reason: "no_response",
  version: 12,
  contracts: ["conversation_ack_v1"],
};
const ISSUE_DEV_UAT = { ...ISSUE, id: 7, source_issue: 70, state: "dev_uat", version: 3 };
const ISSUE_USER_UAT = { ...ISSUE, id: 8, source_issue: 80, state: "user_uat", version: 5 };

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
  currentMessageId: "1",
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

function expectedConversationKey(purpose: "verdict" | "info", issueId: number, toolCallId: string) {
  return conversationIdempotencyKey(purpose, issueId, {
    requestedBy: "alice",
    channel: "dev_praxis",
    messageId: "1",
    inboundMessageId: "1",
    toolCallId,
  });
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

describe("praxis-write registration", () => {
  it("registers exactly the fourteen tools, all optional", () => {
    const { tools, registerOpts } = buildTools();
    expect(Object.keys(tools).toSorted()).toEqual([
      "praxis_cancel",
      "praxis_file_issue",
      "praxis_ingest",
      "praxis_link_github",
      "praxis_link_status",
      "praxis_my_issue",
      "praxis_my_issues",
      "praxis_onboard",
      "praxis_opt_in",
      "praxis_opt_out",
      "praxis_provide_info",
      "praxis_self_heal",
      "praxis_submit_verdict",
      "praxis_unblock",
    ]);
    expect(registerOpts).toHaveLength(14);
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
    expect(out.issue).toEqual({
      id: ISSUE.id,
      state: ISSUE.state,
      state_reason: ISSUE.state_reason,
      version: ISSUE.version,
    });
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

describe("praxis_submit_verdict", () => {
  it("fails policy gate when unconfigured", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c1", {
        issue_id: 7,
        verdict: "pass",
        reason: "looks good",
      }),
    );
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported verdict value before any fetch", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c1", {
        issue_id: 7,
        verdict: "maybe",
        reason: "not sure",
      }),
    );
    expect(out.error).toBe("unsupported_verdict");
    expect(out.allowed).toContain("pass");
    expect(out.allowed).toContain("fail");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a concrete summary for fail before any fetch", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c1", {
        issue_id: 7,
        verdict: "fail",
        reason: "  ",
      }),
    );
    expect(out).toEqual({ ok: false, error: "failure_summary_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before mutation when the server does not advertise the acknowledgement contract", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { ...ISSUE_DEV_UAT, contracts: undefined },
      }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("contract-gate", {
        issue_id: 7,
        verdict: "pass",
      }),
    );

    expect(out.denied).toBe("server_contract_unconfirmed");
    expect(out.message).toContain("Upgrade Praxis");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before mutation when the transport omits a trusted inbound message id", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: {
        requesterSenderId: "alice",
        deliveryContext: { channel: "dev_praxis", threadId: 1 },
        sessionId: "s1",
      },
    });
    const out = parse(
      await tools.praxis_submit_verdict.execute("missing-message-id", {
        issue_id: 7,
        verdict: "pass",
      }),
    );

    expect(out.denied).toBe("inbound_message_id_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns issue_not_awaiting_verdict when the issue state is not dev_uat or user_uat", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: ISSUE }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c1", {
        issue_id: 5,
        verdict: "pass",
        reason: "looks good",
      }),
    );
    expect(out.error).toBe("issue_not_awaiting_verdict");
    expect(out.state).toBe("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET
    // No POST was sent
    expect(
      fetchMock.mock.calls.every(
        (c: unknown[]) => (c[1] as RequestInit | undefined)?.method !== "POST",
      ),
    ).toBe(true);
  });

  it("submits a stage-neutral pass for a dev_uat issue with verified Zoom identity", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_DEV_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: true,
            state: "user_uat",
            message:
              "Thanks - I recorded your development pass for cw/app#70. Praxis is moving it to user validation now.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c2", {
        issue_id: 7,
        verdict: "pass",
        reason: "Validated checkout against build 2026.07.29.",
      }),
    );
    expect(out).toEqual({
      ok: true,
      status: 200,
      applied: true,
      state: "user_uat",
      message:
        "Thanks - I recorded your development pass for cw/app#70. Praxis is moving it to user validation now.",
    });

    const post = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    if (!post) {
      throw new Error("expected a POST call");
    }
    expect(post[0]).toBe("http://praxis:8000/api/v1/issues/7/events");
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body).toEqual({
      kind: "uat_pass",
      reason: "Validated checkout against build 2026.07.29.",
      requested_by: "alice",
      channel: "zoom",
      channel_user_id: "alice",
      message_id: "1",
      idempotency_key: expectedConversationKey("verdict", 7, "c2"),
      expected_state: "dev_uat",
      expected_version: 3,
    });
  });

  it("accepts a bare user pass and returns the frozen acknowledgement", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: true,
            state: "done",
            message: "Thanks - I recorded your pass for cw/app#80. This Praxis run is complete.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("bare-pass", {
        issue_id: 8,
        verdict: "pass",
      }),
    );

    expect(out.message).toBe(
      "Thanks - I recorded your pass for cw/app#80. This Praxis run is complete.",
    );
    const post = fetchMock.mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeDefined();
    if (!post) {
      throw new Error("expected verdict POST");
    }
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body.reason).toBe("Pass verdict submitted without additional rationale.");
    expect(body.message_id).toBe("1");
    expect(body.idempotency_key).toBe(expectedConversationKey("verdict", 8, "bare-pass"));
  });

  it("relays the server acknowledgement verbatim without deriving identity from the GET response", async () => {
    const canonical = "Praxis supplied this acknowledgement from its authoritative issue record.";
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: { ...ISSUE_USER_UAT, repo: undefined, source_issue: undefined },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: { applied: true, state: "done", message: canonical },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("fallback-ref", {
        issue_id: 8,
        verdict: "pass",
      }),
    );

    expect(out.message).toBe(canonical);
  });

  it.each([
    "api_key=super-secret-value",
    "gho_123456789012",
    "github_pat_12345678901234567890",
    "Bearer abcdefghijklmnop12345678",
  ])("surfaces Praxis rejection of a secret-shaped failure summary", async (reason) => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: "invalid_failure_summary" },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("unsafe", {
        issue_id: 8,
        verdict: "fail",
        reason,
      }),
    );
    expect(out).toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_failure_summary",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows a server-rejected failure summary to be corrected for the same inbound message", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: "invalid_failure_summary" },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: true,
            state: "in_progress",
            message:
              "Thanks - I recorded the failed check for cw/app#80: Checkout remains disabled after reload.\n\nPraxis is sending it back for rework. I'll notify you when another version is ready.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });

    const rejected = parse(
      await tools.praxis_submit_verdict.execute("invalid-summary", {
        issue_id: 8,
        verdict: "fail",
        reason: "works as expected",
      }),
    );
    const corrected = parse(
      await tools.praxis_submit_verdict.execute("corrected-summary", {
        issue_id: 8,
        verdict: "fail",
        reason: "Checkout remains disabled after reload.",
      }),
    );

    expect(rejected.error).toBe("invalid_failure_summary");
    expect(corrected.ok).toBe(true);
    const posts = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    const firstBody = JSON.parse((posts[0][1] as RequestInit).body as string);
    const correctedBody = JSON.parse((posts[1][1] as RequestInit).body as string);
    expect(correctedBody.idempotency_key).toBe(firstBody.idempotency_key);
    expect(correctedBody.reason).toBe("Checkout remains disabled after reload.");
  });

  it("surfaces Praxis rejection of a control character in a failure summary", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: "invalid_failure_summary" },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("unsafe-control", {
        issue_id: 8,
        verdict: "fail",
        reason: "screen went blank\u0001after save",
      }),
    );
    expect(out).toMatchObject({
      ok: false,
      status: 400,
      error: "invalid_failure_summary",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not claim a verdict was recorded without applied or idempotent confirmation", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { applied: false, state: "user_uat" } }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("unconfirmed", {
        issue_id: 8,
        verdict: "pass",
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.error).toBe("verdict_not_confirmed");
    expect(out.retryable).toBe(false);
    expect(out.message).toContain("Do not retry");
  });

  it("submits a stage-neutral fail for a user_uat issue", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: true,
            state: "in_progress",
            message:
              "Thanks - I recorded the failed check for cw/app#80: Bearer token refresh still fails after login\n\nPraxis is sending it back for rework. I'll notify you when another version is ready.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c3", {
        issue_id: 8,
        verdict: "fail",
        reason: "Bearer token refresh still fails after login",
      }),
    );
    expect(out.ok).toBe(true);

    const post = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    if (!post) {
      throw new Error("expected a POST call");
    }
    const body = JSON.parse((post[1] as RequestInit).body as string);
    expect(body.kind).toBe("uat_fail");
    expect(out.message).toContain("cw/app#80: Bearer token refresh still fails after login");
    expect(body.channel).toBe("zoom");
    expect(body.channel_user_id).toBe("alice");
    expect(body.message_id).toBe("1");
    expect(body.idempotency_key).toBe(expectedConversationKey("verdict", 8, "c3"));
  });

  it("fails closed when Praxis confirms the verdict but omits canonical acknowledgement copy", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { applied: true, state: "done" } }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("missing-ack", {
        issue_id: 8,
        verdict: "pass",
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.error).toBe("acknowledgement_missing");
    expect(out.mutation_recorded).toBe(true);
    expect(out.retryable).toBe(false);
    expect(out.message).toContain("did not return canonical acknowledgement");
  });

  it("keeps the same idempotency key when an ambiguous dev pass is retried after state advances", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_DEV_UAT }))
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { applied: true, state: "user_uat" } }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_USER_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: false,
            idempotent: true,
            state: "user_uat",
            message:
              "Thanks - I recorded your development pass for cw/app#70. Praxis is moving it to user validation now.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });

    const first = parse(
      await tools.praxis_submit_verdict.execute("tool-first", {
        issue_id: 7,
        verdict: "pass",
      }),
    );
    const retry = parse(
      await tools.praxis_submit_verdict.execute("tool-retry", {
        issue_id: 7,
        verdict: "fail",
        reason: "A regenerated tool call misread the same human message.",
      }),
    );

    expect(first.error).toBe("acknowledgement_missing");
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain("development pass");
    const posts = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    const firstBody = JSON.parse((posts[0][1] as RequestInit).body as string);
    const retryBody = JSON.parse((posts[1][1] as RequestInit).body as string);
    expect(firstBody.kind).toBe("uat_pass");
    expect(firstBody.reason).toBe("Pass verdict submitted without additional rationale.");
    expect(retryBody.kind).toBe("uat_pass");
    expect(retryBody).toEqual(firstBody);
    expect(retryBody.idempotency_key).toBe(firstBody.idempotency_key);
  });

  it("surfaces identity_not_linked with a link instruction", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_DEV_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 403,
          body: { error: "identity_not_linked" },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c4", {
        issue_id: 7,
        verdict: "pass",
        reason: "looks good",
      }),
    );
    expect(out.error).toBe("identity_not_linked");
    expect(out.message).toMatch(/praxis_link_github/);
  });

  it("surfaces 403 unauthorized with a clear message", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: ISSUE_DEV_UAT }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 403,
          body: { reason: "unauthorized" },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c5", {
        issue_id: 7,
        verdict: "pass",
        reason: "looks good",
      }),
    );
    expect(out.error).toBe("unauthorized");
    expect(out.message).toMatch(/reporter or owner/);
  });

  it("denies when no requester identity in runtime context", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: { deliveryContext: { channel: "dev_praxis" } },
    });
    const out = parse(
      await tools.praxis_submit_verdict.execute("c6", {
        issue_id: 7,
        verdict: "pass",
        reason: "ok",
        channel_user_id: "injected-by-model", // should be ignored
      }),
    );
    expect(out.denied).toBe("no_requester_identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("praxis_link_github", () => {
  it("fails policy gate when unconfigured", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(await tools.praxis_link_github.execute("c1", {}));
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies when no requester identity in runtime context", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: { deliveryContext: { channel: "dev_praxis" } },
    });
    const out = parse(await tools.praxis_link_github.execute("c2", {}));
    expect(out.denied).toBe("no_requester_identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts channel=zoom and channel_user_id from trusted context, returns the url", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { url: "https://github.com/login/oauth/authorize?state=xyz" },
      }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_link_github.execute("c3", {}));
    expect(out.ok).toBe(true);
    expect(out.url).toBe("https://github.com/login/oauth/authorize?state=xyz");
    expect(out.message).toContain("https://github.com/login/oauth/authorize?state=xyz");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://praxis:8000/api/v1/identity/link");
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({ channel: "zoom", channel_user_id: "alice" });
  });

  it("surfaces linking_not_configured with a clear message", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 400, body: { error: "linking_not_configured" } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_link_github.execute("c4", {}));
    expect(out.error).toBe("linking_not_configured");
    expect(out.message).toMatch(/not configured/);
  });

  it("surfaces identity_required as a configuration error", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 400, body: { error: "identity_required" } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_link_github.execute("c5", {}));
    expect(out.error).toBe("identity_required");
    expect(out.message).toMatch(/configuration error/);
  });
});

describe("praxis_link_status", () => {
  it("denies when no requester identity in runtime context", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: { deliveryContext: { channel: "dev_praxis" } },
    });
    const out = parse(await tools.praxis_link_status.execute("c1", {}));
    expect(out.denied).toBe("no_requester_identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports linked with the github login, GETting the verified identity", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { linked: true, github_login: "alice-gh" } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_link_status.execute("c2", {}));
    expect(out).toEqual({
      ok: true,
      linked: true,
      github_login: "alice-gh",
      message: "Your Zoom identity is linked to GitHub as alice-gh.",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "http://praxis:8000/api/v1/identity/status?channel=zoom&channel_user_id=alice",
    );
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("reports not linked and points the user at praxis_link_github", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { linked: false, github_login: null } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_link_status.execute("c3", {}));
    expect(out.ok).toBe(true);
    expect(out.linked).toBe(false);
    expect(out.message).toMatch(/praxis_link_github/);
  });
});

describe("praxis_onboard", () => {
  const REPO = "cloudwarriors-ai/foo";

  it("fails closed when the allowlist is unconfigured (no fetch)", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(
      await tools.praxis_onboard.execute("c1", { full_name: REPO, reason: "track it" }),
    );
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_onboard.execute("c1", { full_name: REPO, reason: " " }));
    expect(out).toEqual({ ok: false, error: "reason_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a full_name without owner/name", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_onboard.execute("c1", { full_name: "no-slash", reason: "track it" }),
    );
    expect(out).toEqual({ ok: false, error: "invalid_full_name" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-run previews and makes no HTTP call at all", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_onboard.execute("c1", { full_name: REPO, reason: "track it" }),
    );
    expect(out.preview).toBe(true);
    expect(out.action).toBe("onboard");
    expect(out.repo).toBe(REPO);
    expect(out.backfill).toBe(true);
    expect(typeof out.confirm_token).toBe("string");
    // The onboard token is bound to repo+backfill (no issue GET), so a preview hits nothing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a wrong confirm token re-previews instead of executing", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_onboard.execute("c1", {
        full_name: REPO,
        reason: "track it",
        confirm: "deadbeefdeadbeef",
      }),
    );
    expect(out.preview).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("executes on a valid confirm token, POSTing the onboard request", async () => {
    const result = {
      repo_id: 3,
      full_name: REPO,
      created: true,
      backfilled: [{ source_issue: 1, state: "assessing" }],
      state_counts: { assessing: 1 },
      webhook: {
        required: true,
        url: "",
        events: ["issues", "issue_comment"],
        instructions: "...",
      },
    };
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: result }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const token = mintRepoConfirmToken({ secret: "test-token", fullName: REPO, backfill: true });

    const out = parse(
      await tools.praxis_onboard.execute("c1", {
        full_name: REPO,
        maintainers: ["ann"],
        reason: "track it",
        confirm: token,
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.webhook.required).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v1/repos/onboard");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({
      full_name: REPO,
      maintainers: ["ann"],
      owns_dispatch: false,
      backfill: true,
    });
  });
});

describe("praxis_ingest", () => {
  const REPO = "cloudwarriors-ai/scopely";

  it("fails closed when the allowlist is unconfigured (no fetch)", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: REPO,
        number: 1015,
        reason: "track it",
      }),
    );
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_ingest.execute("c1", { full_name: REPO, number: 1015, reason: " " }),
    );
    expect(out).toEqual({ ok: false, error: "reason_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a full_name without owner/name", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: "no-slash",
        number: 1015,
        reason: "track it",
      }),
    );
    expect(out).toEqual({ ok: false, error: "invalid_full_name" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-positive / non-integer issue number", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const zero = parse(
      await tools.praxis_ingest.execute("c1", { full_name: REPO, number: 0, reason: "track it" }),
    );
    expect(zero).toEqual({ ok: false, error: "invalid_issue_number" });
    const nan = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: REPO,
        number: "abc",
        reason: "track it",
      }),
    );
    expect(nan).toEqual({ ok: false, error: "invalid_issue_number" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-run previews and makes no HTTP call at all", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: REPO,
        number: 1015,
        reason: "track it",
      }),
    );
    expect(out.preview).toBe(true);
    expect(out.action).toBe("ingest");
    expect(out.repo).toBe(REPO);
    expect(out.number).toBe(1015);
    expect(typeof out.confirm_token).toBe("string");
    // The ingest token is bound to repo+number (no issue GET), so a preview hits nothing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a wrong confirm token re-previews instead of executing", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: REPO,
        number: 1015,
        reason: "track it",
        confirm: "deadbeefdeadbeef",
      }),
    );
    expect(out.preview).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("executes on a valid confirm token, POSTing the ingest request with audit context", async () => {
    const result = {
      ingested: true,
      full_name: REPO,
      source_issue: 1015,
      state: "assessing",
      already_tracked: false,
    };
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: result }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const token = mintIngestConfirmToken({ secret: "test-token", fullName: REPO, number: 1015 });

    const out = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: REPO,
        number: 1015,
        reason: "reporter says it isn't tracked",
        confirm: token,
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.source_issue).toBe(1015);
    expect(out.state).toBe("assessing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v1/issues/ingest");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({
      full_name: REPO,
      number: 1015,
      requested_by: "alice",
      channel: "dev_praxis",
      message_id: "1",
      idempotency_key: "ingest:cloudwarriors-ai/scopely:1015",
    });
  });

  it("surfaces repo_not_onboarded with a pointer to praxis_onboard", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 404, body: { error: "repo_not_onboarded" } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const token = mintIngestConfirmToken({ secret: "test-token", fullName: REPO, number: 1015 });
    const out = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: REPO,
        number: 1015,
        reason: "track it",
        confirm: token,
      }),
    );
    expect(out.error).toBe("repo_not_onboarded");
    expect(out.message).toMatch(/praxis_onboard/);
  });

  it("surfaces issue_not_open when GitHub says the issue is closed/missing", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 409, body: { error: "issue_not_open" } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const token = mintIngestConfirmToken({ secret: "test-token", fullName: REPO, number: 1015 });
    const out = parse(
      await tools.praxis_ingest.execute("c1", {
        full_name: REPO,
        number: 1015,
        reason: "track it",
        confirm: token,
      }),
    );
    expect(out.error).toBe("issue_not_open");
    expect(out.message).toMatch(/not open/);
  });
});

describe("praxis_file_issue", () => {
  const PRAXIS_REPO = "cloudwarriors-ai/praxis";

  it("fails closed when the allowlist is unconfigured (no fetch)", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(
      await tools.praxis_file_issue.execute("c1", { title: "fix it", reason: "self-improve" }),
    );
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a reason and a title", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const noReason = parse(
      await tools.praxis_file_issue.execute("c1", { title: "fix it", reason: " " }),
    );
    expect(noReason).toEqual({ ok: false, error: "reason_required" });
    const noTitle = parse(
      await tools.praxis_file_issue.execute("c1", { title: "  ", reason: "self-improve" }),
    );
    expect(noTitle).toEqual({ ok: false, error: "title_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-run previews with the Praxis repo as the default target and makes no HTTP call", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_file_issue.execute("c1", {
        title: "Fix flaky outbox retry",
        reason: "self-improve",
      }),
    );
    expect(out.preview).toBe(true);
    expect(out.action).toBe("file_issue");
    expect(out.repo).toBe(PRAXIS_REPO);
    expect(out.title).toBe("Fix flaky outbox retry");
    expect(typeof out.confirm_token).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a wrong confirm token re-previews instead of filing", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_file_issue.execute("c1", {
        title: "t",
        reason: "self-improve",
        confirm: "deadbeefdeadbeef",
      }),
    );
    expect(out.preview).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("executes on a valid token, POSTing to the Praxis repo with no labels key (server default)", async () => {
    const result = {
      filed: true,
      full_name: PRAXIS_REPO,
      number: 101,
      url: `https://github.com/${PRAXIS_REPO}/issues/101`,
      labels: ["praxis:self-improvement"],
    };
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: result }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const token = mintFileIssueConfirmToken({
      secret: "test-token",
      fullName: PRAXIS_REPO,
      title: "Improve reconciler logging",
    });

    const out = parse(
      await tools.praxis_file_issue.execute("c1", {
        title: "Improve reconciler logging",
        body: "add context to the retry log line",
        reason: "self-improve",
        confirm: token,
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.number).toBe(101);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v1/issues/file");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({
      full_name: PRAXIS_REPO,
      title: "Improve reconciler logging",
      body: "add context to the retry log line",
      requested_by: "alice",
      channel: "dev_praxis",
      message_id: "1",
      idempotency_key: `file-issue:${PRAXIS_REPO}:Improve reconciler logging`,
    });
    expect(sent.labels).toBeUndefined(); // omitted so the server applies its default marker
  });

  it("honors an explicit repo + labels", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: true, status: 200, body: { filed: true, number: 5 } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const token = mintFileIssueConfirmToken({
      secret: "test-token",
      fullName: "cw/other",
      title: "t",
    });
    await tools.praxis_file_issue.execute("c1", {
      title: "t",
      repo: "cw/other",
      labels: ["enhancement"],
      reason: "self-improve",
      confirm: token,
    });
    const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(sent.full_name).toBe("cw/other");
    expect(sent.labels).toEqual(["enhancement"]);
  });
});

describe("praxis_self_heal", () => {
  const REPO = "cloudwarriors-ai/foo";

  it("fails closed when the allowlist is unconfigured (no fetch)", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(await tools.praxis_self_heal.execute("c1", { reason: "scan" }));
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_self_heal.execute("c1", { reason: " " }));
    expect(out).toEqual({ ok: false, error: "reason_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown mode", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_self_heal.execute("c1", { mode: "explode", reason: "scan" }),
    );
    expect(out).toEqual({ ok: false, error: "invalid_mode" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dry-run previews and makes no HTTP call at all", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_self_heal.execute("c1", { repo: REPO, reason: "scan" }));
    expect(out.preview).toBe(true);
    expect(out.action).toBe("self_heal");
    expect(out.repo).toBe(REPO);
    expect(out.mode).toBe("create-issues");
    expect(typeof out.confirm_token).toBe("string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("executes on a valid confirm token, POSTing the self-heal run", async () => {
    const result = {
      mode: "create-issues",
      target_repo: REPO,
      findings_detected: 2,
      issues_created: 1,
      issues_updated: 1,
      errors: [],
    };
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: result }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const token = mintSelfHealConfirmToken({
      secret: "test-token",
      repo: REPO,
      mode: "create-issues",
    });

    const out = parse(
      await tools.praxis_self_heal.execute("c1", {
        repo: REPO,
        mode: "create-issues",
        since_minutes: 90,
        note: "Reporter flagged this after the deploy.",
        reason: "scan",
        confirm: token,
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.issues_created).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v1/self-heal/run");
    expect(init?.method).toBe("POST");
    const sent = JSON.parse(init?.body as string);
    expect(sent).toEqual({
      repo: REPO,
      mode: "create-issues",
      since_minutes: 90,
      notify: false,
      note: "Reporter flagged this after the deploy.",
    });
  });
});

describe("praxis_provide_info", () => {
  it("fails policy gate when unconfigured", async () => {
    const { tools } = buildTools({ pluginConfig: undefined });
    const out = parse(
      await tools.praxis_provide_info.execute("c1", { issue_id: 7, answer: "the login page" }),
    );
    expect(out).toEqual({ ok: false, denied: "write_policy_unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty answer before any fetch", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("c1", { issue_id: 7, answer: "   " }),
    );
    expect(out).toEqual({ ok: false, error: "answer_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before mutation when the server does not advertise the acknowledgement contract", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: { ...ISSUE, id: 7, contracts: undefined },
      }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("contract-gate", {
        issue_id: 7,
        answer: "the checkout page",
      }),
    );

    expect(out.denied).toBe("server_contract_unconfirmed");
    expect(out.message).toContain("Upgrade Praxis");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before mutation when the transport omits a trusted inbound message id", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: {
        requesterSenderId: "alice",
        deliveryContext: { channel: "dev_praxis", threadId: 1 },
        sessionId: "s1",
      },
    });
    const out = parse(
      await tools.praxis_provide_info.execute("missing-message-id", {
        issue_id: 7,
        answer: "the checkout page",
      }),
    );

    expect(out.denied).toBe("inbound_message_id_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts info with trusted Zoom identity and inbound-message idempotency", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7, source_issue: 70 } }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: true,
            state: "assessing",
            message: "Thanks - I recorded that information. Praxis is reassessing cw/app#70 now.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("call-42", {
        issue_id: 7,
        answer: "the checkout page, POST /api/cart",
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.message).toBe(
      "Thanks - I recorded that information. Praxis is reassessing cw/app#70 now.",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("http://praxis:8000/api/v1/issues/7/events");
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({
      kind: "info_provided",
      reason: "the checkout page, POST /api/cart",
      requested_by: "alice",
      channel: "zoom",
      channel_user_id: "alice",
      message_id: "1",
      idempotency_key: expectedConversationKey("info", 7, "call-42"),
    });
  });

  it("resolves an owner/repo#N ref to the praxis id via the issues list", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            issues: [
              { id: 182, source_issue: 65 },
              { id: 9, source_issue: 2 },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 182 } }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: true,
            state: "assessing",
            message:
              "Thanks - I recorded that information. Praxis is reassessing cloudwarriors-ai/praxis-e2e-sandbox#65 now.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("call-7", {
        issue: "cloudwarriors-ai/praxis-e2e-sandbox#65",
        answer: "no console errors",
      }),
    );
    expect(out.ok).toBe(true);

    const [lookupUrl] = fetchMock.mock.calls[0];
    expect(lookupUrl).toBe(
      "http://praxis:8000/api/v1/issues?repo=cloudwarriors-ai%2Fpraxis-e2e-sandbox",
    );
    const [capabilityUrl] = fetchMock.mock.calls[1];
    expect(capabilityUrl).toBe("http://praxis:8000/api/v1/issues/182");
    const [postUrl, postInit] = fetchMock.mock.calls[2];
    expect(postUrl).toBe("http://praxis:8000/api/v1/issues/182/events");
    const sent = JSON.parse((postInit as RequestInit).body as string);
    expect(sent.kind).toBe("info_provided");
    expect(sent.channel_user_id).toBe("alice");
    expect(out.message).toBe(
      "Thanks - I recorded that information. Praxis is reassessing cloudwarriors-ai/praxis-e2e-sandbox#65 now.",
    );
  });

  it("does not mislabel an issue-id write with a conflicting model-supplied ref", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7, source_issue: 70 } }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: true,
            state: "assessing",
            message: "Thanks - I recorded that information. Praxis is reassessing cw/app#70 now.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("call-8", {
        issue_id: 7,
        issue: "cw/wrong#999",
        answer: "the checkout page",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("http://praxis:8000/api/v1/issues/7");
    expect(fetchMock.mock.calls[1][0]).toBe("http://praxis:8000/api/v1/issues/7/events");
    expect(out.message).toBe(
      "Thanks - I recorded that information. Praxis is reassessing cw/app#70 now.",
    );
  });

  it("does not claim an answer was recorded without applied or idempotent confirmation", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7 } }))
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { applied: false, state: "needs_info" } }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("unconfirmed", {
        issue_id: 7,
        answer: "the checkout page",
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.error).toBe("answer_not_confirmed");
    expect(out.retryable).toBe(false);
    expect(out.message).toContain("Do not retry");
  });

  it("fails closed when Praxis confirms the answer but omits canonical acknowledgement copy", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7 } }))
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { applied: true, state: "assessing" } }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("missing-info-ack", {
        issue_id: 7,
        answer: "the checkout page",
      }),
    );

    expect(out.ok).toBe(false);
    expect(out.error).toBe("acknowledgement_missing");
    expect(out.mutation_recorded).toBe(true);
    expect(out.retryable).toBe(false);
    expect(out.message).toContain("did not return canonical acknowledgement");
  });

  it("reuses the first answer payload when the same inbound message is retried differently", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7 } }))
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, body: { applied: false, state: "needs_info" } }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7 } }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            applied: false,
            idempotent: true,
            state: "assessing",
            message: "Thanks - I recorded that information. Praxis is reassessing cw/app#70 now.",
          },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });

    const first = parse(
      await tools.praxis_provide_info.execute("info-first", {
        issue_id: 7,
        answer: "Checkout fails after selecting annual billing.",
      }),
    );
    const retry = parse(
      await tools.praxis_provide_info.execute("info-retry", {
        issue_id: 7,
        answer: "A regenerated tool call paraphrased the human differently.",
      }),
    );

    expect(first.error).toBe("answer_not_confirmed");
    expect(retry.ok).toBe(true);
    const posts = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    const firstBody = JSON.parse((posts[0][1] as RequestInit).body as string);
    const retryBody = JSON.parse((posts[1][1] as RequestInit).body as string);
    expect(retryBody).toEqual(firstBody);
    expect(firstBody.reason).toBe("Checkout fails after selecting annual billing.");
  });

  it("returns issue_not_tracked when the ref resolves to nothing", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { issues: [] } }));
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("call-8", {
        issue: "cw/app#404",
        answer: "no console errors",
      }),
    );
    expect(out.error).toBe("issue_not_tracked");
    expect(out.message).toContain("cw/app#404");
  });

  it("preserves the structured 404 body for a stale numeric issue id", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({ ok: false, status: 404, body: { detail: "Not found." } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("stale-id", {
        issue_id: 999999,
        answer: "the checkout page",
      }),
    );

    expect(out).toEqual({
      ok: false,
      status: 404,
      detail: "Not found.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://praxis:8000/api/v1/issues/999999");
  });

  it("surfaces identity_not_linked with the link instruction", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7 } }))
      .mockResolvedValueOnce(
        mockResponse({ ok: false, status: 403, body: { error: "identity_not_linked" } }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("c3", { issue_id: 7, answer: "the login page" }),
    );
    expect(out.error).toBe("identity_not_linked");
    expect(out.message).toContain("praxis_link_github");
  });

  it("surfaces issue_not_awaiting_info with the issue state", async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: { ...ISSUE, id: 7 } }))
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 409,
          body: { error: "issue_not_awaiting_info", state: "in_progress" },
        }),
      );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(
      await tools.praxis_provide_info.execute("c4", { issue_id: 7, answer: "the login page" }),
    );
    expect(out.error).toBe("issue_not_awaiting_info");
    expect(out.state).toBe("in_progress");
    expect(out.message).toContain("in_progress");
  });
});

describe("praxis_my_issues", () => {
  it("denies when no requester identity in runtime context", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: { deliveryContext: { channel: "dev_praxis" } },
    });
    const out = parse(await tools.praxis_my_issues.execute("m1", {}));
    expect(out.denied).toBe("no_requester_identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GETs the identity-scoped my-issues endpoint with the verified runtime identity", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: {
          github_login: "alice-gh",
          issues: [
            {
              issue_id: 41,
              ref: "cw/app#10",
              state: "needs_info",
              needs_user_action: true,
              open_question_field: "repro_steps",
            },
          ],
        },
      }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_my_issues.execute("m2", {}));
    expect(out.ok).toBe(true);
    expect(out.github_login).toBe("alice-gh");
    expect(out.issues[0].issue_id).toBe(41);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://praxis:8000/api/v1/my/issues?channel=zoom&channel_user_id=alice");
    expect((init as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("surfaces identity_not_linked with a praxis_link_github hint", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 403, body: { error: "identity_not_linked" } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_my_issues.execute("m3", {}));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("identity_not_linked");
    expect(out.hint).toMatch(/praxis_link_github/);
  });

  it("is blocked by the allowlist gate before any fetch", async () => {
    const { tools } = buildTools({
      pluginConfig: { allowedUsers: ["someone-else"], allowedChannels: ["dev_praxis"] },
    });
    const out = parse(await tools.praxis_my_issues.execute("m4", {}));
    expect(out.denied).toBe("requester_not_allowlisted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("praxis_my_issue", () => {
  it("requires a positive integer issue_id", async () => {
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_my_issue.execute("d1", {}));
    expect(out.error).toBe("issue_id_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("GETs the identity-scoped drill-down and returns the issue", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { github_login: "alice-gh", issue: { issue_id: 41, state: "needs_info" } },
      }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_my_issue.execute("d2", { issue_id: 41 }));
    expect(out.ok).toBe(true);
    expect(out.issue.issue_id).toBe(41);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://praxis:8000/api/v1/my/issues/41?channel=zoom&channel_user_id=alice");
  });

  it("passes through the scoped 404 (cross-user / nonexistent look identical)", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({ ok: false, status: 404, body: { error: "not_found" } }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_my_issue.execute("d3", { issue_id: 999 }));
    expect(out.ok).toBe(false);
    expect(out.status).toBe(404);
    expect(out.error).toBe("not_found");
  });
});

describe("praxis_opt_in / praxis_opt_out", () => {
  it("denies opt_in when no requester identity in runtime context", async () => {
    const { tools } = buildTools({
      pluginConfig: ALLOW_ALICE,
      toolContext: { deliveryContext: { channel: "dev_praxis" } },
    });
    const out = parse(await tools.praxis_opt_in.execute("o1", {}));
    expect(out.denied).toBe("no_requester_identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opt_in POSTs the consent endpoint with the verified runtime identity", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { github_login: "alice-gh", channel: "zoom", consented: true },
      }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_opt_in.execute("o2", {}));
    expect(out.ok).toBe(true);
    expect(out.consented).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://praxis:8000/api/v1/my/consent");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      channel: "zoom",
      channel_user_id: "alice",
    });
  });

  it("opt_out DELETEs the consent endpoint", async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        body: { github_login: "alice-gh", channel: "zoom", consented: false, was_active: true },
      }),
    );
    const { tools } = buildTools({ pluginConfig: ALLOW_ALICE });
    const out = parse(await tools.praxis_opt_out.execute("o3", {}));
    expect(out.ok).toBe(true);
    expect(out.consented).toBe(false);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("is blocked by the allowlist gate before any fetch", async () => {
    const { tools } = buildTools({
      pluginConfig: { allowedUsers: ["someone-else"], allowedChannels: ["dev_praxis"] },
    });
    const out = parse(await tools.praxis_opt_in.execute("o4", {}));
    expect(out.denied).toBe("requester_not_allowlisted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
