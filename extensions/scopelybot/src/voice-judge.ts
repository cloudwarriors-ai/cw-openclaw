// Voice-judge lane for the scopelybot supervisor (Slice S2 v2.1 — the
// "human-readable" pillar). A bounded LLM check scoped to tone / persona /
// readability ONLY — never facts. Runs AFTER the deterministic checks pass on
// a coordinator draft, so a draft never gets a voice opinion until it is
// already correct + secure by the deterministic plane.
//
// Why an LLM here at all: readability has no deterministic predicate. The v2
// research (docs/reference/supervisor-v2-research.md Q3) excludes LLM judges
// as a CORRECTNESS backbone (position/verbosity/self-enhancement bias) but
// allows a narrowly-scoped tone/persona lane — provided the judge is a
// DIFFERENT model/vendor than the author (self-preference bias) and its
// output is deterministically post-guarded so it can never touch facts.
//
// Containment stack (every layer independent):
//   1. Flag-gated (SCOPELYBOT_SUPERVISOR_VOICE=1), coordinator profile only.
//   2. Draft is REDACTED (redactText) before leaving for the judge — emails,
//      phones, and secret-shaped values never reach the third-party model.
//   3. Hard time bound: AbortController + Promise.race (before_agent_finalize
//      has NO harness timeout — src/plugins/hooks.ts budget table — so a hung
//      completion would otherwise block the turn). Race wins even if the
//      completion path ignores the signal.
//   4. Deterministic post-guard on the judge's output: must be exactly PASS
//      or REVISE:<one short sentence>; the sentence is rejected if it carries
//      ANY hard token (numbers / emails / ids — fact-touching), is too long,
//      or spans multiple lines. Anything else fails open.
//   5. The accepted instruction is wrapped in a fixed fact-preserving frame
//      before it reaches the author model.
//   6. Same fuse as the deterministic checks (caller wires it), plus a
//      per-run once guard here — the harness does not enforce per-check
//      retry budgets, and an LLM judge is non-deterministic across passes.
//   7. Fail-open everywhere: judge error/timeout/malformed = no opinion.
//
// ACCEPTED RESIDUAL (audit 2026-07-21, monitored): the fact firewall blocks
// token-expressed facts (digits/emails/ids) but not WORD-expressed ones — a
// guard-passing instruction like "sound more positive" could in principle
// nudge the author into flipping a polarity ("denied"→"approved"). Layered
// mitigations: judge sees a REDACTED draft only; temp 0; the fixed
// fact-preserving frame; the revised draft re-runs the full deterministic
// plane (leak + grounding checks). Watch `revise: voice` audit entries for
// drift; if observed, narrow the remit to formatting-only.

import type { AuditLogger } from "./audit.js";
import { redactText } from "./redaction.js";
import { extractHardTokens } from "./supervisor.js";

// Structural copy of the api.runtime.llm.complete surface this module uses
// (src/plugins/runtime/types-core.ts:111) — not imported from core, per this
// extension's no-core-imports convention.
export type VoiceLlmComplete = (params: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  purpose?: string;
}) => Promise<{ text: string }>;

// Opt-in via env, same rollout pattern as the other supervisor flags.
export function voiceJudgeEnabled(): boolean {
  return process.env.SCOPELYBOT_SUPERVISOR_VOICE === "1";
}

// Judge model ref. Default is the prod-configured Anthropic fallback — a
// different vendor family than the coordinator (gpt-5.6-luna), per the
// self-preference-bias mitigation. The `model:` override additionally
// requires `plugins.entries.scopelybot.llm.allowModelOverride` in the host
// config; without it the completion throws and this lane fails open.
function voiceJudgeModel(): string {
  return process.env.SCOPELYBOT_SUPERVISOR_VOICE_MODEL ?? "openrouter/anthropic/claude-haiku-4.5";
}

function voiceJudgeTimeoutMs(): number {
  const raw = Number(process.env.SCOPELYBOT_SUPERVISOR_VOICE_TIMEOUT_MS ?? "4000");
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
}

// The judge's entire remit. Output contract is machine-checkable on purpose:
// the post-guard rejects anything that isn't PASS or a single short
// REVISE sentence free of hard tokens.
const VOICE_SYSTEM_PROMPT =
  "You review one outgoing Zoom chat message from an operations assistant. " +
  "Judge ONLY tone, persona, and readability — never facts, numbers, names, or values.\n\n" +
  "The voice standard: plain conversational language, lead with the answer, no markdown " +
  "syntax, no bullet lists, no raw JSON, no hedging filler, concise, professional and direct. " +
  "Redaction placeholders like [REDACTED_EMAIL] are expected — ignore them.\n\n" +
  "Reply with exactly one line:\n" +
  "PASS\n" +
  "or\n" +
  "REVISE: <one short sentence of voice or formatting feedback that mentions no specific " +
  "numbers, names, or values>";

