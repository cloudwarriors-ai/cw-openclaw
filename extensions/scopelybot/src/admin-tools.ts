import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { scopelyFetch, jsonResult, errorResult, buildQuery } from "./scopely-api.js";

export function registerAdminTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // scopely_dashboard_stats — "How is the platform doing?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_dashboard_stats",
        description:
          "Get Scopely VIP dashboard statistics. Returns total sessions, pipeline value, conversion rate, " +
          "weekly trends, step drop-off funnel, vendor breakdown, and team performance. " +
          "Use this for high-level observability: 'how many sessions this week', 'what is the pipeline value', " +
          "'where are users dropping off'.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await scopelyFetch("/api/v1/admin/stats/");
            if (!result.ok) {
              return jsonResult({
                ok: false,
                error: `HTTP ${result.status}`,
                details: result.data,
              });
            }
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_audit_logs — "Who changed what?" / "What happened recently?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_audit_logs",
        description:
          "Get Scopely VIP audit logs. Shows who changed what, when, with old/new value diffs. " +
          "Covers vendor config changes, pricing updates, session modifications, user management. " +
          "Use this to answer 'who changed the pricing', 'what configuration was modified', 'what happened today'.",
        parameters: Type.Object({
          resource_type: Type.Optional(
            Type.String({
              description:
                "Filter by resource type (vendor, project_type, scoping_card, pricing_item, session, user)",
            }),
          ),
          action: Type.Optional(
            Type.String({ description: "Filter by action (create, update, delete)" }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["resource_type", "action", "limit"]);
            const result = await scopelyFetch(`/api/v1/admin/audit-logs/${qs}`);
            if (!result.ok) {
              return jsonResult({
                ok: false,
                error: `HTTP ${result.status}`,
                details: result.data,
              });
            }
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_pending_approvals — "Are there sessions waiting for approval?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_pending_approvals",
        description:
          "Get Scopely VIP sessions pending manager approval. Shows sessions that need sign-off before proceeding.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await scopelyFetch("/api/v1/admin/approvals/");
            if (!result.ok) {
              return jsonResult({
                ok: false,
                error: `HTTP ${result.status}`,
                details: result.data,
              });
            }
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_vendor_config — "What vendors are configured?" / "Show me the vendor setup"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_vendor_config",
        description:
          "List Scopely VIP vendor configurations. Shows all configured vendors with their project types and pricing. " +
          "Use this to check if vendor config is correct or to understand the current setup.",
        parameters: Type.Object({
          vendor_key: Type.Optional(
            Type.String({ description: "Get specific vendor by key (e.g. 'ringcentral', 'zoom')" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const vendorKey = params.vendor_key as string | undefined;
            const path = vendorKey
              ? `/api/v1/admin/vendors/${encodeURIComponent(vendorKey)}/`
              : "/api/v1/admin/vendors/";
            const result = await scopelyFetch(path);
            if (!result.ok) {
              return jsonResult({
                ok: false,
                error: `HTTP ${result.status}`,
                details: result.data,
              });
            }
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_session_pricing — "What is the pricing for session X?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_session_pricing",
        description:
          "Get pricing details for a specific Scopely VIP scoping session. " +
          "Returns line items, discounts, totals, and pricing versions.",
        parameters: Type.Object({
          id: Type.String({ description: "Session ID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = await scopelyFetch(
              `/api/v1/admin/sessions/${encodeURIComponent(params.id as string)}/pricing/`,
            );
            if (!result.ok) {
              return jsonResult({
                ok: false,
                error: `HTTP ${result.status}`,
                details: result.data,
              });
            }
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
