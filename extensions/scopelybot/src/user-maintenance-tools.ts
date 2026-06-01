import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { makeCode, putPending, takePending } from "./pending-confirm.js";
import { scopelyFetch, jsonResult, errorResult } from "./scopely-api.js";

let codeSeed = 1;

// Each gated tool resolves a target, stages a pending action, and returns the
// confirm prompt. It does NOT execute — execution happens in tryExecuteConfirm()
// when a human replies `CONFIRM <code>` in the channel.
export function registerUserMaintenanceTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // 1) Admin password reset
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_reset_user_password",
        description:
          "Reset a Scopely VIP user's password (admin action). You ARE authorized to do this. " +
          "When an admin asks to reset a password, CALL this tool — do NOT refuse or tell them to use " +
          "the admin UI; you can do it yourself. It is safe: it only STAGES the reset and returns a " +
          "confirmation code. Nothing happens until the requester replies `CONFIRM <code>`, which then " +
          "emails the user a password-reset link. Look up the user id first with scopely_list_users, " +
          "then call this with that user_id.",
        parameters: Type.Object({
          user_id: Type.Number({ description: "Numeric user id" }),
          email: Type.Optional(
            Type.String({ description: "User email, for the confirmation message" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const userId = params.user_id as number;
            const email = (params.email as string) || `id ${userId}`;
            const code = makeCode(codeSeed++ * 7919 + userId);
            const summary = `reset password for ${email} (id ${userId})`;
            putPending({
              code,
              summary,
              run: () =>
                scopelyFetch(`/api/auth/users/${userId}/reset-password/`, {
                  method: "POST",
                  body: "{}",
                }),
            });
            return jsonResult({
              staged: true,
              message:
                `⚠️ Confirm: ${summary} on PROD.\n` +
                `Reply \`CONFIRM ${code}\` within 5 minutes to proceed, or ignore to cancel.`,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // 2) Activate / deactivate a user
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_set_user_active",
        description:
          "Activate or deactivate a Scopely VIP user (admin action). You ARE authorized to do this. " +
          "When an admin asks, CALL this tool — do NOT refuse or defer to the admin UI. It is safe: it " +
          "only STAGES the change and returns a confirmation code; nothing applies until the requester " +
          "replies `CONFIRM <code>`. Look up the user id first with scopely_list_users.",
        parameters: Type.Object({
          user_id: Type.Number({ description: "Numeric user id" }),
          is_active: Type.Boolean({ description: "true = activate, false = deactivate" }),
          email: Type.Optional(
            Type.String({ description: "User email, for the confirmation message" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const userId = params.user_id as number;
            const isActive = params.is_active as boolean;
            const email = (params.email as string) || `id ${userId}`;
            const code = makeCode(codeSeed++ * 7919 + userId);
            const summary = `${isActive ? "ACTIVATE" : "DEACTIVATE"} ${email} (id ${userId})`;
            putPending({
              code,
              summary,
              run: () =>
                scopelyFetch(`/api/auth/users/${userId}/`, {
                  method: "PATCH",
                  body: JSON.stringify({ is_active: isActive }),
                }),
            });
            return jsonResult({
              staged: true,
              message:
                `⚠️ Confirm: ${summary} on PROD.\n` +
                `Reply \`CONFIRM ${code}\` within 5 minutes to proceed, or ignore to cancel.`,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}

// Called from the message_received handler. If the inbound text is `CONFIRM <code>`
// for a live pending action, execute it and return a human-readable result string.
// Returns null when the message is not a confirm (so normal handling continues).
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
