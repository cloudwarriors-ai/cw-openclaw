// Confirm-gate execution for scopelybot. A human `CONFIRM <code>` reply runs the
// staged action. The LLM is never in the execution path: it cannot fabricate the
// inbound CONFIRM, and the code never passed through it (delivered deterministically
// by stageWrite). Wired into the `before_dispatch` hook in index.ts so it can
// suppress the coordinator. Same module shape as the other gated bots
// (bigheadbot/pulsebot/zws/cloudflow-support/external-org-autopilot).

import type { AuditLogger } from "./audit.js";
import { takePending } from "./pending-confirm.js";
import { redactText } from "./redaction.js";
import { isScopelyBotZoomMessage } from "./zoom-format.js";

export function isApprovedWriteActor(actor: string, approverIds: string[]): boolean {
  const normalized = actor.trim().toLowerCase();
  const allowed = new Set(approverIds.map((value) => value.trim().toLowerCase()).filter(Boolean));
  return Boolean(normalized) && allowed.size > 0 && allowed.has(normalized);
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
  if (!data) return "";
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
  if (/^\s*</.test(text)) return ""; // HTML error page — no useful detail
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
  approverIds: string[];
  logger: AuditLogger;
}): Promise<string | null> {
  const m = params.text.trim().match(/^CONFIRM\s+(\d{4})\b/i);
  if (!m) return null;
  // Check identity before touching the pending store. An unauthorized user in
  // the correct channel cannot execute OR consume a valid pending action.
  if (!isApprovedWriteActor(params.actor, params.approverIds)) {
    return "Write confirmation is not authorized for this Zoom identity.";
  }
  // Channel-scoped: only consumes an action staged for THIS conversation. Zoom
  // thread replies dispatch with the thread id as conversationId, so the session
  // key — which proves the message came through ScopelyBot's own Zoom binding —
  // is the accepted channel-binding evidence for threaded CONFIRMs.
  const action = takePending(m[1], {
    conversationId: params.conversationId,
    fromOwnZoomSurface: isScopelyBotZoomMessage({
      channelId: params.channelId ?? "",
      sessionKey: params.sessionKey,
    }),
  });
  if (!action) {
    return `No pending action for code ${m[1]} — it may have expired (5 min), already been used, or was requested in a different channel.`;
  }
  const start = Date.now();
  try {
    const res = await action.run({ actor: params.actor });
    params.logger({
      ts: new Date().toISOString(),
      tool: "scopely_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      resultSummary: res.ok ? "ok" : `error: ${res.status}`,
      durationMs: Date.now() - start,
    });
    if (res.ok) {
      return `✅ Done: ${action.summary}.`;
    }
    // Bundled confirms (gated.ts coalescing) report per-item outcomes on
    // failure: HTTP ops are not transactional, so the human must see exactly
    // which items applied and which did not — a bare "Failed" would hide a
    // partial application.
    const bundle = res.data as { bundle?: boolean; applied?: number; results?: unknown[] } | null;
    if (bundle && bundle.bundle === true && Array.isArray(bundle.results)) {
      const lines = bundle.results
        .slice(0, 10)
        .map((r) => {
          const item = r as { summary: string; ok: boolean; status: number; detail?: string };
          if (item.ok) return `✅ ${item.summary}`;
          const itemDetail = item.detail ? ` — ${item.detail}` : "";
          return `❌ ${item.summary} (HTTP ${item.status})${itemDetail}`;
        })
        .join("\n");
      return `⚠️ Applied ${bundle.applied ?? 0} of ${bundle.results.length}:\n${lines}`;
    }
    const detail = res.status >= 400 && res.status < 500 ? formatBackendErrorDetail(res.data) : "";
    return `❌ Failed (HTTP ${res.status}): ${action.summary}.${detail ? ` — ${detail}` : ""}`;
  } catch (err) {
    const msg = redactText(err instanceof Error ? err.message : String(err), 500);
    params.logger({
      ts: new Date().toISOString(),
      tool: "scopely_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      resultSummary: "error: exception",
      error: msg,
      durationMs: Date.now() - start,
    });
    return `❌ Error executing ${action.summary}.`;
  }
}
