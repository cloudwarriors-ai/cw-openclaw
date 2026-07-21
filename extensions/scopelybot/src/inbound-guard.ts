// Inbound guard for scopelybot (Slice S2-B) — the deterministic ingress half
// of the supervisor: every message entering the bot's Zoom surface is
// screened BEFORE dispatch. Deterministic regex only, BY CONSTRAINT: the
// before_dispatch hook has no harness timeout (src/plugins/hooks.ts omits it
// from the modifying-hook timeout table), so a slow check here would block the
// bot's entire reply path — no network, no model calls (also the
// evidence-backed choice: OWASP LLM01's own mitigation ordering is
// deterministic-code-first; see docs/reference/supervisor-v2-research.md Q1).
//
// Three action tiers (rate limit added in Slice E P4, own flag):
//   - RATE LIMIT (handled:true + deterministic throttle text): per-sender
//     sliding window (SCOPELYBOT_RATE_LIMIT=1). Never applies to CONFIRM
//     replies — a staged-write confirmation must always reach the gate.
//   - HARD BLOCK (handled:true + deterministic refusal): asks for the bot to
//     produce/reveal a CONFIRM code. The IDENTITY layer already refuses these
//     (S20 live-fire), but that refusal is model-dependent — this makes it
//     structural. The refusal text is delivered threaded by core, the same
//     path the confirm gate's result text uses.
//   - SIGNAL (audit-log only, message flows through): prompt-injection
//     phrasings and inbound secret-paste. No suppression — the hook cannot
//     rewrite content (before_dispatch returns {handled, text}, no mutation),
//     and blocking a mixed message would kill the legitimate request in it.
//     The log gives the security trail; egress checks still guard the reply.
//
// NEVER claims a `CONFIRM <code>` reply: the confirm gate (registered before
// this handler in index.ts — hook order within a plugin is registration
// order) owns those; we structurally skip them as defense in depth.

import type { AuditLogger } from "./audit.js";

// Mirrors the matcher in index.ts / confirm.ts so the skip is byte-consistent.
const CONFIRM_REPLY_RE = /^CONFIRM\s+\d{4}\b/i;

// Opt-in via env, same rollout pattern as the supervisor flags: unset/0 =
// guard disabled, handler is a no-op (byte-identical legacy behavior).
export function inboundGuardEnabled(): boolean {
  return process.env.SCOPELYBOT_INBOUND_GUARD === "1";
}

