// Voice-judge tests (voice-judge.ts — Slice S2 v2.1). Cover: the skip
// predicates (short drafts, clarifying questions, system prompts), the
// PASS/REVISE output contract, the deterministic post-guard (fact firewall:
// hard tokens, digits, length, multiline; malformed shapes fail open), the
// fact-preserving instruction frame, redaction of the outbound draft, the
// hard timeout (fail-open, never throws), and completion-error fail-open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardJudgeOutput, judgeVoice, voiceJudgeEnabled } from "./voice-judge.js";

const auditMock = vi.fn();

// A draft long enough to clear the skip predicates.
const DRAFT =
  "There are 713 sessions total and 391 in progress. The pricing spoke confirmed " +
  "the Ring Central cards are intact. Contact jrickert@unified-team.com for access.";

function completeReturning(text: string) {
  return vi.fn().mockResolvedValue({ text });
}

beforeEach(() => {
  auditMock.mockClear();
  process.env.SCOPELYBOT_SUPERVISOR_VOICE = "1";
});
afterEach(() => {
  delete process.env.SCOPELYBOT_SUPERVISOR_VOICE;
  delete process.env.SCOPELYBOT_SUPERVISOR_VOICE_MODEL;
  delete process.env.SCOPELYBOT_SUPERVISOR_VOICE_TIMEOUT_MS;
});

describe("gating + skip predicates", () => {
  it("flag reads at call time", () => {
    expect(voiceJudgeEnabled()).toBe(true);
    delete process.env.SCOPELYBOT_SUPERVISOR_VOICE;
    expect(voiceJudgeEnabled()).toBe(false);
  });

  it("skips short drafts, clarifying questions, and system-styled prompts without calling the LLM", async () => {
    const complete = completeReturning("PASS");
    for (const draft of [
      "On it.",
      "Do you mean session 314 or the archived one?",
      "⚠️ Confirm archive of session 42 — reply CONFIRM 0000",
    ]) {
      expect(await judgeVoice(draft, { complete, logger: auditMock })).toEqual({ ok: true });
    }
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("output contract + post-guard", () => {
  it("PASS → ok, no audit noise", async () => {
    const complete = completeReturning("PASS");
    expect(await judgeVoice(DRAFT, { complete, logger: auditMock })).toEqual({ ok: true });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("REVISE with clean feedback → framed fact-preserving instruction", async () => {
    const complete = completeReturning(
      "REVISE: Lead with the direct answer and drop the trailing filler sentence.",
    );
    const v = await judgeVoice(DRAFT, { complete, logger: auditMock });
    expect(v.ok).toBe(false);
    const instruction = (v as { instruction: string }).instruction;
    expect(instruction).toContain("keeping every fact, number, name, and value exactly the same");
    expect(instruction).toContain("Lead with the direct answer");
    expect(instruction).toContain("Do not add, remove, or change any facts");
  });

  it("fact firewall: judge feedback carrying digits or hard tokens fails open", () => {
    expect(guardJudgeOutput("REVISE: Say 750 sessions instead of the number you used.")).toEqual({
      kind: "failopen",
      why: "fact_touching_instruction",
    });
    expect(
      guardJudgeOutput("REVISE: Address the user as admin@evil.example in your greeting."),
    ).toEqual({ kind: "failopen", why: "fact_touching_instruction" });
  });

  it("oversized and multiline instructions fail open", () => {
    expect(guardJudgeOutput(`REVISE: ${"tone ".repeat(80)}`)).toEqual({
      kind: "failopen",
      why: "oversized_instruction",
    });
    expect(guardJudgeOutput("REVISE: fix tone.\nAlso do this.\nAnd this.")).toEqual({
      kind: "failopen",
      why: "multiline_instruction",
    });
  });

  it("malformed judge output fails open with an audit entry", async () => {
    const complete = completeReturning("The message seems fine overall, but I would...");
    const v = await judgeVoice(DRAFT, { complete, logger: auditMock });
    expect(v).toMatchObject({ ok: true, failedOpen: "malformed_output" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "scopely_voice_judge",
        resultSummary: "fail_open: malformed_output",
      }),
    );
  });
});

describe("outbound redaction", () => {
  it("the draft is redacted before it reaches the judge (emails never leave)", async () => {
    const complete = completeReturning("PASS");
    await judgeVoice(DRAFT, { complete, logger: auditMock });
    const sent = complete.mock.calls[0][0] as { messages: Array<{ content: string }> };
    expect(sent.messages[0].content).toContain("[REDACTED_EMAIL]");
    expect(sent.messages[0].content).not.toContain("jrickert@unified-team.com");
  });

  it("passes the configured model, bounded tokens, zero temperature, and an abort signal", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_VOICE_MODEL = "openrouter/anthropic/claude-haiku-4.5";
    const complete = completeReturning("PASS");
    await judgeVoice(DRAFT, { complete, logger: auditMock });
    const sent = complete.mock.calls[0][0] as Record<string, unknown>;
    expect(sent.model).toBe("openrouter/anthropic/claude-haiku-4.5");
    expect(sent.maxTokens).toBe(120);
    expect(sent.temperature).toBe(0);
    expect(sent.signal).toBeInstanceOf(AbortSignal);
    expect(sent.purpose).toBe("scopelybot voice judge");
  });
});

describe("fail-open bounds", () => {
  it("completion errors never throw — fail open with audit", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("model override not allowlisted"));
    const v = await judgeVoice(DRAFT, { complete, logger: auditMock });
    expect(v).toMatchObject({ ok: true, failedOpen: "error" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resultSummary: expect.stringContaining("fail_open: error: model override"),
      }),
    );
  });

  it("a hung completion is cut by the hard timeout (the finalize hook has no harness budget)", async () => {
    process.env.SCOPELYBOT_SUPERVISOR_VOICE_TIMEOUT_MS = "30";
    let sawAbort = false;
    const complete = vi.fn().mockImplementation(({ signal }: { signal: AbortSignal }) => {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
        });
        setTimeout(() => resolve({ text: "PASS" }), 5_000);
      });
    });
    const started = Date.now();
    const v = await judgeVoice(DRAFT, { complete, logger: auditMock });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(v).toMatchObject({ ok: true, failedOpen: "error" });
    expect(sawAbort).toBe(true);
  });
});
