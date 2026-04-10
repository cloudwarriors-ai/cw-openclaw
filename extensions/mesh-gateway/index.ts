import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { runCronIsolatedAgentTurn } from "../../src/cron/isolated-agent.js";
import type { CronJob } from "../../src/cron/types.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/types.js";

type MeshGatewayConfig = {
  enabled: boolean;
  displayName?: string;
  allowedUsers: string[];
  allowedAgents: string[];
};

type MeshAuthz = { ok: true; identity: string } | { ok: false; identity?: string; reason: string };

const TASK_STATES = new Set([
  "queued",
  "sent",
  "accepted",
  "running",
  "completed",
  "failed",
  "rejected",
]);

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item))),
  );
}

function resolveConfig(raw: Record<string, unknown> | undefined): MeshGatewayConfig {
  return {
    enabled: raw?.enabled === true,
    displayName: stringValue(raw?.displayName),
    allowedUsers: stringArray(raw?.allowedUsers),
    allowedAgents: stringArray(raw?.allowedAgents),
  };
}

function authorizeMeshClient(
  config: MeshGatewayConfig,
  opts: GatewayRequestHandlerOptions,
): MeshAuthz {
  const identity = stringValue(opts.client?.authUser);
  if (!config.enabled) {
    return { ok: false, identity, reason: "mesh_disabled" };
  }
  if (opts.client?.authMethod !== "tailscale") {
    return { ok: false, identity, reason: "tailscale_auth_required" };
  }
  if (!identity) {
    return { ok: false, reason: "tailscale_identity_missing" };
  }
  const allowed = new Set(config.allowedUsers.map(normalizeIdentity));
  if (!allowed.has(normalizeIdentity(identity))) {
    return { ok: false, identity, reason: "identity_not_allowlisted" };
  }
  return { ok: true, identity };
}

function authorizeAgent(
  config: MeshGatewayConfig,
  params: Record<string, unknown>,
): string | undefined {
  const fromAgent = stringValue(params.from_agent);
  if (!fromAgent || config.allowedAgents.length === 0) {
    return undefined;
  }
  const allowed = new Set(config.allowedAgents.map(normalizeIdentity));
  return allowed.has(normalizeIdentity(fromAgent)) ? undefined : "agent_not_allowlisted";
}

function sendError(
  opts: GatewayRequestHandlerOptions,
  error: string,
  extra?: Record<string, unknown>,
) {
  opts.respond(false, { error, ...(extra ?? {}) });
}

function buildMeshEvent(
  params: Record<string, unknown>,
  status: string,
  extra?: Record<string, unknown>,
) {
  return {
    task_id: stringValue(params.task_id),
    status,
    from_agent: stringValue(params.from_agent),
    from_identity: stringValue(params.from_identity),
    ...(extra ?? {}),
  };
}

function emitToCurrentClient(opts: GatewayRequestHandlerOptions, event: string, payload: unknown) {
  if (!opts.client?.connId) {
    return;
  }
  opts.context.broadcastToConnIds(event, payload, new Set([opts.client.connId]));
}

async function runMeshTask(params: {
  api: OpenClawPluginApi;
  opts: GatewayRequestHandlerOptions;
  eventParams: Record<string, unknown>;
  taskId: string;
  message: string;
  title?: string;
  model?: string;
}) {
  const { api, opts, eventParams, taskId, message, title, model } = params;
  emitToCurrentClient(opts, "mesh.task", buildMeshEvent(eventParams, "running"));
  const now = Date.now();
  const job: CronJob = {
    id: `mesh-${taskId}`,
    name: title ?? `Mesh task ${taskId}`,
    enabled: true,
    deleteAfterRun: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at", at: new Date(now).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message, model },
    state: {},
  };
  try {
    const result = await runCronIsolatedAgentTurn({
      cfg: api.config,
      deps: opts.context.deps,
      job,
      message,
      sessionKey: `mesh:${taskId}`,
      lane: "mesh",
    });
    const status =
      result.status === "ok" ? "completed" : result.status === "skipped" ? "rejected" : "failed";
    emitToCurrentClient(
      opts,
      "mesh.task",
      buildMeshEvent(eventParams, status, {
        summary: result.summary,
        details: result.outputText,
        error: result.error,
        artifacts: [],
      }),
    );
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    emitToCurrentClient(
      opts,
      "mesh.task",
      buildMeshEvent(eventParams, "failed", {
        summary: "Mesh task failed",
        details: messageText,
        error: messageText,
        artifacts: [],
      }),
    );
  }
}

