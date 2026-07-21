// Runtime supervisor for scopelybot (Slice S — Doug's direction, design in
// docs/reference/scopely-support-service-design.md §4.2).
//
// Wired into `before_agent_finalize`: reviews the coordinator's DRAFT final
// reply before it is accepted, and either lets it through (`continue`) or
// requests ONE bounded revision pass (`revise` + retry.maxAttempts=1 — the
// harness enforces the budget per run+idempotencyKey, so a broken check can
// never create an unbounded loop). All checks are DETERMINISTIC string/shape
// predicates — no model in the supervisor's own loop.
//
// The fuse (Doug's requirement): repeated revisions within a window mean the
// model cannot satisfy the checks — stop retrying, accept the draft, post a
// plain-language escalation naming a human owner to the bound channel, and
// cool down (pass-through) so a degraded model can't spam revision churn.
//
// Out of reach BY CONSTRUCTION: the confirm gate. This module never touches
// the pending-confirm store; its only contact with CONFIRM is BLOCKING drafts
// that try to emit a code (the system posts confirm prompts deterministically
// — the LLM must never relay one). Staged-write NO_REPLY turns never reach
// this hook at all: the harness skips before_agent_finalize for silent
// replies (src/agents/embedded-agent-runner/run/attempt.ts finalize guard).

import type { AuditLogger } from "./audit.js";
import { sendScopelyText } from "./comfort.js";

// Shape of the before_agent_finalize event fields this module consumes.
// Kept structural (not imported from core types) so the extension compiles
// against the plugin SDK surface the other scopelybot modules use.
export type FinalizeEvent = {
  runId?: string;
  sessionKey?: string;
  turnId?: string;
  lastAssistantMessage?: string;
  messages?: unknown[];
};

export type FinalizeResult = {
  action: "continue" | "revise";
  reason?: string;
  retry?: { instruction: string; idempotencyKey: string; maxAttempts: number };
};

// A failed check: checkId keys the harness retry budget; instruction is the
// revision prompt the harness feeds back to the model for the second pass.
export type SupervisorVerdict =
  | { ok: true }
  | { ok: false; checkId: string; reason: string; instruction: string };

// Opt-in via env, same rollout pattern as SCOPELYBOT_CONFIRM_BUNDLE_MS:
// unset/0 = supervisor disabled (byte-identical legacy behavior), so enabling
// on prod is an explicit, reversible env line. Read at call time so tests and
// late-loading env both resolve.
export function supervisorEnabled(): boolean {
  return process.env.SCOPELYBOT_SUPERVISOR === "1";
}

// Fuse tuning (env-overridable). Defaults: 3 revisions inside 10 minutes trip
// the fuse; pass-through cooldown of 10 minutes after a trip.
function fuseThreshold(): number {
  const raw = Number(process.env.SCOPELYBOT_SUPERVISOR_FUSE_N ?? "3");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
}
function fuseWindowMs(): number {
  const raw = Number(process.env.SCOPELYBOT_SUPERVISOR_FUSE_WINDOW_MS ?? String(10 * 60_000));
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
}
function fuseCooldownMs(): number {
  const raw = Number(process.env.SCOPELYBOT_SUPERVISOR_COOLDOWN_MS ?? String(10 * 60_000));
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60_000;
}

// ---------------------------------------------------------------------------
// Checks — deterministic predicates over the draft text + turn tool activity.
// Ordered by severity; the first failure wins (one revision instruction per
// pass keeps the retry prompt unambiguous).
// ---------------------------------------------------------------------------

// A CONFIRM code in an outbound draft means the model is relaying/fabricating
// a confirmation code — the one thing the confirm-gate design forbids (codes
// are posted deterministically by stageWrite, never through the LLM).
const CONFIRM_CODE_RE = /\bCONFIRM\s+\d{4}\b/i;

