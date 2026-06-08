// Confirm-gate execution for cloudflow-support. A human `CONFIRM <code>` reply runs
// the staged action. The LLM is never in the execution path: it cannot fabricate the
// inbound CONFIRM, and the code never passed through it (delivered deterministically
// by stageWrite). Wired into the `before_dispatch` hook in index.ts so it can
// suppress the coordinator (see hub-and-spoke-implementation-guide.md §7).

import type { AuditLogger } from "./audit.js";
import { takePending } from "./pending-confirm.js";

// A staged write's result data is produced only at confirm time (the mutation is
// deferred). Surface a compact, useful tail (a created url, or an id/number) so the
// human gets the actionable result back on confirm — without dumping the full body.
function successDetail(data: unknown): string {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.url === "string" && d.url) return ` ${d.url}`;
    const id = d.id ?? d.number;
    if (typeof id === "string" || typeof id === "number") return ` (id ${id})`;
  }
  return "";
}

export async function tryExecuteConfirm(params: {
  text: string;
  actor: string;
  logger: AuditLogger;
}): Promise<string | null> {
  const m = params.text.trim().match(/^CONFIRM\s+(\d{4})\b/i);
  if (!m) return null;
  const action = takePending(m[1]);
  if (!action) {
    return `No pending action for code ${m[1]} — it may have expired (5 min) or already been used.`;
  }
  const start = Date.now();
  try {
    const res = await action.run();
    params.logger({
      ts: new Date().toISOString(),
      tool: "cf_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      resultSummary: res.ok ? "ok" : `error: ${res.status}`,
      durationMs: Date.now() - start,
    });
    return res.ok
      ? `✅ Done: ${action.summary}.${successDetail(res.data)}`
      : `❌ Failed (HTTP ${res.status}): ${action.summary}. ${JSON.stringify(res.data).slice(0, 200)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.logger({
      ts: new Date().toISOString(),
      tool: "cf_confirm_execute",
      actor: params.actor || "unknown",
      params: { summary: action.summary },
      resultSummary: "error: exception",
      error: msg,
      durationMs: Date.now() - start,
    });
    return `❌ Error executing ${action.summary}: ${msg}`;
  }
}
