// Deal-workflow verbs for Scopely sessions (plan Slice 3): lifecycle
// transitions, the approval workflow, and session discounts. Every mutation
// only STAGES via stageWrite() — the confirm-gate invariant — and executes
// only on a human `CONFIRM <code>` (before_dispatch, index.ts). The discount
// LIST read is co-located here because it is the id-resolution dependency for
// discount removal (scopelybot-spoke-partitioning-problem.md: keep dependency
// reads next to the verbs that need them).
//
// Backend contracts verified against scopely service/apps/scoping/urls.py and
// views/{sessions,approvals,sow,pricing}.py on 2026-07-21: all lifecycle and
// approval actions are POST with optional {reason}/{comments} bodies;
// discounts are POST {discount_type, value, label?, category?} and DELETE.

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { stageWrite } from "./gated.js";
import { scopelyFetch, jsonResult, errorResult } from "./scopely-api.js";

// Validate and narrow a session id once; every tool below needs it.
function sessionId(params: Record<string, unknown>): number {
  const parsed = Number(params.session_id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("session_id must be a positive integer");
  }
  return parsed;
}

const SESSION_ID_PARAM = Type.Number({ description: "Numeric session id" });

// Shared description tail for staged writes — the phrasing the coordinator
// already responds to correctly (matches user-maintenance-tools.ts).
const STAGED =
  "You ARE authorized — CALL this tool; do NOT refuse or defer to the UI. It is safe: it only " +
  "STAGES the action; nothing happens until the requester replies `CONFIRM <code>`.";