// Conservative secret shapes: JWTs, PEM private keys, bearer/api-key tokens,
// and explicit "the password is X" constructions. Deliberately narrow — a
// false positive costs a wasted model pass, but chatty patterns (e.g. the
// word "password" alone) would fire on legitimate reset-flow explanations.
const SECRET_RES: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{25,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bpassword\s+(?:is|:)\s*[^\s.,;]{4,}/i,
];

// State-assertion cues: the draft claims concrete app state (ids, multi-digit
// counts, currency, percentages, emails). Combined with ZERO tool activity in
// the turn, this is the hallucinated-state signature T1/S9 was probing for.
const STATE_CUE_RES: RegExp[] = [
  /#\d+/,
  /\bid\s*[:=]?\s*\d+/i,
  /\b\d{3,}\b/,
  /\$\s?\d/,
  /\b\d+(?:\.\d+)?%/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

// True when the draft parses wholesale as JSON, or embeds a large JSON blob —
// the coordinator's contract is plain language, never raw tool output.
function looksLikeJsonDump(draft: string): boolean {
  const trimmed = draft.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 80) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // fall through to embedded-blob scan
    }
  }
  const blob = trimmed.match(/[{[][\s\S]{300,}[}\]]/);
  if (!blob) return false;
  try {
    JSON.parse(blob[0]);
    return true;
  } catch {
    return false;
  }
}

