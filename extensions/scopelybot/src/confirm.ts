// Confirm-gate execution for scopelybot. A human `CONFIRM <code>` reply runs the
// staged action. The LLM is never in the execution path: it cannot fabricate the
// inbound CONFIRM, and the code never passed through it (delivered deterministically
// by stageWrite). Wired into the `before_dispatch` hook in index.ts so it can
// suppress the coordinator. Same module shape as the other gated bots
// (bigheadbot/pulsebot/zws/cloudflow-support/external-org-autopilot).

import type { AuditLogger } from "./audit.js";
import { auditBackendEvent, readBackendProfile } from "./backend-profile.js";
import { isCurrentApprover } from "./ops-roster-client.js";
import { takePending } from "./pending-confirm.js";
import { redactText } from "./redaction.js";

// Only an exact code command is deterministic approval; ordinary confirm prose
// and malformed codes remain normal requests; neither consumes a pending action.
// The model may prepare a change, but only this exact command can execute one.
const CONFIRM_LINE = /^CONFIRM\s+([2-9a-hjkmnp-z]{8}|[a-f0-9]{32})$/i;
export function isConfirmCommand(text: string): boolean {
  return CONFIRM_LINE.test(text.trim());
}

function uncertainBundleItem(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  const item = value as { ok?: boolean; status?: number };
  return (
    item.ok !== true && (typeof item.status !== "number" || item.status < 400 || item.status >= 500)
  );
}

// Compact, redacted extract of a backend error body so a failed confirm
// explains itself. Live gap 2026-07-21: a category-validation 400 surfaced
// as a bare "Failed (HTTP 400)" — the backend's message ("Category must be
// one of: …") never reached the human, who had no way to know WHY without
// server logs. Handles DRF shapes ({field: [msgs]}, {detail: "…"}) and
// plain-text bodies; HTML error pages are dropped (noise, not signal).
// CALLERS surface this for 4xx ONLY: client-error bodies are validation
// feedback meant for the requester, while 5xx bodies are server internals
// (stack traces, proxies' HTML) and stay hidden — pinned by the existing
// "hides backend failure bodies" 502 test.
export function formatBackendErrorDetail(data: unknown): string {
  if (!data) {
    return "";
  }
  let text = "";
  if (typeof data === "string") {
    text = data;
  } else if (typeof data === "object" && !Array.isArray(data)) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(data as Record<string, unknown>).slice(0, 3)) {
      const msg = Array.isArray(value)
        ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ")
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
      parts.push(key === "detail" ? msg : `${key}: ${msg}`);
    }
    text = parts.join("; ");
  } else if (Array.isArray(data)) {
    text = data.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
  }
  if (/^\s*</.test(text)) {
    return "";
  } // HTML error page — no useful detail
  return redactText(text, 400).trim();
}