const PASS_RE = /^\s*PASS\b/;
const REVISE_RE = /^\s*REVISE:\s*(.+)$/s;
const MAX_INSTRUCTION_CHARS = 300;

// Fixed fact-preserving frame around the judge's feedback — even a subtly
// off instruction cannot authorize a fact change in the revision pass.
function frameInstruction(feedback: string): string {
  return (
    "Rewrite your reply keeping every fact, number, name, and value exactly the same. " +
    `Voice feedback: ${feedback} ` +
    "Do not add, remove, or change any facts."
  );
}

export type VoiceVerdict =
  | { ok: true }
  | { ok: false; instruction: string }
  // Judge unavailable/errored/malformed — caller treats as ok (fail-open) but
  // the distinct shape lets tests pin the audit behavior.
  | { ok: true; failedOpen: string };

// Skip drafts with nothing to judge: trivially short texts, short clarifying
// questions (same predicate as the supervisor's state-claim carve-out), and
// system-styled ⚠️ prompts.
function shouldSkip(draft: string): boolean {
  const trimmed = draft.trim();
  if (trimmed.length < 40) return true;
  if (trimmed.length < 120 && trimmed.endsWith("?")) return true;
  if (trimmed.startsWith("⚠️")) return true;
  return false;
}

// Deterministic post-guard over the raw judge output. Returns the framed
// revision instruction, "pass", or a fail-open reason string.
export function guardJudgeOutput(
  raw: string,
): { kind: "pass" } | { kind: "revise"; instruction: string } | { kind: "failopen"; why: string } {
  if (PASS_RE.test(raw)) return { kind: "pass" };
  const m = REVISE_RE.exec(raw);
  if (!m) return { kind: "failopen", why: "malformed_output" };
  const feedback = m[1].trim();
  if (!feedback || feedback.length > MAX_INSTRUCTION_CHARS) {
    return { kind: "failopen", why: "oversized_instruction" };
  }
  if (feedback.split("\n").length > 2) {
    return { kind: "failopen", why: "multiline_instruction" };
  }
  // Fact firewall: an instruction carrying hard tokens (numbers, emails,
  // ids) is fact-touching by definition — outside the judge's remit.
  if (extractHardTokens(feedback).length > 0 || /\d/.test(feedback)) {
    return { kind: "failopen", why: "fact_touching_instruction" };
  }
  return { kind: "revise", instruction: frameInstruction(feedback) };
}

// Judge one coordinator draft. Never throws; every failure path is fail-open.
export async function judgeVoice(
  draft: string,
  deps: { complete: VoiceLlmComplete; logger: AuditLogger; now?: () => number },
): Promise<VoiceVerdict> {
  if (shouldSkip(draft)) return { ok: true };

  const now = deps.now ? deps.now() : Date.now();
  const audit = (summary: string) =>
    deps.logger({
      ts: new Date(now).toISOString(),
      tool: "scopely_voice_judge",
      actor: "system",
      resultSummary: summary,
    });

  const controller = new AbortController();
  const timeoutMs = voiceJudgeTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`voice judge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const completion = deps.complete({
      // Redacted draft: PII/secrets never leave for the third-party judge.
      messages: [{ role: "user", content: redactText(draft, 4000) }],
      model: voiceJudgeModel(),
      maxTokens: 120,
      temperature: 0,
      systemPrompt: VOICE_SYSTEM_PROMPT,
      signal: controller.signal,
      purpose: "scopelybot voice judge",
    });
    // The completion keeps running after losing the race (the abort above is
    // advisory — the callee may ignore the signal); its eventual rejection
    // must never surface as an unhandled rejection.
    completion.catch(() => {});
    const result = await Promise.race([completion, timeout]);
    const guarded = guardJudgeOutput(result.text ?? "");
    if (guarded.kind === "pass") return { ok: true };
    if (guarded.kind === "revise") return { ok: false, instruction: guarded.instruction };
    audit(`fail_open: ${guarded.why}`);
    return { ok: true, failedOpen: guarded.why };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    audit(`fail_open: error: ${why.slice(0, 200)}`);
    return { ok: true, failedOpen: "error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