// Review one draft. `hadToolActivity` = did the turn include any tool result
// (spoke dispatches surface as tool results in the coordinator transcript,
// so routed reads count as grounding).
export function reviewDraft(draft: string, hadToolActivity: boolean): SupervisorVerdict {
  if (CONFIRM_CODE_RE.test(draft)) {
    return {
      ok: false,
      checkId: "confirm_code_leak",
      reason: "draft contains a CONFIRM code",
      instruction:
        "Your reply contains a confirmation code. Never include, repeat, or invent CONFIRM codes — " +
        "the system posts confirmation prompts itself. Remove the code and, if a write was staged, " +
        "say only that a confirmation prompt was posted to the channel.",
    };
  }
  for (const re of SECRET_RES) {
    if (re.test(draft)) {
      return {
        ok: false,
        checkId: "secret_leak",
        reason: "draft contains a secret-shaped value",
        instruction:
          "Your reply contains what looks like a secret (token, key, or password value). Never put " +
          "secret values in the channel. Remove it and explain the actual delivery mechanism instead " +
          "(for example: a reset email is sent to the user).",
      };
    }
  }
  if (looksLikeJsonDump(draft)) {
    return {
      ok: false,
      checkId: "raw_json_dump",
      reason: "draft is raw JSON, not a human answer",
      instruction:
        "Your reply is raw JSON or contains a large JSON dump. Rewrite it as a plain-language answer: " +
        "lead with the answer, keep only the fields the human asked about, no code blocks.",
    };
  }
  // A clarifying question back to the human is not a state claim.
  const isShortQuestion = draft.trim().length < 120 && draft.trim().endsWith("?");
  if (!hadToolActivity && !isShortQuestion && STATE_CUE_RES.some((re) => re.test(draft))) {
    return {
      ok: false,
      checkId: "unsupported_state_claim",
      reason: "draft asserts app state with no tool read this turn",
      instruction:
        "Your reply states specific facts about the application (ids, counts, amounts, or addresses) " +
        "but no tool was consulted this turn. Verify every stated fact with a fresh tool read before " +
        "answering; if you cannot verify, say what you could not verify instead of guessing.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Turn tool-activity detection over the (unknown-typed) transcript messages:
// any toolResult-role message AFTER the last user message counts.
// ---------------------------------------------------------------------------

export function turnHadToolActivity(messages: unknown[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;
  let sawToolResult = false;
  for (const msg of messages) {
    const role = (msg as { role?: unknown } | null)?.role;
    if (role === "user") {
      sawToolResult = false; // new turn boundary — reset
    } else if (role === "toolResult") {
      sawToolResult = true;
    }
  }
  return sawToolResult;
}

// ---------------------------------------------------------------------------
// Fuse — per-session sliding window of revision timestamps + cooldown.
// ---------------------------------------------------------------------------

type FuseState = { revisions: number[]; fusedUntil: number };
const fuseBySession = new Map<string, FuseState>();

function fuseFor(sessionKey: string): FuseState {
  let s = fuseBySession.get(sessionKey);
  if (!s) {
    s = { revisions: [], fusedUntil: 0 };
    fuseBySession.set(sessionKey, s);
  }
  return s;
}

// Record a revision; returns true when this one TRIPS the fuse.
function recordRevisionAndCheckFuse(sessionKey: string, now: number): boolean {
  const s = fuseFor(sessionKey);
  const windowStart = now - fuseWindowMs();
  s.revisions = s.revisions.filter((t) => t >= windowStart);
  s.revisions.push(now);
  if (s.revisions.length >= fuseThreshold()) {
    s.revisions = [];
    s.fusedUntil = now + fuseCooldownMs();
    return true;
  }
  return false;
}

function isFused(sessionKey: string, now: number): boolean {
  return fuseFor(sessionKey).fusedUntil > now;
}

// Test hook: clear all fuse state between test cases.
export function resetSupervisorStateForTest(): void {
  fuseBySession.clear();
}

// ---------------------------------------------------------------------------
// Hook entry point.
// ---------------------------------------------------------------------------

// Supervise one finalize event. Returns undefined (no opinion) for disabled /
// out-of-scope / clean drafts, a revise result for a failed check, or continue
// (+ deterministic escalation post) when the fuse trips.
export async function superviseFinalize(
  event: FinalizeEvent,
  deps: { logger: AuditLogger; now?: () => number },
): Promise<FinalizeResult | undefined> {
  if (!supervisorEnabled()) return undefined;
  // Coordinator scope only: spokes return internal packets (reviewed later);
  // the user-facing surface is the scopelybot coordinator session.
  const sessionKey = event.sessionKey ?? "";
  if (!sessionKey.startsWith("agent:scopelybot:")) return undefined;
  const draft = typeof event.lastAssistantMessage === "string" ? event.lastAssistantMessage : "";
  if (!draft.trim()) return undefined;

  const now = deps.now ? deps.now() : Date.now();
  if (isFused(sessionKey, now)) return { action: "continue" };

  const verdict = reviewDraft(draft, turnHadToolActivity(event.messages));
  if (verdict.ok) return undefined;

  const tripped = recordRevisionAndCheckFuse(sessionKey, now);
  deps.logger({
    ts: new Date(now).toISOString(),
    tool: "scopely_supervisor",
    actor: "system",
    params: { checkId: verdict.checkId, sessionKey },
    resultSummary: tripped ? `fuse_tripped after ${verdict.checkId}` : `revise: ${verdict.checkId}`,
  });

  if (tripped) {
    // Stop retrying: accept the draft (it was already the model's best after
    // prior passes) and post a plain-language escalation naming a human owner
    // — the no-dead-end rule. Posted deterministically, never via the model.
    const owner = process.env.SCOPELYBOT_ESCALATION_OWNER ?? "Chad Simon";
    const channel = process.env.SCOPELYBOT_ZOOM_CHANNEL ?? "";
    if (channel) {
      await sendScopelyText(
        channel,
        `I couldn't fully verify parts of my last answer after several attempts — treat its details ` +
          `as provisional. Flagging ${owner} to double-check; they'll follow up here.`,
      ).catch(() => {
        // Escalation post is best-effort; the audit entry above is the record.
      });
    }
    return { action: "continue" };
  }

  return {
    action: "revise",
    reason: verdict.reason,
    retry: {
      instruction: verdict.instruction,
      // Keyed per turn+check so the harness budget allows exactly ONE retry
      // for this check in this turn, and a different check may still fire.
      idempotencyKey: `scopelybot-supervisor:${event.turnId ?? event.runId ?? "turn"}:${verdict.checkId}`,
      maxAttempts: 1,
    },
  };
}
