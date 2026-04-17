import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { scopelyFetch, jsonResult, errorResult, buildQuery } from "./scopely-api.js";

export function registerScopelyTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // scopely_auth_status — "Are we connected?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_auth_status",
        description:
          "Check Scopely VIP authentication status. Returns current session and user info.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await scopelyFetch("/api/v1/auth/me/");
            if (!result.ok) {
              return jsonResult({ ok: false, error: `HTTP ${result.status}` });
            }
            return jsonResult({ ok: true, user: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_health_check — "Is the service up?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_health_check",
        description:
          "Check Scopely VIP service health. Returns service status and database connectivity. " +
          "Use this to determine if there is an immediate infrastructure problem.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const baseUrl = process.env.SCOPELY_URL ?? "https://scopely.pscx.ai";
            const resp = await fetch(`${baseUrl}/health/`);
            const data = resp.headers.get("content-type")?.includes("application/json")
              ? await resp.json()
              : await resp.text();
            return jsonResult({ ok: resp.ok, status: resp.status, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_list_users — "Who are the users?" / "Who was the last person to login?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_users",
        description:
          "List Scopely VIP users. Returns user profiles with roles, organizations, last_login, and session count. " +
          "Use this to answer 'who was the last person to login' or 'who are the active users'. " +
          "Set ordering to '-last_login' to sort by most recent login.",
        parameters: Type.Object({
          role: Type.Optional(
            Type.String({
              description: "Filter by role (platform_admin, power_user, org_admin, user)",
            }),
          ),
          search: Type.Optional(Type.String({ description: "Search by name or email" })),
          ordering: Type.Optional(
            Type.String({
              description:
                "Sort order: -last_login, last_login, -created_at, created_at (default: -created_at)",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["role", "search", "ordering"]);
            const result = await scopelyFetch(`/api/v1/auth/users/${qs}`);
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

  // scopely_list_sessions — "What scoping sessions exist?" / "What are users working on?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_sessions",
        description:
          "List Scopely VIP scoping sessions. Shows wizard sessions with status, step, company, and creator. " +
          "Use this to see what users are clicking on and what they are working on.",
        parameters: Type.Object({
          status: Type.Optional(
            Type.String({ description: "Filter: in_progress, generated, cancelled, converted" }),
          ),
          vendor: Type.Optional(Type.String({ description: "Filter by destination vendor" })),
          search: Type.Optional(Type.String({ description: "Search by company name or contact" })),
          created_by: Type.Optional(Type.String({ description: "Filter by creator user ID" })),
          date_from: Type.Optional(Type.String({ description: "Start date filter (YYYY-MM-DD)" })),
          date_to: Type.Optional(Type.String({ description: "End date filter (YYYY-MM-DD)" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, [
              "status",
              "vendor",
              "search",
              "created_by",
              "date_from",
              "date_to",
              "limit",
            ]);
            const result = await scopelyFetch(`/api/v1/admin/sessions/${qs}`);
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

  // scopely_get_session — "Tell me about session X"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_get_session",
        description:
          "Get detailed info about a specific Scopely VIP scoping session. " +
          "Returns wizard state, answers, pricing, status, company info, and who created it.",
        parameters: Type.Object({
          id: Type.String({ description: "Session ID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = await scopelyFetch(
              `/api/v1/admin/sessions/${encodeURIComponent(params.id as string)}/`,
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

  // scopely_active_users — "Who is using the app right now?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_active_users",
        description:
          "Get count of currently active Scopely VIP users (active in last 5 minutes) and active extraction sessions. " +
          "Use this to see if users are currently in the system.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await scopelyFetch("/api/v1/extraction-monitor/metrics/");
            if (!result.ok) {
              return jsonResult({
                ok: false,
                error: `HTTP ${result.status}`,
                details: result.data,
              });
            }
            const metrics = result.data as Record<string, unknown>;
            const live = metrics.live as Record<string, unknown> | undefined;
            return jsonResult({
              ok: true,
              active_sessions: live?.active_sessions ?? 0,
              wizard_users_online: live?.wizard_users_online ?? 0,
              raw_metrics: metrics,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_recent_errors — "What was the last error produced?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_recent_errors",
        description:
          "Get recent errors from Scopely VIP. Queries the ActivityLog for exceptions, request failures, " +
          "and failed extractions. Use this to answer 'what was the last error' or 'are there any problems right now'.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
          since: Type.Optional(
            Type.String({ description: "Only errors after this time (ISO 8601)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const limit = (params.limit as number) || 10;

            // Query real error/warning events from ActivityLog
            const activityQs = new URLSearchParams({
              event: "exception.unhandled",
              limit: String(limit),
            });
            if (params.since) {
              activityQs.set("since", params.since as string);
            }
            const errorResult_1 = await scopelyFetch(
              `/api/v1/admin/activity/?${activityQs.toString()}&event=request.failed`,
            );
            const activityErrors = errorResult_1.ok ? errorResult_1.data : [];

            // Also check 5xx request events
            const requestQs = new URLSearchParams({
              event: "request.completed",
              level: "error",
              limit: String(limit),
            });
            if (params.since) {
              requestQs.set("since", params.since as string);
            }
            const requestResult = await scopelyFetch(
              `/api/v1/admin/activity/?${requestQs.toString()}`,
            );
            const serverErrors = requestResult.ok ? requestResult.data : [];

            // Check failed extraction sessions
            const extractionResult = await scopelyFetch(
              `/api/v1/extraction-monitor/sessions/?status=failed&limit=${limit}`,
            );
            const failedExtractions = extractionResult.ok ? extractionResult.data : [];

            return jsonResult({
              ok: true,
              activity_errors: activityErrors,
              server_errors: serverErrors,
              failed_extractions: failedExtractions,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_search — "Find anything related to X"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_search",
        description:
          "Search across Scopely VIP sessions by company name, contact, or content. " +
          "Useful for finding specific deals, companies, or user activity.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query (company name, email, keyword)" }),
          status: Type.Optional(Type.String({ description: "Filter by status" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["search", "status", "limit"]);
            // Map 'query' to 'search' param for the API
            const searchQs = qs
              ? `${qs}&search=${encodeURIComponent(params.query as string)}`
              : `?search=${encodeURIComponent(params.query as string)}`;
            const result = await scopelyFetch(`/api/v1/admin/sessions/${searchQs}`);
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

  // scopely_user_activity — "What has user X been doing?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_user_activity",
        description:
          "Get a user's recent activity timeline from Scopely VIP. Shows logins, session operations, " +
          "wizard steps, pricing calculations, SOW generation, and API requests. " +
          "Use this to answer 'what has this user been doing' or 'show me their recent activity'.",
        parameters: Type.Object({
          user_id: Type.String({ description: "User ID to query activity for" }),
          event: Type.Optional(
            Type.String({
              description: "Filter by event type (e.g. auth.login_success, wizard.step_completed)",
            }),
          ),
          since: Type.Optional(
            Type.String({ description: "Only activity after this time (ISO 8601)" }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = new URLSearchParams({
              user: String(params.user_id),
              limit: String((params.limit as number) || 50),
            });
            if (params.event) {
              qs.set("event", params.event as string);
            }
            if (params.since) {
              qs.set("since", params.since as string);
            }
            const result = await scopelyFetch(`/api/v1/admin/activity/?${qs.toString()}`);
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

  // scopely_recent_logins — "Who logged in today?" / "Any login failures?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_recent_logins",
        description:
          "Get recent login events from Scopely VIP. Shows successful and failed login attempts with user, IP, and timestamp. " +
          "Use this to answer 'who logged in today' or 'were there any failed login attempts'.",
        parameters: Type.Object({
          include_failures: Type.Optional(
            Type.Boolean({ description: "Include failed login attempts (default: true)" }),
          ),
          since: Type.Optional(
            Type.String({ description: "Only logins after this time (ISO 8601)" }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const limit = String((params.limit as number) || 20);
            const includeFail = params.include_failures !== false;

            // Successful logins
            const successQs = new URLSearchParams({ event: "auth.login_success", limit });
            if (params.since) {
              successQs.set("since", params.since as string);
            }
            const successResult = await scopelyFetch(
              `/api/v1/admin/activity/?${successQs.toString()}`,
            );
            const successes = successResult.ok ? successResult.data : [];

            // Failed logins (if requested)
            let failures: unknown = [];
            if (includeFail) {
              const failQs = new URLSearchParams({ event: "auth.login_failure", limit });
              if (params.since) {
                failQs.set("since", params.since as string);
              }
              const failResult = await scopelyFetch(`/api/v1/admin/activity/?${failQs.toString()}`);
              failures = failResult.ok ? failResult.data : [];
            }

            return jsonResult({
              ok: true,
              successful_logins: successes,
              failed_logins: failures,
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
