// Supervisor tests (supervisor.ts — Slice S v1 + Slice S2 v2). Cover: opt-in
// gating (base + v2 flags), coordinator/spoke session scoping, each
// deterministic check, the EVIDENCE MODEL (internal-completion-event user
// messages count as grounding — the prod-verified delivery shape), the
// ungrounded_claim token grounding with its false-positive exclusions, the
// harness-budgeted revise shape, the fuse (trip → accept + escalation post +
// cooldown; spoke fuse keyed per spoke id across spawn UUIDs), and the
// confirm-gate boundary (the supervisor blocks code relays; never executes).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendScopelyTextMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
  getChannelThreadAnchor: () => undefined,
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
}));

import {
  collectTurnEvidence,
  extractHardTokens,
  findUngroundedTokens,
  resetSupervisorStateForTest,
  reviewDraft,
  superviseFinalize,
  turnHadToolActivity,
  type TurnEvidence,
} from "./supervisor.js";

const SESSION = "agent:scopelybot:zoom:channel:vipbot@conference.xmpp.zoom.us";
const SPOKE_SESSION = "agent:scopely-observe:subagent:8f69d509-1f68-4bc2-8712-9be897d97ff9";
const CHANNEL = "vipbot@conference.xmpp.zoom.us";
const auditMock = vi.fn();

// Evidence helper for direct reviewDraft calls.
function ev(overrides?: Partial<TurnEvidence>): TurnEvidence {
  return { hadEvidence: true, corpus: "", humanText: "", ...overrides };
}
const NO_EVIDENCE = ev({ hadEvidence: false });

// A turn with one grounded tool read (user → toolResult → assistant).
const GROUNDED_TURN = [
  { role: "user", content: "how many sessions?" },
  { role: "assistant", content: [{ type: "toolCall" }] },
  { role: "toolResult", content: "42" },
];

// The prod-verified coordinator shape for a ROUTED turn: the spoke packet
// arrives as a USER-role internal completion event, not a toolResult
// (transcript-verified 2026-07-21). The spawn/yield toolResults carry no
// domain data.
const ROUTED_TURN = [
  { role: "user", content: "how many sessions are in the system?" },
  { role: "assistant", content: [{ type: "toolCall" }] },
  {
    role: "toolResult",
    content: '{"status":"accepted","childSessionKey":"agent:scopely-observe:subagent:x"}',
  },
  { role: "assistant", content: [{ type: "toolCall" }] },
  { role: "toolResult", content: '{"status":"yielded","message":"Waiting for child"}' },
  {
    role: "user",
    content:
      "[Internal task completion event]\nsource: subagent\nstatus: ok\n\n" +
      "Child result: answer: 713 total sessions, 391 in_progress; evidence: session_status_counts",
  },
];

function event(draft: string, overrides?: Record<string, unknown>) {
  return {
    runId: "run-1",
    turnId: "turn-1",
    sessionKey: SESSION,
    lastAssistantMessage: draft,
    messages: GROUNDED_TURN,
    ...overrides,
  };
}

beforeEach(() => {
  resetSupervisorStateForTest();
  sendScopelyTextMock.mockClear();
  auditMock.mockClear();
  process.env.SCOPELYBOT_SUPERVISOR = "1";
  process.env.SCOPELYBOT_ZOOM_CHANNEL = CHANNEL;
});
afterEach(() => {
  delete process.env.SCOPELYBOT_SUPERVISOR;
  delete process.env.SCOPELYBOT_SUPERVISOR_V2;
  delete process.env.SCOPELYBOT_SUPERVISOR_VOICE;
  delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
  delete process.env.SCOPELYBOT_SUPERVISOR_FUSE_N;
  delete process.env.SCOPELYBOT_ESCALATION_OWNER;
});

