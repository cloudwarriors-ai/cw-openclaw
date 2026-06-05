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

  // 3) Get a single user dossier (read-only)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_get_user",
        description:
          "Get a single Scopely VIP user's full dossier (profile + recent sessions + session count). " +
          "Read-only — runs immediately, no confirm needed. Use this before any user mutation to verify " +
          "you have the right person. Look up the user id first with scopely_list_users.",
        parameters: Type.Object({
          user_id: Type.Number({ description: "Numeric user id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const userId = params.user_id as number;
            const res = await scopelyFetch(`/api/auth/users/${userId}/detail/`);
            return jsonResult({ ok: res.ok, status: res.status, data: res.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // 4) List org invites (read-only)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_invites",
        description:
          "List Scopely VIP organization invites. Read-only — runs immediately, no confirm needed. " +
          "Use this to answer 'did we already invite this person?' before creating a new invite.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const res = await scopelyFetch(`/api/auth/invites/`);
            return jsonResult({ ok: res.ok, status: res.status, data: res.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // 5) List access requests (read-only)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_access_requests",
        description:
          "List pending and reviewed Scopely VIP access requests (platform staff view). Read-only — " +
          "runs immediately, no confirm needed. Use this to triage the onboarding queue before " +
          "approving or rejecting a request with scopely_approve_access_request / scopely_reject_access_request.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const res = await scopelyFetch(`/api/auth/access-requests/`);
            return jsonResult({ ok: res.ok, status: res.status, data: res.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // 6) Update a user record (confirm-gated)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_update_user",
        description:
          "Update a Scopely VIP user's role, organization, or profile fields (admin action). You ARE " +
          "authorized — CALL this tool, do NOT defer to the admin UI. It is safe: it only STAGES the " +
          "change and returns a confirmation code; nothing applies until the requester replies " +
          "`CONFIRM <code>`. Pass only the fields you want to change. Look up the user id first with " +
          "scopely_list_users, and confirm the target with scopely_get_user.",
        parameters: Type.Object({
          user_id: Type.Number({ description: "Numeric user id" }),
          role: Type.Optional(
            Type.String({
              description: "New role (e.g. user, org_admin, power_user, platform_admin)",
            }),
          ),
          organization_id: Type.Optional(
            Type.Number({ description: "Move user to this organization id (platform staff only)" }),
          ),
          first_name: Type.Optional(Type.String({ description: "New first name" })),
          last_name: Type.Optional(Type.String({ description: "New last name" })),
          email: Type.Optional(Type.String({ description: "New email address" })),
          migrate_sessions: Type.Optional(
            Type.Boolean({
              description:
                "When moving orgs, migrate the user's unaffiliated sessions into the new org (platform staff only)",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const userId = params.user_id as number;
            // Build the PATCH body from only the fields the caller supplied, so we
            // never send undefined keys that would blank out existing values.
            const body: Record<string, unknown> = {};
            for (const field of [
              "role",
              "organization_id",
              "first_name",
              "last_name",
              "email",
              "migrate_sessions",
            ] as const) {
              if (params[field] !== undefined) {
                body[field] = params[field];
              }
            }
            if (Object.keys(body).length === 0) {
              return jsonResult({
                ok: false,
                error:
                  "No fields to update — supply at least one of role/organization_id/first_name/last_name/email.",
              });
            }
            const changes = Object.entries(body)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(", ");
            const code = makeCode(codeSeed++ * 7919 + userId);
            const summary = `update user id ${userId}: ${changes}`;
            putPending({
              code,
              summary,
              run: () =>
                scopelyFetch(`/api/auth/users/${userId}/`, {
                  method: "PATCH",
                  body: JSON.stringify(body),
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

  // 7) Create an org invite (confirm-gated)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_create_invite",
        description:
          "Provision a new Scopely VIP user into an organization and send a setup email (admin action). " +
          "You ARE authorized — CALL this tool, do NOT defer to the admin UI. It is safe: it only STAGES " +
          "the invite and returns a confirmation code; nothing is sent until the requester replies " +
          "`CONFIRM <code>`. Check scopely_list_invites first to avoid duplicate invites.",
        parameters: Type.Object({
          email: Type.String({ description: "Invitee email address" }),
          role: Type.Optional(
            Type.String({ description: "Role for the new user: user or org_admin (default user)" }),
          ),
          organization: Type.Optional(
            Type.Number({
              description: "Organization id to provision into (platform staff for any org)",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const email = (params.email as string)?.trim();
            if (!email) {
              return jsonResult({ ok: false, error: "email is required" });
            }
            const role = (params.role as string) || "user";
            const body: Record<string, unknown> = { email, role };
            if (params.organization !== undefined) {
              body.organization = params.organization;
            }
            const orgPart =
              params.organization !== undefined ? ` into org ${params.organization}` : "";
            const code = makeCode(codeSeed++ * 7919 + email.length);
            const summary = `invite ${email} as ${role}${orgPart}`;
            putPending({
              code,
              summary,
              run: () =>
                scopelyFetch(`/api/auth/invites/create/`, {
                  method: "POST",
                  body: JSON.stringify(body),
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

  // 8) Approve an access request (confirm-gated)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_approve_access_request",
        description:
          "Approve a pending Scopely VIP access request, provisioning the user and emailing setup " +
          "credentials (platform staff action). You ARE authorized — CALL this tool, do NOT defer to the " +
          "admin UI. It is safe: it only STAGES the approval and returns a confirmation code; nothing " +
          "happens until the requester replies `CONFIRM <code>`. List the queue first with " +
          "scopely_list_access_requests to get the request id. An organization id is required.",
        parameters: Type.Object({
          request_id: Type.Number({
            description: "Access request id (from scopely_list_access_requests)",
          }),
          organization: Type.Number({ description: "Organization id to provision the user into" }),
          role: Type.Optional(
            Type.String({ description: "Role for the new user: user or org_admin (default user)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const requestId = params.request_id as number;
            const organization = params.organization as number;
            const role = (params.role as string) || "user";
            const code = makeCode(codeSeed++ * 7919 + requestId);
            const summary = `APPROVE access request ${requestId} → org ${organization} as ${role}`;
            putPending({
              code,
              summary,
              run: () =>
                scopelyFetch(`/api/auth/access-requests/${requestId}/approve/`, {
                  method: "POST",
                  body: JSON.stringify({ organization, role }),
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

  // 9) Reject an access request (confirm-gated)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_reject_access_request",
        description:
          "Reject a pending Scopely VIP access request (platform staff action). You ARE authorized — " +
          "CALL this tool, do NOT defer to the admin UI. It is safe: it only STAGES the rejection and " +
          "returns a confirmation code; nothing happens until the requester replies `CONFIRM <code>`. " +
          "List the queue first with scopely_list_access_requests to get the request id.",
        parameters: Type.Object({
          request_id: Type.Number({
            description: "Access request id (from scopely_list_access_requests)",
          }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const requestId = params.request_id as number;
            const code = makeCode(codeSeed++ * 7919 + requestId);
            const summary = `REJECT access request ${requestId}`;
            putPending({
              code,
              summary,
              run: () =>
                scopelyFetch(`/api/auth/access-requests/${requestId}/reject/`, {
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
