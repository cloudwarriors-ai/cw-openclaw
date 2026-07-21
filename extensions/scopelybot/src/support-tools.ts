/** High-value, bounded support workflows for Scopely PE/PM incident handling. */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import type { ScopelyBotConfig } from "./config.js";
import { traceScopelyLogs, listScopelyServices } from "./devtools-client.js";
import { stageWrite } from "./gated.js";
import { buildQuery, errorResult, jsonResult, scopelyFetch } from "./scopely-api.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveId(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function shapeSession(value: unknown) {
  const data = asRecord(value);
  const pricing = asRecord(data.pricing_snapshot);
  return {
    id: data.id,
    company_name: data.company_name,
    status: data.status,
    organization_name: data.organization_name,
    source_vendor_key: data.source_vendor_key,
    destination_vendor_key: data.destination_vendor_key,
    project_type: data.project_type,
    deployment_type: data.deployment_type,
    created_at: data.created_at,
    updated_at: data.updated_at,
    pricing_snapshot: {
      grand_total: pricing.grand_total,
      currency_code: pricing.currency_code,
    },
  };
}

function shapeTimeline(value: unknown) {
  const data = asRecord(value);
  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  return {
    session_id: data.session_id,
    timeline: timeline.slice(0, 200).map((entry) => {
      const row = asRecord(entry);
      return {
        wizard_step: row.wizard_step,
        "@timestamp": row["@timestamp"],
        duration_to_next_ms: row.duration_to_next_ms,
      };
    }),
  };
}

function shapeVersions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry) => {
    const row = asRecord(entry);
    return {
      id: row.id,
      version_number: row.version_number,
      grand_total: row.grand_total,
      created_at: row.created_at,
    };
  });
}

function shapeComparison(value: unknown) {
  const data = asRecord(value);
  const shapeVersion = (entry: unknown) => {
    const row = asRecord(entry);
    return { version_number: row.version_number, grand_total: row.grand_total };
  };
  const diffs = Array.isArray(data.line_item_diff) ? data.line_item_diff : [];
  return {
    v1: shapeVersion(data.v1),
    v2: shapeVersion(data.v2),
    line_item_diff: diffs.slice(0, 200).map((entry) => {
      const row = asRecord(entry);
      const v1 = asRecord(row.v1);
      const v2 = asRecord(row.v2);
      return {
        pricing_key: row.pricing_key,
        changed: row.changed,
        v1: { quantity: v1.quantity, total: v1.total },
        v2: { quantity: v2.quantity, total: v2.total },
      };
    }),
  };
}

