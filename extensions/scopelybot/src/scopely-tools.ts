import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { opsRead } from "./ops-client.js";
import { redactText } from "./redaction.js";
import { scopelyFetch, jsonResult, errorResult, buildQuery } from "./scopely-api.js";

// The new app's order statuses (orders/ops_capabilities.py, the sessions.list
// status enum); the old in_progress/generated/converted filter is gone.
const SESSION_STATUSES = [
  "archived",
  "cancelled",
  "closed",
  "declined",
  "draft",
  "in_progress",
  "locked",
  "pricing_complete",
  "signed",
  "sow_generated",
  "sow_sent",
  "voided",
] as const;

export function registerScopelyTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // scopely_auth_status — "Who is the bot acting as for me?" (operator layer system.whoami)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_auth_status",
        description:
          "Check who the bot is acting as in the new ZW app for the person asking: the matched ZW " +
          "user (or that none matched) and the bot's service principal. Read-only.",
        parameters: Type.Object({}),
        execute: opsRead,
      },
      logger,
    ),
  );

  // The new app has no component health; scopely_component_health stays
  // registry-blocked (capability-registry.ts) and its body never runs.
  const HEALTH_PATH = "/api/v1/health/";
  // The health body is echoed to the model: a non-JSON answer (an HTML error or
  // Django debug page; prod DEBUG=0 is unconfirmed) is cut to about 1 KB.
  const HEALTH_TEXT_LIMIT = 1024;

  async function fetchHealth(suffix: "components/") {
    const result = await scopelyFetch(`${HEALTH_PATH}${suffix}`);
    const data =
      typeof result.data === "string" ? redactText(result.data, HEALTH_TEXT_LIMIT) : result.data;
    return jsonResult({ ok: result.ok, status: result.status, data });
  }

  // scopely_health_check — "Is the service up?" (operator layer system.health)
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_health_check",
        description:
          "Check Scopely VIP service health. Returns service status and database connectivity. " +
          "Use this to determine if there is an immediate infrastructure problem.",
        parameters: Type.Object({}),
        execute: opsRead,
      },
      logger,
    ),
  );

  // scopely_component_health — "Is the box up AND does the product still work?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_component_health",
        description:
          "Check per-dependency readiness of Scopely VIP: DocuSign, email, OAuth, CRM, SOW templates, " +
          "and other integration components, each reported up/degraded/down/not_configured with a short " +
          "reason, plus an overall rollup. Use this when 'is it up' isn't enough — e.g. 'why are SOW " +
          "sends failing' or before/after a change window. Read-only.",
        parameters: Type.Object({}),
        async execute() {
          try {
            return await fetchHealth("components/");
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
          "Set ordering to '-last_login' to sort by most recent login. `search` handles a full " +
          "person name (e.g. 'Josh Rickerd') automatically — no need to split it yourself.",
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
            const result = await scopelyFetch(`/api/auth/users/${qs}`);
            if (!result.ok) {
              return jsonResult({
                ok: false,
                error: `HTTP ${result.status}`,
                details: result.data,
              });
            }
            const rows = Array.isArray(result.data) ? result.data : [];
            const search = typeof params.search === "string" ? params.search.trim() : "";
            // The backend OR-matches the *whole* search string against email, first_name,
            // last_name, and username separately (icontains) — a two-word "Josh Rickerd"
            // never matches, since no single field holds both tokens together. When the
            // first attempt returns nothing and the query looks like a full name, retry
            // per token and union the results client-side (deduped by id) instead of
            // reporting a false "no user found".
            const tokens = search.split(/\s+/).filter((t) => t.length > 1);
            if (rows.length === 0 && tokens.length > 1) {
              const byId = new Map<number, unknown>();
              for (const token of tokens) {
                const tokenQs = buildQuery({ ...params, search: token }, [
                  "role",
                  "search",
                  "ordering",
                ]);
                const tokenResult = await scopelyFetch(`/api/auth/users/${tokenQs}`);
                if (tokenResult.ok && Array.isArray(tokenResult.data)) {
                  for (const row of tokenResult.data as Array<{ id: number }>) {
                    byId.set(row.id, row);
                  }
                }
              }
              if (byId.size > 0) {
                return jsonResult({
                  ok: true,
                  data: [...byId.values()],
                  note: `No exact match for "${search}" as one phrase; matched individual name terms instead.`,
                });
              }
            }
            return jsonResult({ ok: true, data: rows });
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
          "List Scopely VIP deals (scoping sessions) with status, company, vendor, organization and " +
          "total, newest first, paged. Platform staff only.",
        parameters: Type.Object({
          status: Type.Optional(
            Type.Array(Type.Unsafe<string>({ type: "string", enum: [...SESSION_STATUSES] }), {
              description: "Filter by one or more statuses",
            }),
          ),
          search: Type.Optional(Type.String({ description: "Search by company name or contact" })),
          organization_id: Type.Optional(Type.Integer({ description: "Only this organization" })),
          page: Type.Optional(Type.Integer({ description: "Page number (default 1)" })),
          page_size: Type.Optional(Type.Integer({ description: "Results per page (max 100)" })),
        }),
        execute: opsRead,
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
          "Get one Scopely VIP deal by session id OR order number (give exactly one): status, " +
          "company, vendor, project and deployment type, total, version and answer keys.",
        // Exactly one of the two (the kernel refuses both or neither).
        parameters: Type.Object({
          session_id: Type.Optional(
            Type.Integer({ description: "Session id (the `id` from scopely_list_sessions)" }),
          ),
          order_number: Type.Optional(
            Type.String({ description: "Order number, e.g. PS-0000123" }),
          ),
        }),
        execute: opsRead,
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
            const result = await scopelyFetch("/api/extraction-monitor/metrics/");
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
              `/api/admin/activity/?${activityQs.toString()}&event=request.failed`,
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
              `/api/admin/activity/?${requestQs.toString()}`,
            );
            const serverErrors = requestResult.ok ? requestResult.data : [];

            // Check failed extraction sessions
            const extractionResult = await scopelyFetch(
              `/api/extraction-monitor/sessions/?status=failed&limit=${limit}`,
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
            const result = await scopelyFetch(`/api/admin/sessions/${searchQs}`);
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
            const result = await scopelyFetch(`/api/admin/activity/?${qs.toString()}`);
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
              `/api/admin/activity/?${successQs.toString()}`,
            );
            const successes = successResult.ok ? successResult.data : [];

            // Failed logins (if requested)
            let failures: unknown = [];
            if (includeFail) {
              const failQs = new URLSearchParams({ event: "auth.login_failure", limit });
              if (params.since) {
                failQs.set("since", params.since as string);
              }
              const failResult = await scopelyFetch(`/api/admin/activity/?${failQs.toString()}`);
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
