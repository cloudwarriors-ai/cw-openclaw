import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { stageWrite } from "./gated.js";
import { opsRead } from "./ops-client.js";
import { opsStageWrite } from "./ops-write-client.js";
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
          "Prepare one native VIP/ZW password-reset request for human confirmation. " +
          "Local allowlisted synthetic accounts only; specify the configured surface_key. " +
          "Confirmation invalidates older links and queues a local fake message, not inbox delivery. " +
          "Password and login lockouts change only after the user redeems the native reset link. " +
          "Look up the native user_id first. Optional email must match the current target.",
        parameters: Type.Object(
          {
            user_id: Type.Integer({ minimum: 1, maximum: 2147483647 }),
            surface_key: Type.String({ minLength: 1, maxLength: 64 }),
            email: Type.Optional(Type.String({ minLength: 1, maxLength: 254 })),
          },
          { additionalProperties: true },
        ),
        execute: (_id: string, params: Record<string, unknown>) =>
          opsStageWrite("identity.users.request_reset", params),
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
          "Stage a native VIP/ZW global account activation change for human confirmation. " +
          "Local allowlisted synthetic users only. The preview explains account-wide access and token effects; " +
          "does not change roles or organization membership.",
        parameters: Type.Object(
          {
            user_id: Type.Integer({ minimum: 1, description: "Native VIP/ZW user id" }),
            is_active: Type.Boolean({
              description: "true = activate, false = deactivate globally",
            }),
          },
          { additionalProperties: true },
        ),
        execute: (_id: string, params: Record<string, unknown>) =>
          opsStageWrite("identity.users.set_active", params),
      },
      logger,
    ),
  );

  // 3) Inspect an exact native account and its actual memberships (read-only).
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_get_user",
        description:
          "Inspect one exact native VIP/ZW user_id, including an inactive target, plus actual organization " +
          "memberships. Active platform admin required; global support scope. Find candidate IDs with " +
          "scopely_list_users first. The user header stays on every page; items are membership rows, " +
          "paged by limit/offset and next_offset. Native roles and organization status are facts, not " +
          "write eligibility. No legacy role, session count/history or lockout dossier is supplied; " +
          "unsupported_fields names these gaps. No account changes occur.",
        parameters: Type.Object(
          {
            user_id: Type.Integer({
              minimum: 1,
              maximum: 2147483647,
              description: "Exact native VIP/ZW user ID",
            }),
            limit: Type.Optional(
              Type.Integer({
                minimum: 1,
                maximum: 50,
                description: "Membership rows; default 25, may be byte-limited",
              }),
            ),
            offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
          },
          { additionalProperties: true },
        ),
        execute: opsRead,
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
          "Prepare one native VIP/ZW standard-user invitation for human confirmation. " +
          "Local allowlisted synthetic recipients only; supply names, native organization, actual " +
          "inviter_user_id, and configured surface_key. The backend checks the inviter and target. " +
          "Confirmation creates a seven-day native invitation and queues one local fake invitee message; " +
          "no inbox email or administrator copy is sent. Existing accounts/invitations and legacy " +
          "user/org_admin roles are refused; this does not add memberships or resend invitations.",
        parameters: Type.Object(
          {
            email: Type.String({ minLength: 1, maxLength: 254 }),
            first_name: Type.String({ minLength: 1, maxLength: 150 }),
            last_name: Type.String({ minLength: 1, maxLength: 150 }),
            role: Type.Literal("standard"),
            organization: Type.Integer({ minimum: 1, maximum: 2147483647 }),
            inviter_user_id: Type.Integer({ minimum: 1, maximum: 2147483647 }),
            surface_key: Type.String({ minLength: 1, maxLength: 64 }),
          },
          { additionalProperties: true },
        ),
        execute: (_id: string, params: Record<string, unknown>) =>
          opsStageWrite("identity.invites.create", params),
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
