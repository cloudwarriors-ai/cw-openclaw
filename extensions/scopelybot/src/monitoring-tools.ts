import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { scopelyFetch, jsonResult, errorResult, buildQuery } from "./scopely-api.js";

export function registerMonitoringTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // scopely_extraction_metrics — "How are extractions performing?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_extraction_metrics",
        description:
          "Get Scopely VIP extraction metrics. Returns live active sessions, today's success/failure counts, " +
          "average duration, and weekly breakdown by vendor and day. " +
          "Use this for real-time health: 'how many extractions today', 'what is the success rate', 'any failures'.",
        parameters: Type.Object({
          vendor: Type.Optional(Type.String({ description: "Filter metrics by vendor" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["vendor"]);
            const result = await scopelyFetch(`/api/v1/extraction-monitor/metrics/${qs}`);
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

  // scopely_extraction_sessions — "Show me recent extractions"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_extraction_sessions",
        description:
          "List Scopely VIP extraction sessions. Shows session status, user, vendor, frame counts, " +
          "duration, and error messages. Use this to investigate extraction failures or see recent activity.",
        parameters: Type.Object({
          vendor: Type.Optional(Type.String({ description: "Filter by vendor" })),
          status: Type.Optional(
            Type.String({
              description: "Filter: pending, streaming, completing, completed, failed, abandoned",
            }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["vendor", "status", "limit"]);
            const result = await scopelyFetch(`/api/v1/extraction-monitor/sessions/${qs}`);
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

  // scopely_extraction_detail — "What happened in extraction session X?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_extraction_detail",
        description:
          "Get detailed info about a specific extraction session including event timeline. " +
          "Shows frame counts, latency, tokens captured, errors, and lifecycle events.",
        parameters: Type.Object({
          session_id: Type.String({ description: "Extraction session ID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = await scopelyFetch(
              `/api/v1/extraction-monitor/sessions/${encodeURIComponent(params.session_id as string)}/`,
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

  // scopely_wizard_funnel — "Where are users dropping off in the wizard?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_wizard_funnel",
        description:
          "Get the Scopely VIP wizard step drop-off funnel. Shows how many sessions reached each step " +
          "(company_info → project_type → source_vendor → ... → sow_generation) and where users abandon. " +
          "Use this to identify UX problems or friction points in the scoping flow.",
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
            const stats = result.data as Record<string, unknown>;
            return jsonResult({
              ok: true,
              step_dropoff: stats.step_dropoff ?? {},
              total_sessions: stats.total_sessions ?? 0,
              conversion_rate: stats.conversion_rate ?? 0,
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
