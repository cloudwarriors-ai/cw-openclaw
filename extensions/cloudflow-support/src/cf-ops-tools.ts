import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, errorResult } from "./helpers.js";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { getFirebaseIdToken, getApiBaseUrl, clearFirebaseToken } from "./cf-auth.js";

async function cfApi(path: string, opts?: { method?: string; body?: unknown; retried?: boolean }): Promise<unknown> {
  const token = await getFirebaseIdToken();
  const baseUrl = getApiBaseUrl();
  const resp = await fetch(`${baseUrl}${path}`, {
    method: opts?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  // 401 retry: clear cached token and retry once
  if (resp.status === 401 && !opts?.retried) {
    clearFirebaseToken();
    return cfApi(path, { ...opts, retried: true });
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`CloudFlow API ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json();
}

async function executeOp(operationId: string, payload: Record<string, unknown>): Promise<unknown> {
  return cfApi("/api/internal/ops/execute", {
    method: "POST",
    body: {
      operationId,
      requestId: crypto.randomUUID(),
      payload,
    },
  });
}

export function registerCfOpsTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // cf_discover_ops
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_discover_ops",
        description: "List all available CloudFlow operations with their domains, descriptions, required scopes, and input/output schemas.",
        parameters: Type.Object({}),
        async execute(_id: string, _params: Record<string, unknown>) {
          try {
            const data = await cfApi("/api/internal/discovery");
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_execute_op
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_execute_op",
        description: "Execute any CloudFlow operation by ID. Use cf_discover_ops first to see available operations and their required payloads.",
        parameters: Type.Object({
          operationId: Type.String({ description: "The operation ID (e.g., 'listTickets', 'getDeployment')" }),
          payload: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Operation-specific input payload" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const operationId = params.operationId as string;
            const payload = (params.payload as Record<string, unknown>) ?? {};
            const data = await executeOp(operationId, payload);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_list_tickets
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_list_tickets",
        description: "List CloudFlow support tickets. Optionally filter by status or tenant.",
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: "Filter by ticket status (open, in_progress, resolved, closed)" })),
          tenantId: Type.Optional(Type.String({ description: "Filter by tenant ID" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 25)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const payload: Record<string, unknown> = {};
            if (params.status) payload.status = params.status;
            if (params.tenantId) payload.tenantId = params.tenantId;
            if (params.limit) payload.limit = params.limit;
            const data = await executeOp("listTickets", payload);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_get_ticket
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_get_ticket",
        description: "Get details of a specific CloudFlow support ticket including chat history.",
        parameters: Type.Object({
          ticketId: Type.String({ description: "Ticket document ID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = await executeOp("getTicket", { ticketId: params.ticketId });
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_list_deployments
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_list_deployments",
        description: "List CloudFlow deployment workbooks with milestones and status.",
        parameters: Type.Object({
          tenantId: Type.Optional(Type.String({ description: "Filter by tenant ID" })),
          status: Type.Optional(Type.String({ description: "Filter by deployment status" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const payload: Record<string, unknown> = {};
            if (params.tenantId) payload.tenantId = params.tenantId;
            if (params.status) payload.status = params.status;
            const data = await executeOp("listDeployments", payload);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_get_deployment
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_get_deployment",
        description: "Get details of a specific CloudFlow deployment workbook.",
        parameters: Type.Object({
          deploymentId: Type.String({ description: "Deployment document ID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = await executeOp("getDeployment", { deploymentId: params.deploymentId });
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_list_users
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_list_users",
        description: "List CloudFlow platform users. Filter by role or search by name/email.",
        parameters: Type.Object({
          role: Type.Optional(Type.String({ description: "Filter by platform role (PM, PE, SM, Dev, HR)" })),
          search: Type.Optional(Type.String({ description: "Search by name or email" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const payload: Record<string, unknown> = {};
            if (params.role) payload.role = params.role;
            if (params.search) payload.search = params.search;
            const data = await executeOp("listUsers", payload);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_list_tenants
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_list_tenants",
        description: "List CloudFlow customer tenants/organizations.",
        parameters: Type.Object({
          search: Type.Optional(Type.String({ description: "Search by tenant name" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const payload: Record<string, unknown> = {};
            if (params.search) payload.search = params.search;
            const data = await executeOp("listTenants", payload);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // cf_get_deploy_status
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_get_deploy_status",
        description: "Check the latest Firebase App Hosting deployment status via GitHub Actions.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Number of recent runs to check (default 5)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const { execSync } = await import("child_process");
            const limit = (params.limit as number) || 5;
            const result = execSync(
              `gh run list --repo cloudwarriors-ai/cloudflow --limit ${limit} --json databaseId,displayTitle,status,conclusion,createdAt,updatedAt,headBranch`,
              {
                encoding: "utf-8",
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            const data = JSON.parse(result);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