export function registerSessionLifecycleTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // --- lifecycle transitions -----------------------------------------------

  // One registration helper for the four body-free/reason-only POST verbs —
  // they differ only in path, summary verb, and description.
  const lifecycleVerbs: Array<{
    tool: string;
    path: string;
    verb: string;
    description: string;
    withReason: boolean;
  }> = [
    {
      tool: "scopely_cancel_session",
      path: "cancel",
      verb: "CANCEL",
      description:
        "Cancel a Scopely scoping session (awaiting-signature sessions are voided first). " +
        STAGED,
      withReason: true,
    },
    {
      tool: "scopely_archive_session",
      path: "archive",
      verb: "ARCHIVE",
      description:
        "Archive a Scopely session — hidden from active work but SOW/pricing/DocuSign history " +
        "remain recoverable. " +
        STAGED,
      withReason: true,
    },
    {
      tool: "scopely_reopen_session",
      path: "reopen",
      verb: "REOPEN",
      description:
        "Reopen a cancelled or archived Scopely session back into active work. " + STAGED,
      withReason: false,
    },
    {
      tool: "scopely_revise_session",
      path: "revise",
      verb: "REVISE",
      description:
        "Start a revision of a Scopely session (new editable version of a generated deal). " +
        STAGED,
      withReason: false,
    },
    {
      tool: "scopely_clone_session",
      path: "clone",
      verb: "CLONE",
      description:
        "Clone a Scopely session into a new draft with the same configuration. " + STAGED,
      withReason: false,
    },
  ];

  for (const spec of lifecycleVerbs) {
    api.registerTool(() =>
      wrapToolWithAudit(
        {
          name: spec.tool,
          description: spec.description,
          parameters: spec.withReason
            ? Type.Object({
                session_id: SESSION_ID_PARAM,
                reason: Type.Optional(
                  Type.String({ description: "Reason, recorded in the audit trail" }),
                ),
              })
            : Type.Object({ session_id: SESSION_ID_PARAM }),
          async execute(_id: string, params: Record<string, unknown>) {
            try {
              const id = sessionId(params);
              const reason =
                spec.withReason && typeof params.reason === "string" ? params.reason : "";
              const summary = `${spec.verb} session ${id}${reason ? ` (reason: ${reason})` : ""}`;
              return await stageWrite(summary, () =>
                scopelyFetch(`/api/sessions/${id}/${spec.path}/`, {
                  method: "POST",
                  body: JSON.stringify(reason ? { reason } : {}),
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

  // --- approval workflow ---------------------------------------------------

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_request_session_approval",
        description:
          "Submit a priced Scopely session for manager approval (required above the approval " +
          "threshold before SOW generation). " +
          STAGED,
        parameters: Type.Object({ session_id: SESSION_ID_PARAM }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            return await stageWrite(`request approval for session ${id}`, () =>
              scopelyFetch(`/api/sessions/${id}/request-approval/`, { method: "POST", body: "{}" }),
            );
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  for (const spec of [
    {
      tool: "scopely_approve_session",
      path: "approve",
      verb: "APPROVE",
      description:
        "Approve a Scopely session's pending approval request so the deal can proceed to SOW. " +
        STAGED +
        " Pending requests: scopely_pending_approvals.",
    },
    {
      tool: "scopely_reject_session",
      path: "reject",
      verb: "REJECT",
      description:
        "Reject a Scopely session's pending approval request, sending it back to the rep. " +
        STAGED +
        " Pending requests: scopely_pending_approvals.",
    },
  ]) {
    api.registerTool(() =>
      wrapToolWithAudit(
        {
          name: spec.tool,
          description: spec.description,
          parameters: Type.Object({
            session_id: SESSION_ID_PARAM,
            comments: Type.Optional(
              Type.String({ description: "Reviewer comments, shown to the requester" }),
            ),
          }),
          async execute(_id: string, params: Record<string, unknown>) {
            try {
              const id = sessionId(params);
              const comments = typeof params.comments === "string" ? params.comments : "";
              const summary = `${spec.verb} approval request on session ${id}${
                comments ? ` (comments: ${comments})` : ""
              }`;
              return await stageWrite(summary, () =>
                scopelyFetch(`/api/sessions/${id}/${spec.path}/`, {
                  method: "POST",
                  body: JSON.stringify(comments ? { comments } : {}),
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

  // --- discounts -----------------------------------------------------------

  // Dependency read: resolves discount ids for removal and shows what is
  // already applied. Runs immediately (read-only).
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_session_discounts",
        description:
          "List the discounts applied to a Scopely session (id, type, label, value, category). " +
          "Read-only — runs immediately. Use before removing a discount to find its discount_id.",
        parameters: Type.Object({ session_id: SESSION_ID_PARAM }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            const result = await scopelyFetch(`/api/sessions/${id}/discounts/`);
            return jsonResult({ ok: result.ok, status: result.status, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_add_session_discount",
        description:
          "Add a discount line to a Scopely session's pricing. " +
          STAGED +
          " value must be non-negative; percent values are 0-100.",
        parameters: Type.Object({
          session_id: SESSION_ID_PARAM,
          discount_type: Type.Union([Type.Literal("percent"), Type.Literal("fixed")], {
            description: "percent = percentage off; fixed = fixed amount off",
          }),
          value: Type.Number({ description: "Non-negative discount value" }),
          label: Type.Optional(Type.String({ description: "Display label (default 'Discount')" })),
          category: Type.Optional(
            Type.String({
              description: "Pricing category to scope to; omit to apply to the total",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            const discountType = params.discount_type as "percent" | "fixed";
            const value = Number(params.value);
            if (!Number.isFinite(value) || value < 0) {
              throw new Error("value must be a non-negative number");
            }
            const label =
              typeof params.label === "string" && params.label ? params.label : "Discount";
            const category = typeof params.category === "string" ? params.category : "";
            const body: Record<string, unknown> = {
              discount_type: discountType,
              value: String(value),
              label,
            };
            if (category) body.category = category;
            const rendered = discountType === "percent" ? `${value}%` : `${value} fixed`;
            const summary = `add discount "${label}" (${rendered}${
              category ? `, category ${category}` : ", on total"
            }) to session ${id}`;
            return await stageWrite(summary, () =>
              scopelyFetch(`/api/sessions/${id}/discounts/`, {
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

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_remove_session_discount",
        description:
          "Remove a discount line from a Scopely session. " +
          STAGED +
          " Find the discount_id first with scopely_list_session_discounts.",
        parameters: Type.Object({
          session_id: SESSION_ID_PARAM,
          discount_id: Type.Number({ description: "Numeric discount id to remove" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const id = sessionId(params);
            const discountId = Number(params.discount_id);
            if (!Number.isInteger(discountId) || discountId <= 0) {
              throw new Error("discount_id must be a positive integer");
            }
            return await stageWrite(`remove discount ${discountId} from session ${id}`, () =>
              scopelyFetch(`/api/sessions/${id}/discounts/${discountId}/`, { method: "DELETE" }),
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
