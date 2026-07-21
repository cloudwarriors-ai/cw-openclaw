// Runtime supervisor for scopelybot (Slice S v1 + Slice S2 v2 — Doug's
// direction; design in docs/reference/scopely-support-service-design.md §4.2,
// v2 research in docs/reference/supervisor-v2-research.md).
//
// Wired into `before_agent_finalize`: reviews a DRAFT final reply before it is
// accepted, and either lets it through (`continue`) or requests a bounded
// revision pass. Bounds: the harness's global MAX_BEFORE_AGENT_FINALIZE_
// REVISIONS=3 per run (run.ts:217) plus this module's fuse — the harness does
// NOT enforce per-check retry budgets (retry.{idempotencyKey,maxAttempts} are
// typed but unconsumed; only `reason` reaches the model, see the revise-return
// comment below). All checks are DETERMINISTIC string/shape predicates — no
// model in the supervisor's own loop (per the v2 research: deterministic
// claim-vs-evidence is the highest-confidence egress pattern; LLM self-checks
// are a documented failure mode).
//
// v2 (SCOPELYBOT_SUPERVISOR_V2=1) extends v1 with:
//   - an EVIDENCE MODEL that understands how this hub-and-spoke bot is
//     actually grounded: spoke results reach the coordinator as USER-role
//     prompts carrying the internal-completion-event markers (verified against
//     a live prod transcript 2026-07-21 — they are NOT toolResults and never
//     land in the persisted jsonl). Internal-event user messages count as
//     grounding evidence; only HUMAN user messages reset the turn boundary.
//     This also fixes a latent v1 defect where a routed numeric answer would
//     have tripped unsupported_state_claim (internal events reset the
//     boundary, leaving zero visible tool activity).
//   - `ungrounded_claim`: hard tokens in the draft (emails, ids, ≥3-digit
//     numbers, currency) must appear in the same-turn evidence corpus or the
//     human's own message. Missing values force a revision that demands FRESH
//     evidence (per Huang et al. ICLR 2024: self-correction without new
//     external evidence degrades answers — the instruction never says "try
//     harder", it says "re-read").
//   - SPOKE coverage: scopely-* spoke finalize turns get the leak checks plus
//     both grounding checks. Spokes are the enforcement point for accuracy:
//     read-only spoke turns have no deterministic side effects, so the
//     harness's revise path actually runs there — unlike coordinator turns
//     that spawned spokes (hasAcceptedSessionSpawn blocks revision,
//     src/agents/embedded-agent-runner/run/attempt.ts side-effect guard), where
//     this module's verdict is detection/audit only. Write-spokes that already
//     committed a staged execute are likewise detection-only by construction.
//
// The fuse (Doug's requirement): repeated revisions within a window mean the
// model cannot satisfy the checks — stop retrying, accept the draft, post a
// plain-language escalation naming a human owner to the bound channel, and
// cool down (pass-through) so a degraded model can't spam revision churn.
// Spoke sessions embed a fresh UUID per spawn (agent:<spoke>:subagent:<uuid>),
// so the spoke fuse keys on the stable `agent:<spokeId>` prefix — a full-key
// fuse would never accumulate across spawns and could never escalate.
//
// Out of reach BY CONSTRUCTION: the confirm gate. This module never touches
// the pending-confirm store; its only contact with CONFIRM is BLOCKING drafts
// that try to emit a code (the system posts confirm prompts deterministically
// — the LLM must never relay one). Staged-write NO_REPLY turns never reach
// this hook at all: the harness skips before_agent_finalize for silent
// replies (src/agents/embedded-agent-runner/run/attempt.ts finalize guard).

import type { AuditLogger } from "./audit.js";
import { sendScopelyText } from "./comfort.js";
import { judgeVoice, voiceJudgeEnabled, type VoiceLlmComplete } from "./voice-judge.js";

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

// Which check profile applies to the session under review. Spokes return
// structured internal evidence packets, so they skip the raw_json_dump
// voice check but get the full grounding checks.
export type SupervisorProfile = "coordinator" | "spoke";

// Opt-in via env, same rollout pattern as SCOPELYBOT_CONFIRM_BUNDLE_MS:
// unset/0 = supervisor disabled (byte-identical legacy behavior), so enabling
// on prod is an explicit, reversible env line. Read at call time so tests and
// late-loading env both resolve.
export function supervisorEnabled(): boolean {
  return process.env.SCOPELYBOT_SUPERVISOR === "1";
}