describe("gating", () => {
  it("returns undefined when SCOPELYBOT_SUPERVISOR is not 1", async () => {
    delete process.env.SCOPELYBOT_SUPERVISOR;
    const res = await superviseFinalize(event("CONFIRM 1234"), { logger: auditMock });
    expect(res).toBeUndefined();
  });

  it("ignores sessions that are neither coordinator nor scopely spokes", async () => {
    const res = await superviseFinalize(
      event("CONFIRM 1234", { sessionKey: "agent:pulsebot:zoom:channel:x" }),
      { logger: auditMock },
    );
    expect(res).toBeUndefined();
  });

  it("ignores spoke sessions unless SCOPELYBOT_SUPERVISOR_V2=1 (already-on base flag must not widen)", async () => {
    const res = await superviseFinalize(event("CONFIRM 1234", { sessionKey: SPOKE_SESSION }), {
      logger: auditMock,
    });
    expect(res).toBeUndefined();
    process.env.SCOPELYBOT_SUPERVISOR_V2 = "1";
    const res2 = await superviseFinalize(event("CONFIRM 1234", { sessionKey: SPOKE_SESSION }), {
      logger: auditMock,
    });
    expect(res2).toMatchObject({ action: "revise" });
  });

  it("lets a clean grounded draft through with no opinion", async () => {
    const res = await superviseFinalize(event("There are 42 active sessions."), {
      logger: auditMock,
    });
    expect(res).toBeUndefined();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("reviewDraft checks", () => {
  it("blocks CONFIRM code relays (confirm-gate boundary)", () => {
    const v = reviewDraft("Reply CONFIRM 4821 to proceed.", ev());
    expect(v).toMatchObject({ ok: false, checkId: "confirm_code_leak" });
  });

  it("blocks secret-shaped values", () => {
    const jwt = `token: eyJ${"a".repeat(24)}.${"b".repeat(16)}`;
    expect(reviewDraft(jwt, ev())).toMatchObject({ ok: false, checkId: "secret_leak" });
    expect(reviewDraft("The password is hunter22.", ev())).toMatchObject({
      ok: false,
      checkId: "secret_leak",
    });
  });

  it("does not flag reset-flow explanations that mention passwords", () => {
    expect(
      reviewDraft("A password reset email was sent to the user; they set their own.", ev()),
    ).toEqual({ ok: true });
  });

  it("blocks raw JSON dumps on the coordinator only — spoke packets are structured by contract", () => {
    const dump = JSON.stringify({ results: Array.from({ length: 30 }, (_, i) => ({ id: i })) });
    expect(reviewDraft(dump, ev())).toMatchObject({ ok: false, checkId: "raw_json_dump" });
    expect(reviewDraft(dump, ev({ corpus: dump }), "spoke")).toEqual({ ok: true });
  });

  it("blocks state assertions made with zero evidence this turn", () => {
    const v = reviewDraft("Org 314 has 1250 sessions and owes $4,200.", NO_EVIDENCE);
    expect(v).toMatchObject({ ok: false, checkId: "unsupported_state_claim" });
  });

  it("allows the same state assertion when the turn had evidence containing the values", () => {
    expect(
      reviewDraft(
        "Org 314 has 1250 sessions and owes $4,200.",
        ev({ corpus: "org 314 sessions=1250 balance=4200" }),
      ),
    ).toEqual({ ok: true });
  });

  it("allows a short clarifying question even with no evidence", () => {
    expect(reviewDraft("Do you mean session 314?", NO_EVIDENCE)).toEqual({ ok: true });
  });
});

describe("evidence model (prod-verified delivery shape)", () => {
  it("internal completion events count as evidence and do not reset the turn", () => {
    const evidence = collectTurnEvidence(ROUTED_TURN);
    expect(evidence.hadEvidence).toBe(true);
    expect(evidence.corpus).toContain("713 total sessions");
    expect(evidence.humanText).toContain("how many sessions");
    expect(turnHadToolActivity(ROUTED_TURN)).toBe(true);
  });

  it("REGRESSION (audit F1-F3): a numeric coordinator answer grounded only by a spoke packet fires NOTHING", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_V2 = "1";
    const res = await superviseFinalize(
      event("There are 713 sessions total; 391 are in progress.", { messages: ROUTED_TURN }),
      { logger: auditMock },
    );
    expect(res).toBeUndefined();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("v2 walk is strictly narrowing vs v1: internal-event reset no longer strands grounded turns", () => {
    // Under the v1 walk, the internal-event user message reset the turn and
    // left zero toolResults → unsupported_state_claim fired. v2: evidence.
    const evidence = collectTurnEvidence(ROUTED_TURN);
    expect(reviewDraft("There are 713 sessions total; 391 are in progress.", evidence)).toEqual({
      ok: true,
    });
  });

  it("a fresh HUMAN message still resets accumulated evidence", () => {
    const messages = [
      ...ROUTED_TURN,
      { role: "assistant", content: [{ type: "text", text: "713 total." }] },
      { role: "user", content: "and how many orgs?" },
    ];
    const evidence = collectTurnEvidence(messages);
    expect(evidence.hadEvidence).toBe(false);
    expect(evidence.humanText).toContain("how many orgs");
  });
});

describe("ungrounded_claim (v2)", () => {
  beforeEach(() => {
    process.env.SCOPELYBOT_SUPERVISOR_V2 = "1";
  });

  it("extracts emails, explicit ids, big numbers; skips years and ISO timestamps", () => {
    const tokens = extractHardTokens(
      "User jrickert@unified-team.com (id 50) has 1,250 sessions since 2024; " +
        "last login 2026-07-21T02:10:01Z; total $4,200.50.",
    );
    expect(tokens).toContain("jrickert@unified-team.com");
    expect(tokens).toContain("50");
    expect(tokens).toContain("1250");
    expect(tokens).toContain("4200.50");
    expect(tokens).not.toContain("2024"); // plausible year
    expect(tokens).not.toContain("2026"); // inside stripped ISO timestamp
  });

  it("flags a spoke draft whose value is absent from tool output, naming the value", () => {
    const v = reviewDraft(
      "There are 999 sessions in the system.",
      ev({ corpus: '{"total": 713, "in_progress": 391}' }),
      "spoke",
    );
    expect(v).toMatchObject({ ok: false, checkId: "ungrounded_claim" });
    expect((v as { reason: string }).reason).toContain("999");
    expect((v as { instruction: string }).instruction).toContain("Re-run");
  });

  it("passes the spoke false-positive corpus: dates, years, HTTP codes, currency variants", () => {
    const corpus =
      '{"status": 404, "port": 8000, "amount": "149", "count": 713, "updated": 1784599813}';
    const draft =
      "The endpoint returned HTTP 404 on port 8000; 713 records; balance $149.00; " +
      "checked 2026-07-21 (data from 2025).";
    expect(reviewDraft(draft, ev({ corpus }), "spoke")).toEqual({ ok: true });
  });

  it("accepts separator variants: draft 1,250 grounds against corpus 1250", () => {
    expect(
      reviewDraft("There are 1,250 sessions.", ev({ corpus: '{"total":1250}' }), "spoke"),
    ).toEqual({ ok: true });
  });

  it("user-supplied values are echoable without evidence-corpus support", () => {
    expect(
      findUngroundedTokens(
        "Session 713 was archived.",
        ev({
          corpus: '{"status":"ok"}',
          humanText: "please archive session 713",
        }),
      ),
    ).toEqual([]);
  });

  it("stays silent when SCOPELYBOT_SUPERVISOR_V2 is unset (byte-identical rollout gate)", async () => {
    delete process.env.SCOPELYBOT_SUPERVISOR_V2;
    const res = await superviseFinalize(
      event("There are 999 sessions.", {
        messages: [
          { role: "user", content: "how many?" },
          { role: "toolResult", content: '{"total": 713}' },
        ],
      }),
      { logger: auditMock },
    );
    expect(res).toBeUndefined();
  });

  it("coordinator instruction directs a spoke re-dispatch, not a direct tool read", () => {
    const v = reviewDraft(
      "There are 999 sessions.",
      ev({ corpus: "Child result: 713 total" }),
      "coordinator",
    );
    expect(v).toMatchObject({ ok: false, checkId: "ungrounded_claim" });
    expect((v as { instruction: string }).instruction).toContain("dispatch");
  });
});

describe("revise shape", () => {
  it("carries the actionable instruction in `reason` — the only field the harness feeds back", async () => {
    const res = await superviseFinalize(event("Reply CONFIRM 4821 to proceed."), {
      logger: auditMock,
    });
    expect(res).toMatchObject({
      action: "revise",
      // SUBSTRATE PIN: run.ts builds the retry prompt from `reason` alone
      // (buildBeforeAgentFinalizeRetryPrompt); retry.{instruction,
      // idempotencyKey,maxAttempts} are typed but unconsumed by the harness.
      // The crafted instruction must therefore BE the reason.
      reason: expect.stringContaining("Never include, repeat, or invent CONFIRM codes"),
      retry: {
        idempotencyKey: "scopelybot-supervisor:turn-1:confirm_code_leak",
        maxAttempts: 1,
      },
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "scopely_supervisor",
        resultSummary: "revise: confirm_code_leak",
      }),
    );
  });
});

describe("voice lane (v2.1)", () => {
  // Long enough to clear voice-judge skip predicates; grounded against
  // GROUNDED_TURN's corpus ("42") so the deterministic plane stays clean.
  const CLEAN_DRAFT =
    "There are 42 active sessions right now. Everything else in the pipeline looks healthy " +
    "and no approvals are waiting on you.";

  beforeEach(() => {
    process.env.SCOPELYBOT_SUPERVISOR_VOICE = "1";
  });

  it("is inert without llmComplete wired (flag alone cannot activate it)", async () => {
    const res = await superviseFinalize(event(CLEAN_DRAFT), { logger: auditMock });
    expect(res).toBeUndefined();
  });

  it("judges only drafts the deterministic plane already passed", async () => {
    const llmComplete = vi.fn().mockResolvedValue({ text: "PASS" });
    const res = await superviseFinalize(event("Reply CONFIRM 4821 to proceed."), {
      logger: auditMock,
      llmComplete,
    });
    expect(res).toMatchObject({ action: "revise" }); // deterministic finding wins
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it("never judges spoke drafts — coordinator (human-facing) only", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_V2 = "1";
    const llmComplete = vi.fn().mockResolvedValue({ text: "PASS" });
    const res = await superviseFinalize(event(CLEAN_DRAFT, { sessionKey: SPOKE_SESSION }), {
      logger: auditMock,
      llmComplete,
    });
    expect(res).toBeUndefined();
    expect(llmComplete).not.toHaveBeenCalled();
  });

  it("voice REVISE → framed instruction rides `reason`, audits", async () => {
    const llmComplete = vi
      .fn()
      .mockResolvedValue({ text: "REVISE: Lead with the answer and drop the filler." });
    const res = await superviseFinalize(event(CLEAN_DRAFT), { logger: auditMock, llmComplete });
    expect(res).toMatchObject({ action: "revise" });
    const reason = (res as { reason: string }).reason;
    expect(reason).toContain("keeping every fact, number, name, and value exactly the same");
    expect(reason).toContain("Lead with the answer");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "scopely_supervisor", resultSummary: "revise: voice" }),
    );
  });

  it("caps voice per run AND per sessionKey cooldown — one turn can span multiple announce runs", async () => {
    let t = 2_000_000;
    const llmComplete = vi.fn().mockResolvedValue({ text: "REVISE: Tighten the phrasing." });
    const deps = { logger: auditMock, now: () => t, llmComplete };
    const first = await superviseFinalize(event(CLEAN_DRAFT), deps);
    expect(first).toMatchObject({ action: "revise" });
    // Second finalize pass in the SAME run (the revised draft): judge not consulted.
    const second = await superviseFinalize(event(CLEAN_DRAFT), deps);
    expect(second).toBeUndefined();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    // A DIFFERENT run inside the cooldown window (the 2026-07-21 S23 shape:
    // the turn re-routed and the second spoke completion opened a fresh
    // announce runId) — judge still not consulted.
    t += 30_000;
    const third = await superviseFinalize(event(CLEAN_DRAFT, { runId: "run-2" }), deps);
    expect(third).toBeUndefined();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    // After the cooldown lapses (default 180s) a new run judges again.
    t += 180_000;
    const fourth = await superviseFinalize(event(CLEAN_DRAFT, { runId: "run-3" }), deps);
    expect(fourth).toMatchObject({ action: "revise" });
    expect(llmComplete).toHaveBeenCalledTimes(2);
  });

  it("voice revisions do NOT charge the shared correctness fuse", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_FUSE_N = "2";
    let t = 2_000_000;
    const deps = {
      logger: auditMock,
      now: () => t,
      llmComplete: vi.fn().mockResolvedValue({ text: "REVISE: Tighten the phrasing." }),
    };
    // Revision 1: voice — self-capped, must not count toward the fuse.
    expect(await superviseFinalize(event(CLEAN_DRAFT), deps)).toMatchObject({ action: "revise" });
    // Revision 2: deterministic (run-2) — FIRST fuse hit, threshold 2 not
    // reached (voice didn't count), so this is a normal revise.
    t += 1000;
    expect(
      await superviseFinalize(event("Reply CONFIRM 4821 to proceed.", { runId: "run-2" }), deps),
    ).toMatchObject({ action: "revise" });
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
    // Revision 3: deterministic (run-3) — second fuse hit trips it, and the
    // escalation correctly reflects VERIFICATION failures only.
    t += 1000;
    expect(
      await superviseFinalize(event("Reply CONFIRM 9999 to proceed.", { runId: "run-3" }), deps),
    ).toEqual({ action: "continue" });
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(1);
  });

  it("judge fail-open (error/malformed) leaves the draft untouched", async () => {
    const llmComplete = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await superviseFinalize(event(CLEAN_DRAFT), { logger: auditMock, llmComplete });
    expect(res).toBeUndefined();
  });

  it("stays fully inert when SCOPELYBOT_SUPERVISOR_VOICE is unset (rollout gate)", async () => {
    delete process.env.SCOPELYBOT_SUPERVISOR_VOICE;
    const llmComplete = vi.fn().mockResolvedValue({ text: "REVISE: anything" });
    const res = await superviseFinalize(event(CLEAN_DRAFT), { logger: auditMock, llmComplete });
    expect(res).toBeUndefined();
    expect(llmComplete).not.toHaveBeenCalled();
  });
});

describe("fuse", () => {
  it("trips after N revisions: accepts the draft, posts escalation, then cools down", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_FUSE_N = "2";
    process.env.SCOPELYBOT_ESCALATION_OWNER = "John Rudolph";
    const bad = () => event("Reply CONFIRM 4821 to proceed.");
    let t = 1_000_000;
    const deps = { logger: auditMock, now: () => t };

    // Revision 1: normal revise.
    expect(await superviseFinalize(bad(), deps)).toMatchObject({ action: "revise" });
    // Revision 2: fuse trips — draft accepted, escalation posted naming the owner.
    t += 1000;
    expect(await superviseFinalize(bad(), deps)).toEqual({ action: "continue" });
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(1);
    expect(String(sendScopelyTextMock.mock.calls[0][1])).toContain("John Rudolph");
    expect(auditMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ resultSummary: "fuse_tripped after confirm_code_leak" }),
    );
    // Cooldown: pass-through, no further checks, no extra escalation.
    t += 1000;
    expect(await superviseFinalize(bad(), deps)).toEqual({ action: "continue" });
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(1);
    // After cooldown expires the checks are live again.
    t += 11 * 60_000;
    expect(await superviseFinalize(bad(), deps)).toMatchObject({ action: "revise" });
  });

  it("fuse state is per coordinator session key", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_FUSE_N = "1";
    const deps = { logger: auditMock, now: () => 5_000_000 };
    // Session A trips immediately (threshold 1).
    expect(await superviseFinalize(event("Reply CONFIRM 1111 now."), deps)).toEqual({
      action: "continue",
    });
    // A different scopelybot session is unaffected by A's cooldown.
    expect(
      await superviseFinalize(
        event("Reply CONFIRM 2222 now.", { sessionKey: "agent:scopelybot:zoom:thread:other" }),
        deps,
      ),
    ).toEqual({ action: "continue" }); // trips its own fuse (threshold 1) — but independently
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(2);
  });

  it("spoke fuse accumulates across per-spawn UUIDs of the same spoke (audit F4)", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_V2 = "1";
    process.env.SCOPELYBOT_SUPERVISOR_FUSE_N = "2";
    let t = 9_000_000;
    const deps = { logger: auditMock, now: () => t };
    const spawnA = "agent:scopely-observe:subagent:aaaaaaaa-1111";
    const spawnB = "agent:scopely-observe:subagent:bbbbbbbb-2222";

    // Spawn A: revision 1 on the shared agent:scopely-observe fuse.
    expect(
      await superviseFinalize(event("Reply CONFIRM 1111 now.", { sessionKey: spawnA }), deps),
    ).toMatchObject({ action: "revise" });
    // Spawn B (fresh UUID): revision 2 — trips the SHARED fuse.
    t += 1000;
    expect(
      await superviseFinalize(event("Reply CONFIRM 2222 now.", { sessionKey: spawnB }), deps),
    ).toEqual({ action: "continue" });
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(1);
    // A different spoke agent is unaffected.
    t += 1000;
    expect(
      await superviseFinalize(
        event("Reply CONFIRM 3333 now.", { sessionKey: "agent:scopely-users:subagent:cccc" }),
        deps,
      ),
    ).toMatchObject({ action: "revise" });
  });
});