export function registerSupportTools(
  api: OpenClawPluginApi,
  logger: AuditLogger,
  config: ScopelyBotConfig,
) {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_list_services",
        description:
          "List the exact allowlisted Scopely application/extraction containers and their live Docker health. Read-only; unrelated, database, Elasticsearch, OpenClaw, and DevTools containers are never returned.",
        parameters: Type.Object({}),
        async execute() {
          try {
            return jsonResult(await listScopelyServices(config));
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
        name: "scopely_trace_logs",
        description:
          "Search bounded, redacted logs across exact allowlisted Scopely services. Reports each source success/failure explicitly. Read-only. Accepts relative (30m/1h), ISO, or epoch times.",
        parameters: Type.Object({
          pattern: Type.String({
            description: "Literal case-insensitive text to find (1-200 chars)",
          }),
          containers: Type.Optional(
            Type.Array(Type.String(), {
              description: "Exact allowlisted service names; defaults to all",
            }),
          ),
          since: Type.Optional(
            Type.String({ description: "Start: 30m, 1h, ISO-8601, or epoch seconds" }),
          ),
          until: Type.Optional(Type.String({ description: "End: ISO-8601 or epoch seconds" })),
          tail: Type.Optional(Type.Number({ description: "Lines per service, clamped to 1000" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            return jsonResult(await traceScopelyLogs(config, params));
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
        name: "scopely_support_session",
        description:
          "Assemble a read-only support case for one Scopely session from admin detail and wizard timeline. Returns a PII-safe shaped response and explicit source status.",
        parameters: Type.Object({ session_id: Type.Number({ description: "Numeric session id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const sessionId = positiveId(params.session_id, "session_id");
            const [detail, timeline] = await Promise.all([
              scopelyFetch(`/api/admin/sessions/${sessionId}/`),
              scopelyFetch(`/api/admin/sessions/${sessionId}/timeline/`),
            ]);
            return jsonResult({
              ok: detail.ok || timeline.ok,
              session_id: sessionId,
              sources: {
                detail: { ok: detail.ok, status: detail.status },
                timeline: { ok: timeline.ok, status: timeline.status },
              },
              detail: detail.ok ? shapeSession(detail.data) : undefined,
              timeline: timeline.ok ? shapeTimeline(timeline.data) : undefined,
            });
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
        name: "scopely_session_status_counts",
        description:
          "Get live Scopely session counts by lifecycle status with optional admin-list facets. Read-only. " +
          "For a plain 'how many sessions' question, call with NO filters.",
        parameters: Type.Object({
          vendor: Type.Optional(Type.String()),
          deployment: Type.Optional(
            Type.String({
              description:
                "Deployment-type KEY from the scoping wizard (e.g. autopilot, copilot, bespoke) — " +
                "NOT an environment name like prod/dev. Unknown keys are rejected with the valid list. " +
                "Omit to count sessions across all deployment types.",
            }),
          ),
          search: Type.Optional(Type.String()),
          date_from: Type.Optional(Type.String()),
          date_to: Type.Optional(Type.String()),
          created_by: Type.Optional(Type.String()),
          organization: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            // Fail-loud filter validation (issue #81): the backend silently
            // returns all-zero counts for an unknown deployment_type value —
            // observed live 2026-07-21 when the model guessed deployment="prod"
            // and confidently reported "0 sessions" against 713 real ones.
            // Valid keys are data-defined (deployment-type templates), so we
            // check against the live list instead of hardcoding an enum. Same
            // self-correction pattern that fixed the S7 container guessing.
            const deployment =
              typeof params.deployment === "string" ? params.deployment.trim() : "";
            if (deployment) {
              const templates = await scopelyFetch(`/api/admin/deployment-type-templates/`);
              const rows = Array.isArray(templates.data)
                ? templates.data
                : ((asRecord(templates.data).results as unknown[]) ?? []);
              const validKeys = rows.map((row) => String(asRecord(row).key ?? "")).filter(Boolean);
              if (templates.ok && validKeys.length > 0 && !validKeys.includes(deployment)) {
                return jsonResult({
                  ok: false,
                  error:
                    `Unknown deployment type "${deployment}" — the backend would silently return zero ` +
                    `counts for it. Valid deployment-type keys: ${validKeys.join(", ")}. ` +
                    `Omit the deployment filter to count sessions across all deployment types.`,
                });
              }
            }
            const query = buildQuery(params, [
              "vendor",
              "deployment",
              "search",
              "date_from",
              "date_to",
              "created_by",
              "organization",
            ]);
            const result = await scopelyFetch(`/api/admin/sessions/status-counts/${query}`);
            const data = asRecord(result.data);
            return jsonResult({
              ok: result.ok,
              status: result.status,
              data: result.ok
                ? { total: data.total, counts: data.counts, other: data.other }
                : undefined,
            });
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
        name: "scopely_list_session_versions",
        description: "List PII-safe pricing revision metadata for a Scopely session. Read-only.",
        parameters: Type.Object({ session_id: Type.Number({ description: "Numeric session id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const sessionId = positiveId(params.session_id, "session_id");
            const result = await scopelyFetch(`/api/sessions/${sessionId}/versions/`);
            return jsonResult({
              ok: result.ok,
              status: result.status,
              data: result.ok ? shapeVersions(result.data) : undefined,
            });
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
        name: "scopely_compare_session_versions",
        description:
          "Compare two pricing versions for one Scopely session using a bounded PII-safe diff. Read-only.",
        parameters: Type.Object({
          session_id: Type.Number({ description: "Numeric session id" }),
          v1: Type.Number({ description: "First pricing version id" }),
          v2: Type.Number({ description: "Second pricing version id" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const sessionId = positiveId(params.session_id, "session_id");
            const v1 = positiveId(params.v1, "v1");
            const v2 = positiveId(params.v2, "v2");
            const result = await scopelyFetch(
              `/api/sessions/${sessionId}/versions/compare/?v1=${v1}&v2=${v2}`,
            );
            return jsonResult({
              ok: result.ok,
              status: result.status,
              data: result.ok ? shapeComparison(result.data) : undefined,
            });
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
        name: "scopely_unlock_user",
        description:
          "Stage clearing a Scopely user's login lockout. PROD write; nothing executes until a separately authorized Zoom sender confirms the system-posted code.",
        parameters: Type.Object({ user_id: Type.Number({ description: "Numeric user id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const userId = positiveId(params.user_id, "user_id");
            return stageWrite(`unlock user id ${userId}`, () =>
              scopelyFetch(`/api/auth/users/${userId}/unlock/`, { method: "POST", body: "{}" }),
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
        name: "scopely_resend_user_verification",
        description:
          "Stage issuing and emailing a fresh onboarding verification code. PROD write; invalidates the prior code and requires separately authorized Zoom confirmation.",
        parameters: Type.Object({ user_id: Type.Number({ description: "Numeric user id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const userId = positiveId(params.user_id, "user_id");
            return stageWrite(`resend onboarding verification for user id ${userId}`, () =>
              scopelyFetch(`/api/auth/users/${userId}/resend-verification/`, {
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

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_reassign_session",
        description:
          "Stage moving a session to another organization and optionally owner. HIGH IMPACT: can recompute pricing and require DocuSign pricing acknowledgement. Requires separately authorized Zoom confirmation.",
        parameters: Type.Object({
          session_id: Type.Number({ description: "Numeric session id" }),
          organization_id: Type.Number({ description: "Destination organization id" }),
          owner_user_id: Type.Optional(
            Type.Number({ description: "Optional owner in destination org" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const sessionId = positiveId(params.session_id, "session_id");
            const organizationId = positiveId(params.organization_id, "organization_id");
            const body: Record<string, unknown> = { organization_id: organizationId };
            if (params.owner_user_id !== undefined) {
              body.owner_user_id = positiveId(params.owner_user_id, "owner_user_id");
            }
            const owner = body.owner_user_id ? ` and owner ${body.owner_user_id}` : "";
            return stageWrite(
              `reassign session ${sessionId} to organization ${organizationId}${owner}; pricing may be recomputed and DocuSign acknowledgement may be required`,
              () =>
                scopelyFetch(`/api/admin/sessions/${sessionId}/reassign/`, {
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
        name: "scopely_refresh_docusign_status",
        description:
          "Stage polling DocuSign and reconciling session status. This may transition the session to signed, declined, or voided; requires separately authorized Zoom confirmation.",
        parameters: Type.Object({ session_id: Type.Number({ description: "Numeric session id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const sessionId = positiveId(params.session_id, "session_id");
            return stageWrite(`refresh DocuSign status for session ${sessionId}`, () =>
              scopelyFetch(`/api/sessions/${sessionId}/docusign/refresh-status/`, {
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

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_resend_docusign",
        description:
          "Stage re-emailing the active DocuSign envelope to its current recipient. No document change, but sends external email and requires separately authorized Zoom confirmation.",
        parameters: Type.Object({ session_id: Type.Number({ description: "Numeric session id" }) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const sessionId = positiveId(params.session_id, "session_id");
            return stageWrite(`resend active DocuSign envelope for session ${sessionId}`, () =>
              scopelyFetch(`/api/sessions/${sessionId}/docusign/resend/`, {
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
