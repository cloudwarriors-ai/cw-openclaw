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
            const result = await scopelyFetch("/api/admin/stats/");
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
            const result = await scopelyFetch(`/api/admin/audit-logs/${qs}`);
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
            const result = await scopelyFetch("/api/admin/approvals/");
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
              ? `/api/admin/vendors/${encodeURIComponent(vendorKey)}/`
              : "/api/admin/vendors/";
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
              `/api/admin/sessions/${encodeURIComponent(params.id as string)}/pricing/`,
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

  // scopely_activity_log — "What did user X actually do?" Distinct from
  // scopely_audit_logs (admin change trail): this reads the USER activity
  // stream (logins, request failures, journey events) that powers the User
  // Journey page. discover_filters gives the model a discovery path for real
  // user/session ids instead of guessing them (issue #81 lesson).
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_activity_log",
        description:
          "Get the Scopely VIP user activity log (logins, request failures, user journey events) with " +
          "optional filters. Distinct from scopely_audit_logs, which tracks admin config changes. Use " +
          "for 'what did this user do', 'any failed logins today', 'trace this user's journey'. " +
          "Call with discover_filters=true FIRST when you need a user or session id — it returns the " +
          "users/sessions that actually appear in the log, so you never guess ids. Read-only.",
        parameters: Type.Object({
          discover_filters: Type.Optional(
            Type.Boolean({
              description:
                "true = return the distinct users and sessions present in the log (for picking real " +
                "filter values) instead of log entries",
            }),
          ),
          event: Type.Optional(
            Type.Array(Type.String(), {
              description: "Event names to include (e.g. auth.login_success, request.failed)",
            }),
          ),
          user: Type.Optional(Type.Number({ description: "Filter by numeric user id" })),
          resource_type: Type.Optional(Type.String()),
          resource_id: Type.Optional(Type.String()),
          level: Type.Optional(
            Type.String({ description: "Filter by level (e.g. info, warning)" }),
          ),
          since: Type.Optional(Type.String({ description: "ISO-8601 lower bound on timestamp" })),
          limit: Type.Optional(Type.Number({ description: "Max entries (default 50, cap 500)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            if (params.discover_filters === true) {
              const filters = await scopelyFetch(`/api/admin/activity/filters/`);
              return jsonResult({ ok: filters.ok, status: filters.status, data: filters.data });
            }
            const qs = buildQuery(params, [
              "user",
              "resource_type",
              "resource_id",
              "level",
              "since",
              "limit",
            ]);
            // Multiple `event` params are ANDed into one `event__in` filter by
            // the backend; buildQuery skips arrays, so append them here.
            const events = Array.isArray(params.event)
              ? params.event.filter((e): e is string => typeof e === "string" && e.length > 0)
              : [];
            const eventQs = events.map((e) => `event=${encodeURIComponent(e)}`).join("&");
            const sep = qs ? (eventQs ? "&" : "") : eventQs ? "?" : "";
            const result = await scopelyFetch(`/api/admin/activity/${qs}${sep}${eventQs}`);
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