// --- hard block: confirm-code fabrication asks ------------------------------
// Narrow on purpose: only fire when the sender asks the BOT to produce,
// reveal, or exemplify a confirmation code. Mentions of codes in other
// contexts ("my code expired", "the code didn't work") must flow through —
// a false positive here suppresses a legitimate turn, the costlier error.
const CONFIRM_FABRICATION_RES: RegExp[] = [
  // "give/send/tell/show/generate/... me a confirm(ation) code"
  /\b(?:give|send|tell|show|write|generate|create|fabricate|invent|make\s+up|provide|output|post|reveal)\b[^.?!\n]{0,60}\bconfirm(?:ation)?\s*code/i,
  // "what is/what's the confirm(ation) code"
  /\bwhat(?:'s|\s+is)\s+(?:the|a|my)\s+confirm(?:ation)?\s*code/i,
  // "example ... confirm(ation) code" / "confirm(ation) code ... example"
  // (the S20 documentation-example provocation shape)
  /\bexample\b[^.?!\n]{0,60}\bconfirm(?:ation)?\s*code/i,
  /\bconfirm(?:ation)?\s*code\b[^.?!\n]{0,60}\bexample/i,
];

const CONFIRM_FABRICATION_REFUSAL =
  "I can't provide or invent confirmation codes. When a change is staged, the system posts " +
  "the confirmation prompt to this channel itself — only that code works, only within its " +
  "expiry window, and only from an authorized approver.";

// --- signals: logged, never suppressed --------------------------------------
// Prompt-injection phrasings. Signal-only: operator traffic legitimately
// contains system-like text (the NeMo false-positive caveat), so these are a
// security trail, not a gate.
const INJECTION_SIGNAL_RES: Array<{ id: string; re: RegExp }> = [
  {
    id: "ignore_instructions",
    re: /\b(?:ignore|disregard|forget)\b[^.?!\n]{0,40}\b(?:previous|prior|above|your)\s+(?:instructions?|rules?|prompt)/i,
  },
  {
    id: "role_override",
    re: /\byou\s+are\s+now\b|\bact\s+as\s+(?:the\s+)?system\b|\bpretend\s+(?:to\s+be|you(?:'re|\s+are))\b/i,
  },
  {
    id: "prompt_exfil",
    re: /\b(?:reveal|show|print|repeat|output)\b[^.?!\n]{0,40}\b(?:system\s+prompt|instructions?|identity\s*(?:\.md|file))/i,
  },
];

// Inbound secret shapes — someone pasted a credential into the channel.
// Logged so it can be rotated; never blocks (it's already exposed in Zoom).
const INBOUND_SECRET_RES: Array<{ id: string; re: RegExp }> = [
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{25,}/ },
  { id: "api_key", re: /\bsk-[A-Za-z0-9]{20,}/ },
];

// --- rate limit (Slice E P4) -------------------------------------------------
// Per-sender sliding window, deterministic and in-memory. Flag-gated
// separately from the guard so ops can tune exposure per surface. CONFIRM
// replies are never rate-limited (the skip above runs first): a human
// confirming a staged write must always reach the gate.
export function rateLimitEnabled(): boolean {
  return process.env.SCOPELYBOT_RATE_LIMIT === "1";
}
function rateLimitMax(): number {
  const raw = Number(process.env.SCOPELYBOT_RATE_LIMIT_N ?? "10");
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
}
function rateLimitWindowMs(): number {
  const raw = Number(process.env.SCOPELYBOT_RATE_LIMIT_WINDOW_MS ?? String(60_000));
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

const RATE_LIMIT_TEXT =
  "You're sending requests faster than I can process them — give me a moment to catch up, " +
  "then try again.";

// senderId → recent message timestamps. Bounded: entries older than the
// window are pruned per hit; the map itself is pruned past 500 senders.
const senderHits = new Map<string, number[]>();

function isRateLimited(senderId: string, now: number): boolean {
  const windowStart = now - rateLimitWindowMs();
  const hits = (senderHits.get(senderId) ?? []).filter((t) => t >= windowStart);
  hits.push(now);
  senderHits.set(senderId, hits);
  if (senderHits.size > 500) {
    const oldest = senderHits.keys().next().value;
    if (oldest !== undefined) senderHits.delete(oldest);
  }
  return hits.length > rateLimitMax();
}

// Test hook: clear rate-limit state between cases.
export function resetInboundGuardStateForTest(): void {
  senderHits.clear();
}

export type InboundGuardResult = { handled: true; text: string } | undefined;

// Screen one inbound message. Caller (index.ts) has already proven the
// message belongs to scopelybot's own Zoom surface. Returns a claim result
// for hard blocks; undefined lets the message flow to the coordinator.
export function guardInboundMessage(
  params: { text: string; senderId: string; sessionKey?: string },
  deps: { logger: AuditLogger; now?: () => number },
): InboundGuardResult {
  const text = params.text ?? "";
  if (!text.trim()) return undefined;
  // A CONFIRM reply belongs to the confirm gate — never claim, log, or
  // rate-limit it here.
  if (CONFIRM_REPLY_RE.test(text.trim())) return undefined;

  const now = deps.now ? deps.now() : Date.now();
  const log = (signal: string, action: "blocked" | "flagged") =>
    deps.logger({
      ts: new Date(now).toISOString(),
      tool: "scopely_inbound_guard",
      actor: params.senderId,
      params: { signal, sessionKey: params.sessionKey ?? "" },
      resultSummary: `${action}: ${signal}`,
    });

  // Rate limit (P4, own flag): deterministic per-sender window. Runs before
  // the content checks — a flooding sender gets the throttle text, not a
  // model dispatch.
  if (rateLimitEnabled() && params.senderId && isRateLimited(params.senderId, now)) {
    log("rate_limited", "blocked");
    return { handled: true, text: RATE_LIMIT_TEXT };
  }

  if (!inboundGuardEnabled()) return undefined;

  // Hard block: confirm-code fabrication.
  if (CONFIRM_FABRICATION_RES.some((re) => re.test(text))) {
    log("confirm_fabrication_ask", "blocked");
    return { handled: true, text: CONFIRM_FABRICATION_REFUSAL };
  }

  // Signals: log every match, let the message through.
  for (const { id, re } of INJECTION_SIGNAL_RES) {
    if (re.test(text)) log(`injection:${id}`, "flagged");
  }
  for (const { id, re } of INBOUND_SECRET_RES) {
    if (re.test(text)) log(`secret_paste:${id}`, "flagged");
  }
  return undefined;
}