// v2 gate: spoke coverage + the ungrounded_claim check. Separate from the
// base flag because SCOPELYBOT_SUPERVISOR=1 is already live on prod — new
// check classes must not activate through an already-on switch (audit
// finding, 2026-07-21).
export function supervisorV2Enabled(): boolean {
  return process.env.SCOPELYBOT_SUPERVISOR_V2 === "1";
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
// Checks — deterministic predicates over the draft text + turn evidence.
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
// counts, currency, percentages, emails). Combined with ZERO evidence in the
// turn, this is the hallucinated-state signature T1/S9 was probing for.
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

// ---------------------------------------------------------------------------
// Turn evidence model.
//
// How this bot is ACTUALLY grounded (verified on a live prod coordinator
// transcript, 2026-07-21): spoke completion packets are delivered to the
// coordinator as USER-role prompts carrying the internal-event markers below —
// they are NOT toolResults. So the grounding corpus for a turn is: toolResult
// content + internal-event user-message content, and the turn boundary is the
// last HUMAN user message (one without the markers). The marker strings are
// structural copies of core constants (src/agents/internal-events.ts,
// src/agents/internal-runtime-context.ts) — test-pinned, not imported, per
// this extension's no-core-imports convention.
// ---------------------------------------------------------------------------

const INTERNAL_EVENT_MARKERS = [
  "[Internal task completion event]",
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "OpenClaw runtime event.",
];

// Extract plain text from a transcript message's content (string or blocks).
function messageText(msg: unknown): string {
  const content = (msg as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as { type?: unknown; text?: unknown } | null;
        return b && b.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .join("\n");
  }
  return "";
}

function isInternalEventText(text: string): boolean {
  return INTERNAL_EVENT_MARKERS.some((marker) => text.includes(marker));
}

export type TurnEvidence = {
  // True when the turn carries any grounding evidence (toolResults or
  // internal completion events after the last human message).
  hadEvidence: boolean;
  // Concatenated evidence text for claim grounding.
  corpus: string;
  // The human's own message — values the user supplied are echoable without
  // being treated as unverified state claims.
  humanText: string;
};

// Walk the transcript: HUMAN user messages reset the turn; toolResults and
// internal-event user messages accumulate as evidence.
export function collectTurnEvidence(messages: unknown[] | undefined): TurnEvidence {
  if (!Array.isArray(messages)) return { hadEvidence: false, corpus: "", humanText: "" };
  let corpusParts: string[] = [];
  let humanText = "";
  for (const msg of messages) {
    const role = (msg as { role?: unknown } | null)?.role;
    if (role === "user") {
      const text = messageText(msg);
      if (isInternalEventText(text)) {
        // Spoke packet / runtime event — evidence, not a turn boundary.
        corpusParts.push(text);
      } else {
        // Fresh human message — new turn.
        corpusParts = [];
        humanText = text;
      }
    } else if (role === "toolResult") {
      corpusParts.push(messageText(msg));
    }
  }
  return {
    hadEvidence: corpusParts.length > 0,
    corpus: corpusParts.join("\n"),
    humanText,
  };
}

// Back-compat convenience used by v1 tests/consumers: "did this turn have any
// grounding evidence". NOTE (v2 semantics fix): internal completion events now
// count as evidence and no longer reset the turn — strictly FEWER
// unsupported_state_claim fires than the v1 walk, never more.
export function turnHadToolActivity(messages: unknown[] | undefined): boolean {
  return collectTurnEvidence(messages).hadEvidence;
}

// ---------------------------------------------------------------------------
// ungrounded_claim — hard-token extraction + evidence matching (v2).
// ---------------------------------------------------------------------------

// ISO-8601 dates/timestamps are formatting, not claims — a spoke legitimately
// renders "2026-07-21T02:10:01Z" from epoch fields the corpus stores
// differently. Strip them before token extraction.
const ISO_DATETIME_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// #123 and "id: 123" / "id 123" forms.
const EXPLICIT_ID_RE = /(?:#|\bid\s*[:=]?\s*)(\d+)/gi;
// 1,234.56 / 1234 / 149.00 — ≥3 significant digits once separators drop.
const NUMBER_RE = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b/g;

function normalizeNumber(raw: string): string {
  return raw.replace(/,/g, "");
}

// 4-digit standalone numbers in the plausible-year range are far more often
// years than fabricated ids/counts — excluded to keep the false-positive cost
// down (audit finding: dates/years dominate ordinary evidence packets).
function isPlausibleYear(normalized: string): boolean {
  if (!/^\d{4}$/.test(normalized)) return false;
  const n = Number(normalized);
  return n >= 1900 && n <= 2100;
}

// Extract the hard (checkable) claim tokens from a draft.
export function extractHardTokens(draft: string): string[] {
  const stripped = draft.replace(ISO_DATETIME_RE, " ");
  const tokens = new Set<string>();
  for (const m of stripped.matchAll(EMAIL_RE)) tokens.add(m[0].toLowerCase());
  for (const m of stripped.matchAll(EXPLICIT_ID_RE)) tokens.add(m[1]);
  for (const m of stripped.matchAll(NUMBER_RE)) {
    const normalized = normalizeNumber(m[0]);
    if (isPlausibleYear(normalized)) continue;
    tokens.add(normalized);
  }
  return [...tokens];
}

// A token is grounded when it appears in the evidence corpus or the human's
// own message (user-supplied ids are echoable). Numbers match separator- and
// case-insensitively; decimals also match on their integer part (rendered
// "149.00" vs stored "149").
function tokenGrounded(token: string, haystack: string): boolean {
  if (haystack.includes(token)) return true;
  if (/^\d/.test(token) && token.includes(".")) {
    const integerPart = token.split(".")[0];
    if (integerPart.length >= 3 && haystack.includes(integerPart)) return true;
  }
  return false;
}

export function findUngroundedTokens(draft: string, evidence: TurnEvidence): string[] {
  const haystack = normalizeNumber(`${evidence.corpus}\n${evidence.humanText}`).toLowerCase();
  return extractHardTokens(draft).filter((token) => !tokenGrounded(token.toLowerCase(), haystack));
}

// ---------------------------------------------------------------------------
// Draft review.
// ---------------------------------------------------------------------------

// Review one draft against a profile. Coordinator keeps the v1 check set
// (+ ungrounded_claim under the v2 flag); spokes get the leak + grounding
// checks but not the raw_json_dump voice check (their packets are structured
// by contract).
export function reviewDraft(
  draft: string,
  evidence: TurnEvidence,
  profile: SupervisorProfile = "coordinator",
): SupervisorVerdict {
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
  if (profile === "coordinator" && looksLikeJsonDump(draft)) {
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
  if (!evidence.hadEvidence && !isShortQuestion && STATE_CUE_RES.some((re) => re.test(draft))) {
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
  // v2 grounding: with evidence present, every hard value in the draft must
  // trace to that evidence (or to the human's own message). The revision
  // demands NEW evidence, never a re-read of the draft's own reasoning.
  if (supervisorV2Enabled() && evidence.hadEvidence && !isShortQuestion) {
    const ungrounded = findUngroundedTokens(draft, evidence);
    if (ungrounded.length > 0) {
      const list = ungrounded.slice(0, 8).join(", ");
      return {
        ok: false,
        checkId: "ungrounded_claim",
        reason: `draft asserts values not present in this turn's evidence: ${list}`,
        instruction:
          profile === "spoke"
            ? `These values in your answer do not appear in any tool result from this turn: ${list}. ` +
              "Re-run the relevant read tool(s) and restate ONLY values present in fresh tool output; " +
              "if a value cannot be verified, say so explicitly instead of stating it."
            : `These values in your answer do not appear in the spoke evidence you received this turn: ${list}. ` +
              "Restate only values present in the spoke results; if a value is missing, dispatch the " +
              "appropriate spoke for a fresh read instead of stating it.",
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Session scoping.
// ---------------------------------------------------------------------------

const COORDINATOR_PREFIX = "agent:scopelybot:";
// Spoke sessions: agent:scopely-<domain>:subagent:<uuid> (uuid fresh per
// spawn — see fuse keying below).
const SPOKE_KEY_RE = /^agent:(scopely-[a-z]+):/;

type SessionScope = { profile: SupervisorProfile; fuseKey: string } | undefined;

function resolveScope(sessionKey: string): SessionScope {
  if (sessionKey.startsWith(COORDINATOR_PREFIX)) {
    return { profile: "coordinator", fuseKey: sessionKey };
  }
  const spoke = SPOKE_KEY_RE.exec(sessionKey);
  if (spoke && supervisorV2Enabled()) {
    // Stable per-spoke fuse key: the full session key embeds a per-spawn UUID,
    // which would give every spawn a fresh (empty) fuse and the escalation
    // guarantee would never fire.
    return { profile: "spoke", fuseKey: `agent:${spoke[1]}` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fuse — per-fuse-key sliding window of revision timestamps + cooldown.
// ---------------------------------------------------------------------------

type FuseState = { revisions: number[]; fusedUntil: number };
const fuseBySession = new Map<string, FuseState>();

function fuseFor(fuseKey: string): FuseState {
  let s = fuseBySession.get(fuseKey);
  if (!s) {
    s = { revisions: [], fusedUntil: 0 };
    fuseBySession.set(fuseKey, s);
  }
  return s;
}

// Record a revision; returns true when this one TRIPS the fuse.
function recordRevisionAndCheckFuse(fuseKey: string, now: number): boolean {
  const s = fuseFor(fuseKey);
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

function isFused(fuseKey: string, now: number): boolean {
  return fuseFor(fuseKey).fusedUntil > now;
}

// ---------------------------------------------------------------------------
// Voice-judge per-run once guard. The harness does not enforce per-check
// retry budgets (see the revise-return comment), and an LLM judge is
// non-deterministic across passes — without this cap a picky judge could
// burn all 3 harness revisions on voice alone. Bounded FIFO so the set
// cannot grow without limit across a long-lived process.
// ---------------------------------------------------------------------------

const VOICE_JUDGED_RUNS_MAX = 200;
const voiceRevisedRuns = new Set<string>();

function markVoiceRevised(runKey: string): void {
  voiceRevisedRuns.add(runKey);
  if (voiceRevisedRuns.size > VOICE_JUDGED_RUNS_MAX) {
    const oldest = voiceRevisedRuns.values().next().value;
    if (oldest !== undefined) voiceRevisedRuns.delete(oldest);
  }
}

// Test hook: clear all fuse state between test cases.
export function resetSupervisorStateForTest(): void {
  fuseBySession.clear();
  voiceRevisedRuns.clear();
}

// ---------------------------------------------------------------------------
// Hook entry point.
// ---------------------------------------------------------------------------

// Supervise one finalize event. Returns undefined (no opinion) for disabled /
// out-of-scope / clean drafts, a revise result for a failed check, or continue
// (+ deterministic escalation post) when the fuse trips.
export async function superviseFinalize(
  event: FinalizeEvent,
  deps: { logger: AuditLogger; now?: () => number; llmComplete?: VoiceLlmComplete },
): Promise<FinalizeResult | undefined> {
  if (!supervisorEnabled()) return undefined;
  const sessionKey = event.sessionKey ?? "";
  const scope = resolveScope(sessionKey);
  if (!scope) return undefined;
  const draft = typeof event.lastAssistantMessage === "string" ? event.lastAssistantMessage : "";
  if (!draft.trim()) return undefined;

  const now = deps.now ? deps.now() : Date.now();
  if (isFused(scope.fuseKey, now)) return { action: "continue" };

  let verdict = reviewDraft(draft, collectTurnEvidence(event.messages), scope.profile);

  // Voice lane (v2.1, SCOPELYBOT_SUPERVISOR_VOICE=1): only when the
  // deterministic plane is satisfied, only for human-facing coordinator
  // drafts, and at most once per run (the harness's revision budget is
  // global, not per-check — a non-deterministic judge must self-cap).
  // judgeVoice never throws: error/timeout/malformed output all fail open.
  const runKey = event.runId ?? event.turnId ?? "";
  if (
    verdict.ok &&
    voiceJudgeEnabled() &&
    scope.profile === "coordinator" &&
    deps.llmComplete &&
    runKey &&
    !voiceRevisedRuns.has(runKey)
  ) {
    const voice = await judgeVoice(draft, { complete: deps.llmComplete, logger: deps.logger, now: deps.now });
    if (!voice.ok) {
      markVoiceRevised(runKey);
      verdict = {
        ok: false,
        checkId: "voice",
        reason: "voice judge requested a tone/readability revision",
        instruction: voice.instruction,
      };
    }
  }
  if (verdict.ok) return undefined;

  const tripped = recordRevisionAndCheckFuse(scope.fuseKey, now);
  deps.logger({
    ts: new Date(now).toISOString(),
    tool: "scopely_supervisor",
    actor: "system",
    params: { checkId: verdict.checkId, sessionKey, profile: scope.profile },
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
    // SUBSTRATE FACT (verified 2026-07-21): the harness feeds ONLY `reason`
    // back to the model — run.ts builds the retry prompt as
    // BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX + "\n\n" + outcome.reason
    // (src/agents/embedded-agent-runner/run.ts:276, attempt.ts:3193). The
    // `retry.{instruction,idempotencyKey,maxAttempts}` fields exist in the
    // typed contract (hook-types.ts:377) but nothing consumes them today, so
    // the actionable instruction MUST ride in `reason` or it is silently
    // dropped. The real revision bounds are the harness's global cap
    // (MAX_BEFORE_AGENT_FINALIZE_REVISIONS=3 per run) plus this module's fuse.
    reason: verdict.instruction,
    retry: {
      instruction: verdict.instruction,
      idempotencyKey: `scopelybot-supervisor:${event.turnId ?? event.runId ?? "turn"}:${verdict.checkId}`,
      maxAttempts: 1,
    },
  };
}
