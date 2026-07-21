// Supervisor tests (supervisor.ts — Slice S). Cover: opt-in gating, coordinator
// session scoping, each deterministic check, the harness-budgeted revise shape,
// the fuse (trip → accept + escalation post + cooldown pass-through), and the
// confirm-gate boundary (the supervisor blocks code relays; it never executes).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendScopelyTextMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
  getChannelThreadAnchor: () => undefined,
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
}));

import {
  resetSupervisorStateForTest,
  reviewDraft,
  superviseFinalize,
  turnHadToolActivity,
} from "./supervisor.js";

const SESSION = "agent:scopelybot:zoom:channel:vipbot@conference.xmpp.zoom.us";
const CHANNEL = "vipbot@conference.xmpp.zoom.us";
const auditMock = vi.fn();

// A turn with one grounded tool read (user → toolResult → assistant).
const GROUNDED_TURN = [
  { role: "user", content: "how many sessions?" },
  { role: "assistant", content: [{ type: "toolCall" }] },
  { role: "toolResult", content: "42" },
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

  it("ignores sessions that are not the scopelybot coordinator", async () => {
    const res = await superviseFinalize(
      event("CONFIRM 1234", { sessionKey: "agent:pulsebot:zoom:channel:x" }),
      { logger: auditMock },
    );
    expect(res).toBeUndefined();
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
    const v = reviewDraft("Reply CONFIRM 4821 to proceed.", true);
    expect(v).toMatchObject({ ok: false, checkId: "confirm_code_leak" });
  });

  it("blocks secret-shaped values", () => {
    const jwt = `token: eyJ${"a".repeat(24)}.${"b".repeat(16)}`;
    expect(reviewDraft(jwt, true)).toMatchObject({ ok: false, checkId: "secret_leak" });
    expect(reviewDraft("The password is hunter22.", true)).toMatchObject({
      ok: false,
      checkId: "secret_leak",
    });
  });

  it("does not flag reset-flow explanations that mention passwords", () => {
    expect(
      reviewDraft("A password reset email was sent to the user; they set their own.", true),
    ).toEqual({ ok: true });
  });

  it("blocks raw JSON dumps", () => {
    const dump = JSON.stringify({ results: Array.from({ length: 30 }, (_, i) => ({ id: i })) });
    expect(reviewDraft(dump, true)).toMatchObject({ ok: false, checkId: "raw_json_dump" });
  });

  it("blocks state assertions made with zero tool reads this turn", () => {
    const v = reviewDraft("Org 314 has 1250 sessions and owes $4,200.", false);
    expect(v).toMatchObject({ ok: false, checkId: "unsupported_state_claim" });
  });

  it("allows the same state assertion when the turn had a tool read", () => {
    expect(reviewDraft("Org 314 has 1250 sessions and owes $4,200.", true)).toEqual({ ok: true });
  });

  it("allows a short clarifying question even with no tool read", () => {
    expect(reviewDraft("Do you mean session 314?", false)).toEqual({ ok: true });
  });
});

describe("turnHadToolActivity", () => {
  it("counts tool results after the last user message only", () => {
    expect(turnHadToolActivity(GROUNDED_TURN)).toBe(true);
    expect(
      turnHadToolActivity([
        { role: "toolResult", content: "stale — previous turn" },
        { role: "user", content: "fresh question" },
        { role: "assistant", content: "answer" },
      ]),
    ).toBe(false);
    expect(turnHadToolActivity(undefined)).toBe(false);
  });
});

describe("revise shape", () => {
  it("returns a harness-budgeted single retry keyed per turn+check", async () => {
    const res = await superviseFinalize(event("Reply CONFIRM 4821 to proceed."), {
      logger: auditMock,
    });
    expect(res).toMatchObject({
      action: "revise",
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

  it("fuse state is per session key", async () => {
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
});
