import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { stageWrite } from "./gated.js";
import { scopelyFetch, jsonResult, errorResult } from "./scopely-api.js";

// Each gated tool resolves a target and stages a pending action via stageWrite(),
// which posts the confirm prompt (with code) to the channel deterministically. It
// does NOT execute — execution happens in tryExecuteConfirm() when a human replies
// `CONFIRM <code>`, consumed in the before_dispatch hook (extensions/scopelybot/index.ts).
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
            const summary = `reset password for ${email} (id ${userId})`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/auth/users/${userId}/reset-password/`, {
                method: "POST",
                body: "{}",
              }),
            );
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
            const summary = `${isActive ? "ACTIVATE" : "DEACTIVATE"} ${email} (id ${userId})`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/auth/users/${userId}/`, {
                method: "PATCH",
                body: JSON.stringify({ is_active: isActive }),
              }),
            );
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
            const summary = `update user id ${userId}: ${changes}`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/auth/users/${userId}/`, {
                method: "PATCH",
                body: JSON.stringify(body),
              }),
            );
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
            const summary = `invite ${email} as ${role}${orgPart}`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/auth/invites/create/`, {
                method: "POST",
                body: JSON.stringify(body),
              }),
            );
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
            const summary = `APPROVE access request ${requestId} → org ${organization} as ${role}`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/auth/access-requests/${requestId}/approve/`, {
                method: "POST",
                body: JSON.stringify({ organization, role }),
              }),
            );
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
            const summary = `REJECT access request ${requestId}`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/auth/access-requests/${requestId}/reject/`, {
                method: "POST",
                body: "{}",
              }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