// Called from the before_dispatch handler. If the inbound text is `CONFIRM <code>`
// for a live pending action, execute it and return a human-readable result string.
// Returns null when the message is not a confirm (so normal handling continues).
export async function tryExecuteConfirm(params: {
  text: string;
  actor: string;
  conversationId: string;
  channelId?: string;
  sessionKey?: string;
  logger: AuditLogger;
}): Promise<string | null> {
  const m = params.text.trim().match(CONFIRM_LINE);
  if (!m) {
    return null;
  }
  // Refuse locally before any authority request, then recheck after awaiting it.
  if (readBackendProfile().mode !== "read-write") {
    auditBackendEvent("write_blocked_read_only", { via: "confirm" });
    return "Changes are paused: the bot is read-only, so nothing was run.";
  }
  // Check identity before touching the pending store. An unauthorized user in
  // the correct channel cannot execute OR consume a valid pending action.
  if (!(await isCurrentApprover(params.actor))) {
    return "Write confirmation is not authorized for this Zoom identity.";
  }
  // READ-ONLY REFUSAL (INV-2/INV-8): re-check the live profile before touching
  // the pending store. An action staged while the profile was read-write must
  // not run after the owner switched to read-only or threw the kill switch.
  if (readBackendProfile().mode !== "read-write") {
    auditBackendEvent("write_blocked_read_only", { via: "confirm" });
    return "Changes are paused: the bot is read-only, so nothing was run.";
  }
  // The host preserves the Zoom channel JID in dispatch conversationId even
  // for thread-scoped sessions. An agent prefix alone cannot prove that channel.
  const action = takePending(m[1].toLowerCase(), { conversationId: params.conversationId });
  if (!action) {
    return "No pending action for that confirmation — it may have expired (5 min), already been used, or was requested in a different channel.";
  }
  const start = Date.now();
  try {
    const res = await action.run({ actor: params.actor });
    const bundle = res.data as { bundle?: boolean; applied?: number; results?: unknown[] } | null;
    const uncertain =
      !res.ok &&
      (res.status < 400 ||
        res.status >= 500 ||
        (bundle?.bundle === true &&
          Array.isArray(bundle.results) &&
          bundle.results.some(uncertainBundleItem)) ||
        (res.data !== null &&
          typeof res.data === "object" &&
          "code" in res.data &&
          res.data.code === "outcome_unknown"));
    params.logger({
      ts: new Date().toISOString(),
      tool: "scopely_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      ...(action.backendAction ? { backendAction: action.backendAction } : {}),
      resultSummary: uncertain ? "outcome_unknown" : res.ok ? "ok" : `error: ${res.status}`,
      ...(uncertain ? { error: "confirmation_outcome_unknown" } : {}),
      durationMs: Date.now() - start,
    });
    if (res.ok) {
      return `✅ Done: ${action.displaySummary ?? action.summary}.`;
    }
    // Bundled confirms (gated.ts coalescing) report per-item outcomes on
    // failure: HTTP ops are not transactional, so the human must see exactly
    // which items applied and which did not — a bare "Failed" would hide a
    // partial application.
    if (bundle && bundle.bundle === true && Array.isArray(bundle.results)) {
      const lines = bundle.results
        .slice(0, 10)
        .map((r) => {
          const item = r as { summary: string; ok: boolean; status: number; detail?: string };
          if (item.ok) {
            return `✅ ${item.summary}`;
          }
          if (uncertainBundleItem(item)) {
            return `⚠️ ${item.summary} (HTTP ${item.status}) — outcome unknown`;
          }
          const itemDetail = item.detail ? ` — ${item.detail}` : "";
          return `❌ ${item.summary} (HTTP ${item.status})${itemDetail}`;
        })
        .join("\n");
      const warning = uncertain
        ? "\nThese are confirmed successes; remaining outcomes may be unknown. Inspect and reconcile the existing pending action and audit. Do not retry blindly."
        : "";
      return `⚠️ Applied ${bundle.applied ?? 0} of ${bundle.results.length}:\n${lines}${warning}`;
    }
    if (uncertain) {
      return `⚠️ Outcome unknown (HTTP ${res.status}): ${action.summary}. Inspect and reconcile the existing pending action and audit before a new request. Do not retry blindly.`;
    }
    const detail = res.status >= 400 && res.status < 500 ? formatBackendErrorDetail(res.data) : "";
    return `❌ Failed (HTTP ${res.status}): ${action.summary}.${detail ? ` — ${detail}` : ""}`;
  } catch {
    params.logger({
      ts: new Date().toISOString(),
      tool: "scopely_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      ...(action.backendAction ? { backendAction: action.backendAction } : {}),
      resultSummary: "outcome_unknown",
      error: "confirmation_outcome_unknown",
      durationMs: Date.now() - start,
    });
    return `⚠️ Outcome unknown: ${action.summary}. Inspect and reconcile the existing pending action and audit before a new request. Do not retry blindly.`;
  }
}
