// Chat-operable write-approver management, riding the standard confirm gate.
//
// Granting approver access is privilege escalation, so it gets the STRONGEST gate
// we have: the grant/revoke tools only STAGE (stageWrite), and tryExecuteConfirm
// only executes a CONFIRM from someone already on the approver list. Net effect:
// anyone may ASK the bot to grant access, but only an existing approver's CONFIRM
// makes it real — the LLM is never in the execution path, same invariant as every
// other gated write.

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ApproverStore } from "./approver-store.js";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { stageWrite } from "./gated.js";
import { errorResult, jsonResult } from "./scopely-api.js";

// Human-readable handle for prompts and listings. Full email addresses are
// redacted by the boundary redactor (redaction.ts) in both confirm prompts and
// tool results, so we surface the local part — a person's handle, not an
// address — alongside the Zoom operator id for verification.
function displayName(email: string | undefined): string | undefined {
  const local = email?.split("@")[0]?.trim();
  return local || undefined;
}

export function registerApproverTools(
  api: OpenClawPluginApi,
  logger: AuditLogger,
  store: ApproverStore,
) {
  // 1) List approvers (read-only)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_approvers",
        description:
          "List who can approve staged ScopelyBot writes (reply CONFIRM to confirmation codes). " +
          "Read-only — runs immediately, no confirm needed. Shows config-seeded approvers (permanent) " +
          "and chat-granted approvers (revocable with scopely_revoke_approver).",
        parameters: Type.Object({}),
        async execute() {
          try {
            return jsonResult({
              ok: true,
              configured: store.configuredIds().map((id) => ({
                operatorId: id,
                display: displayName(store.emailForOperatorId(id)),
              })),
              granted: store.listGrants().map((g) => ({
                ...g,
                display: displayName(g.email),
              })),
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // 2) Grant approver access (confirm-gated)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_grant_approver",
        description:
          "Grant a person the ability to approve staged ScopelyBot writes (reply CONFIRM to " +
          "confirmation codes) — admin action. You ARE authorized to do this. CALL this tool when an " +
          "admin asks to make someone an approver; do NOT refuse. It is safe: it only STAGES the grant " +
          "and posts a confirmation code, and ONLY someone who is ALREADY an approver can execute it " +
          "by replying `CONFIRM <code>`. Identify the person by their work email. If the person has " +
          "never posted a message in this channel the bot cannot resolve their Zoom identity yet — " +
          "they must post any message first.",
        parameters: Type.Object({
          email: Type.String({ description: "Work email of the person to grant approver access" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const email = String(params.email ?? "")
              .trim()
              .toLowerCase();
            if (!email || !email.includes("@")) {
              return jsonResult({ ok: false, error: "A valid email is required." });
            }
            const operatorId = store.resolveOperatorId(email);
            if (!operatorId) {
              return jsonResult({
                ok: false,
                error:
                  `Cannot resolve a Zoom identity for ${email} — the bot has not seen a channel ` +
                  "message from them yet. Ask them to post any message in this channel, then retry.",
              });
            }
            if (store.approverIds().includes(operatorId.toLowerCase())) {
              return jsonResult({ ok: true, note: `${email} is already an approver.` });
            }
            // Lead with the local-part handle: the boundary redactor masks the full
            // address in the delivered prompt, and the approver must be able to see
            // WHO they are granting.
            const summary = `grant write-approver access to ${displayName(email)} (${email}, Zoom id ${operatorId})`;
            // The run closure re-resolves nothing: identity was pinned at stage time and
            // is named in the confirm prompt, so the approver confirms exactly what runs.
            // `grantedBy` records the operator_id of the approver whose CONFIRM executed
            // the grant (passed through by tryExecuteConfirm).
            return await stageWrite(summary, async (ctx) => {
              const added = store.grant({
                operatorId,
                email,
                grantedBy: ctx?.actor ?? "unknown",
              });
              return added
                ? { ok: true, status: 200, data: { granted: email, operatorId } }
                : { ok: false, status: 409, data: { error: "already an approver" } };
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // 3) Revoke chat-granted approver access (confirm-gated)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_revoke_approver",
        description:
          "Revoke a chat-granted ScopelyBot write-approver (admin action). You ARE authorized — CALL " +
          "this tool, do NOT refuse. It is safe: it only STAGES the revocation and posts a confirmation " +
          "code; only an existing approver's `CONFIRM <code>` executes it. Config-seeded approvers " +
          "cannot be revoked from chat. Identify the person by their work email.",
        parameters: Type.Object({
          email: Type.String({ description: "Work email of the approver to revoke" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const email = String(params.email ?? "")
              .trim()
              .toLowerCase();
            if (!email || !email.includes("@")) {
              return jsonResult({ ok: false, error: "A valid email is required." });
            }
            const entry = store.listGrants().find((g) => g.email === email);
            if (!entry) {
              const operatorId = store.resolveOperatorId(email);
              if (operatorId && store.configuredIds().includes(operatorId.toLowerCase())) {
                return jsonResult({
                  ok: false,
                  error:
                    `${email} is a config-seeded approver — remove them by editing the deployment ` +
                    "config (openclaw.json), not from chat.",
                });
              }
              return jsonResult({ ok: false, error: `${email} is not a chat-granted approver.` });
            }
            const summary = `revoke write-approver access from ${displayName(email)} (${email}, Zoom id ${entry.operatorId})`;
            return await stageWrite(summary, async () => {
              const res = store.revoke(entry.operatorId);
              return res.removed
                ? { ok: true, status: 200, data: { revoked: email } }
                : { ok: false, status: 409, data: { error: res.reason } };
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