const plugin = {
  id: "mesh-gateway",
  name: "Mesh Gateway",
  description: "Tokenless Tailscale-authenticated mesh RPC gateway for agent-to-agent tasks",
  configSchema: {
    safeParse(value: unknown) {
      if (value === undefined) {
        return { success: true, data: { enabled: false } };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
          success: false,
          error: { issues: [{ path: [], message: "expected config object" }] },
        };
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        displayName: { type: "string" },
        allowedUsers: { type: "array", items: { type: "string" } },
        allowedAgents: { type: "array", items: { type: "string" } },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    api.registerGatewayMethod("mesh.health", (opts) => {
      const authz = authorizeMeshClient(config, opts);
      opts.respond(true, {
        ok: authz.ok,
        enabled: config.enabled,
        gateway_reachable: true,
        tailscale_auth_active: opts.client?.authMethod === "tailscale",
        peer_authorized: authz.ok,
        callback_route_healthy: Boolean(opts.client?.connId),
        identity: authz.identity,
        displayName: config.displayName,
        reason: authz.ok ? undefined : authz.reason,
      });
    });

    api.registerGatewayMethod("mesh.list_capabilities", (opts) => {
      const authz = authorizeMeshClient(config, opts);
      if (!authz.ok) {
        sendError(opts, authz.reason, { identity: authz.identity });
        return;
      }
      opts.respond(true, {
        agent: config.displayName ?? "openclaw",
        identity: authz.identity,
        methods: ["mesh.health", "mesh.list_capabilities", "mesh.send_task", "mesh.reply"],
        delivery: "async_task_callback",
        task_states: [...TASK_STATES],
      });
    });

    api.registerGatewayMethod("mesh.reply", (opts) => {
      const authz = authorizeMeshClient(config, opts);
      if (!authz.ok) {
        sendError(opts, authz.reason, { identity: authz.identity });
        return;
      }
      const taskId = stringValue(opts.params.task_id);
      const status = stringValue(opts.params.status);
      if (!taskId || !status || !TASK_STATES.has(status)) {
        sendError(opts, "invalid_reply_payload");
        return;
      }
      const payload = {
        task_id: taskId,
        status,
        summary: stringValue(opts.params.summary),
        details: opts.params.details,
        artifacts: Array.isArray(opts.params.artifacts) ? opts.params.artifacts : [],
        from_agent: stringValue(opts.params.from_agent),
        from_identity: authz.identity,
      };
      emitToCurrentClient(opts, "mesh.reply", payload);
      opts.respond(true, { accepted: true, task_id: taskId });
    });

    api.registerGatewayMethod("mesh.send_task", (opts) => {
      const authz = authorizeMeshClient(config, opts);
      if (!authz.ok) {
        sendError(opts, authz.reason, { identity: authz.identity });
        return;
      }
      const agentAuthzError = authorizeAgent(config, opts.params);
      if (agentAuthzError) {
        sendError(opts, agentAuthzError);
        return;
      }
      const taskId = stringValue(opts.params.task_id) ?? randomUUID();
      const message = stringValue(opts.params.message);
      if (!message) {
        sendError(opts, "message_required");
        return;
      }
      const taskParams: Record<string, unknown> = {
        ...opts.params,
        task_id: taskId,
        from_identity: authz.identity,
      };
      const accepted = buildMeshEvent(taskParams, "accepted", {
        reply_target: opts.client?.connId ? { conn_id: opts.client.connId } : undefined,
      });
      emitToCurrentClient(opts, "mesh.task", accepted);
      opts.respond(true, accepted);
      void runMeshTask({
        api,
        opts,
        eventParams: taskParams,
        taskId,
        message,
        title: stringValue(taskParams.title),
        model: stringValue(taskParams.model),
      });
    });
  },
};

export default plugin;
