// Confirm-gate execution for scopelybot. A human `CONFIRM <code>` reply runs the
// staged action. The LLM is never in the execution path: it cannot fabricate the
// inbound CONFIRM, and the code never passed through it (delivered deterministically
// by stageWrite). Wired into the `before_dispatch` hook in index.ts so it can
// suppress the coordinator. Same module shape as the other gated bots
// (bigheadbot/pulsebot/zws/cloudflow-support/external-org-autopilot).

import type { AuditLogger } from "./audit.js";
import { takePending } from "./pending-confirm.js";

// Called from the before_dispatch handler. If the inbound text is `CONFIRM <code>`
// for a live pending action, execute it and return a human-readable result string.
// Returns null when the message is not a confirm (so normal handling continues).
export async function tryExecuteConfirm(params: {
  text: string;
  actor: string;
  conversationId: string;
  logger: AuditLogger;
}): Promise<string | null> {
  const m = params.text.trim().match(/^CONFIRM\s+(\d{4})\b/i);
  if (!m) return null;
  // Channel-scoped: only consumes an action staged for THIS conversation.
  const action = takePending(m[1], params.conversationId);
  if (!action) {
    return `No pending action for code ${m[1]} — it may have expired (5 min), already been used, or was requested in a different channel.`;
  }
  const start = Date.now();
  try {
    const res = await action.run();
    params.logger({
      ts: new Date().toISOString(),
      tool: "scopely_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      resultSummary: res.ok ? "ok" : `error: ${res.status}`,
      durationMs: Date.now() - start,
    });
    return res.ok
      ? `✅ Done: ${action.summary}.`
      : `❌ Failed (HTTP ${res.status}): ${action.summary}. ${JSON.stringify(res.data).slice(0, 200)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.logger({
      ts: new Date().toISOString(),
      tool: "scopely_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      resultSummary: "error: exception",
      error: msg,
      durationMs: Date.now() - start,
    });
    return `❌ Error executing ${action.summary}: ${msg}`;
  }
}
