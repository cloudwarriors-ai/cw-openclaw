import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import WebSocket from "ws";
import { runCronIsolatedAgentTurn } from "../../src/cron/isolated-agent.js";
import type { CronJob } from "../../src/cron/types.js";
import { MESH_SCOPE } from "../../src/gateway/operator-scopes.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/types.js";
import { postTaskCompletion, postTaskTransition } from "./omni-mem.js";

const DEFAULT_OMNI_MEM_URL = "http://localhost:8765";
const DEFAULT_OMNI_MEM_WORKSPACE = "default";

type MeshGatewayConfig = {
  enabled: boolean;
  displayName?: string;
  agentIdentity?: string;
  allowedUsers: string[];
  allowedAgents: string[];
  rosterPath?: string;
  omniMem: {
    enabled: boolean;
    url: string;
    workspaceId: string;
  };
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

function resolveOmniMemConfig(
  raw: Record<string, unknown> | undefined,
): MeshGatewayConfig["omniMem"] {
  const explicitEnabled = typeof raw?.enabled === "boolean" ? raw.enabled : undefined;
  const url = stringValue(raw?.url) ?? DEFAULT_OMNI_MEM_URL;
  const workspaceId = stringValue(raw?.workspaceId) ?? DEFAULT_OMNI_MEM_WORKSPACE;
  return {
    enabled: explicitEnabled ?? Boolean(url),
    url,
    workspaceId,
  };
}

function resolveConfig(raw: Record<string, unknown> | undefined): MeshGatewayConfig {
  const omniMemRaw =
    raw && typeof raw.omniMem === "object" && raw.omniMem !== null && !Array.isArray(raw.omniMem)
      ? (raw.omniMem as Record<string, unknown>)
      : undefined;
  return {
    enabled: raw?.enabled === true,
    displayName: stringValue(raw?.displayName),
    agentIdentity: stringValue(raw?.agentIdentity),
    allowedUsers: stringArray(raw?.allowedUsers),
    allowedAgents: stringArray(raw?.allowedAgents),
    rosterPath: stringValue(raw?.rosterPath),
    omniMem: resolveOmniMemConfig(omniMemRaw),
  };
}

function shouldWriteToOmniMem(config: MeshGatewayConfig): boolean {
  return Boolean(config.omniMem.enabled && config.omniMem.url && config.agentIdentity);
}

function recordTransitionBestEffort(
  config: MeshGatewayConfig,
  args: { taskId: string; status: "accepted" | "executing"; note?: string },
) {
  if (!shouldWriteToOmniMem(config)) {
    return;
  }
  void postTaskTransition({
    omniMemUrl: config.omniMem.url,
    workspaceId: config.omniMem.workspaceId,
    taskId: args.taskId,
    status: args.status,
    actor: config.agentIdentity as string,
    note: args.note,
  }).then((res) => {
    if (!res?.ok && !res?.skipped) {
      // eslint-disable-next-line no-console
      console.warn(`[mesh-gateway] omni-mem transition write failed: ${res?.error ?? "unknown"}`);
    }
  });
}

function recordCompletionBestEffort(
  config: MeshGatewayConfig,
  args: {
    taskId: string;
    status: "completed" | "failed" | "rejected";
    summary?: string;
    details?: string;
  },
) {
  if (!shouldWriteToOmniMem(config)) {
    return;
  }
  void postTaskCompletion({
    omniMemUrl: config.omniMem.url,
    workspaceId: config.omniMem.workspaceId,
    taskId: args.taskId,
    status: args.status,
    actor: config.agentIdentity as string,
    summary: args.summary,
    details: args.details,
  }).then((res) => {
    if (!res?.ok && !res?.skipped) {
      // eslint-disable-next-line no-console
      console.warn(`[mesh-gateway] omni-mem completion write failed: ${res?.error ?? "unknown"}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Outbound mesh client types and helpers
// ---------------------------------------------------------------------------

type RosterAgent = {
  gateway_url: string;
  expected_identity?: string;
  display_name?: string;
  token?: string;
};

type Roster = {
  agents: Record<string, RosterAgent>;
};

type WsFrame = {
  type: "req" | "res" | "event";
  id?: string;
  ok?: boolean;
  method?: string;
  event?: string;
  params?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  error?: { message?: string };
};

const MESH_CONNECT_TIMEOUT_MS = 8_000;
const MESH_SEND_TIMEOUT_MS = 10_000;
const MESH_SYNC_TIMEOUT_MS = 120_000;
const FINAL_TASK_STATES = new Set(["completed", "failed", "rejected"]);

function defaultRosterPath(): string {
  return path.join(os.homedir(), ".chad-agent", "mesh-roster.json");
}

function wsUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl.replace(/\/$/, ""));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function tokenValue(agent: RosterAgent): string | undefined {
  const raw = (agent.token ?? "").trim();
  if (!raw) {
    return undefined;
  }
  if (raw.toLowerCase().startsWith("bearer ")) {
    return raw.slice(7).trim() || undefined;
  }
  return raw;
}

async function loadRoster(rosterPath: string): Promise<Roster> {
  let raw: string;
  try {
    raw = await fs.readFile(rosterPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? `Roster file not found: ${rosterPath}`
        : `Failed to read roster file: ${(err as Error).message}`,
      { cause: err },
    );
  }
  try {
    return JSON.parse(raw) as Roster;
  } catch {
    throw new Error(`Roster file is not valid JSON: ${rosterPath}`);
  }
}

function lookupAgent(roster: Roster, agentName: string): RosterAgent {
  const agent = roster.agents?.[agentName];
  if (!agent) {
    const available = Object.keys(roster.agents ?? {}).join(", ") || "(none)";
    throw new Error(`Agent "${agentName}" not found in roster. Available: ${available}`);
  }
  return agent;
}

class MeshClient {
  private ws: WebSocket | null = null;
  private connId: string | null = null;
  private readonly agent: RosterAgent;
  private readonly fromDisplayName: string;

  constructor(agent: RosterAgent, fromDisplayName: string) {
    this.agent = agent;
    this.fromDisplayName = fromDisplayName;
  }

  async connect(timeoutMs: number): Promise<void> {
    const url = wsUrl(this.agent.gateway_url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`WebSocket connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const token = tokenValue(this.agent);
    const connectParams: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        displayName: this.fromDisplayName,
        version: "chad-agent/0.2.0",
        platform: "typescript",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.mesh"],
    };
    if (token) {
      connectParams["auth"] = { token };
    }
    const res = await this.rpc("connect", connectParams, timeoutMs);
    if (!res.ok) {
      throw new Error(`Mesh connect rejected: ${res.error?.message ?? "unknown error"}`);
    }
    const server = res.payload?.["server"] as Record<string, unknown> | undefined;
    this.connId = typeof server?.["connId"] === "string" ? server["connId"] : null;
  }

  async rpc(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<WsFrame> {
    if (!this.ws) {
      throw new Error("WebSocket not connected");
    }
    const reqId = randomUUID();
    const frame: WsFrame = { type: "req", id: reqId, method, params };
    this.ws.send(JSON.stringify(frame));
    return this.recvUntil(reqId, timeoutMs);
  }

  async recvUntil(expectedId: string | null, timeoutMs: number): Promise<WsFrame> {
    if (!this.ws) {
      throw new Error("WebSocket not connected");
    }
    const ws = this.ws;
    return new Promise<WsFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for response (${timeoutMs}ms)`));
      }, timeoutMs);

      function onMessage(data: WebSocket.RawData) {
        let frame: WsFrame;
        try {
          const raw =
            typeof data === "string"
              ? data
              : Buffer.isBuffer(data)
                ? data.toString("utf8")
                : Array.isArray(data)
                  ? Buffer.concat(data).toString("utf8")
                  : Buffer.from(data).toString("utf8");
          frame = JSON.parse(raw) as WsFrame;
        } catch {
          return;
        }
        if (frame.type === "event") {
          // keep receiving — don't resolve on events when waiting for a specific id
          if (expectedId === null) {
            cleanup();
            resolve(frame);
          }
          return;
        }
        if (expectedId === null || frame.id === expectedId) {
          cleanup();
          resolve(frame);
        }
      }

      function onError(err: Error) {
        cleanup();
        reject(err);
      }

      function onClose() {
        cleanup();
        reject(new Error("WebSocket closed unexpectedly"));
      }

      function cleanup() {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("error", onError);
        ws.off("close", onClose);
      }

      ws.on("message", onMessage);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
  }

  async waitForTask(taskId: string, timeoutMs: number): Promise<WsFrame> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timed out waiting for task ${taskId} (${timeoutMs}ms)`);
      }
      const frame = await this.recvUntil(null, remaining);
      if (
        frame.type === "event" &&
        frame.event === "mesh.task" &&
        frame.payload?.["task_id"] === taskId
      ) {
        const status = frame.payload?.["status"] as string | undefined;
        if (status && FINAL_TASK_STATES.has(status)) {
          return frame;
        }
      }
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  get connectionId(): string | null {
    return this.connId;
  }
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
  opts.respond(false, { error, ...extra });
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
    ...extra,
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
  config: MeshGatewayConfig;
  eventParams: Record<string, unknown>;
  taskId: string;
  callerIdentity: string;
  message: string;
  title?: string;
  model?: string;
}) {
  const { api, opts, config, eventParams, taskId, callerIdentity, message, title, model } = params;
  emitToCurrentClient(opts, "mesh.task", buildMeshEvent(eventParams, "running"));
  recordTransitionBestEffort(config, {
    taskId,
    status: "executing",
    note: "Mesh-gateway dispatched to cron isolated-agent runtime.",
  });
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
      sessionKey: `mesh:${callerIdentity}`,
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
    recordCompletionBestEffort(config, {
      taskId,
      status: status,
      summary: result.summary,
      details: result.outputText ?? result.error,
    });
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
    recordCompletionBestEffort(config, {
      taskId,
      status: "failed",
      summary: "Mesh task failed",
      details: messageText,
    });
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
        agentIdentity: { type: "string" },
        allowedUsers: { type: "array", items: { type: "string" } },
        allowedAgents: { type: "array", items: { type: "string" } },
        rosterPath: { type: "string" },
        omniMem: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            url: { type: "string" },
            workspaceId: { type: "string" },
          },
        },
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig);

    // Capture deps from gateway method calls for use in outbound session routing
    let capturedDeps: Record<string, unknown> | null = null;
    function captureDeps(opts: GatewayRequestHandlerOptions): void {
      if (!capturedDeps && opts.context?.deps) {
        capturedDeps = opts.context.deps as Record<string, unknown>;
      }
    }

    async function recordOutboundInMeshSession(
      contactIdentity: string,
      agentName: string,
      outboundMessage: string,
    ): Promise<void> {
      if (!capturedDeps) {
        return;
      }
      const now = Date.now();
      const job: CronJob = {
        id: `mesh-outbound-${randomUUID()}`,
        name: `Outbound to ${agentName}`,
        enabled: true,
        deleteAfterRun: true,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "at", at: new Date(now).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: outboundMessage },
        state: {},
      };
      try {
        await runCronIsolatedAgentTurn({
          cfg: api.config,
          deps: capturedDeps,
          job,
          message: outboundMessage,
          sessionKey: `mesh:${contactIdentity}`,
          lane: "mesh",
        });
      } catch (err) {
        api.logger.error(`Failed to create mesh session for ${contactIdentity}:`, err);
      }
    }

    api.registerGatewayMethod(
      "mesh.health",
      (opts) => {
        captureDeps(opts);
        const authz = authorizeMeshClient(config, opts);
        opts.respond(true, {
          ok: authz.ok,
          enabled: config.enabled,
          gateway_reachable: true,
          tailscale_auth_active: opts.client?.authMethod === "tailscale",
          peer_authorized: authz.ok,
          callback_route_healthy: Boolean(opts.client?.connId),
          caller_identity: authz.identity,
          auth_user: authz.identity,
          gateway_identity: config.agentIdentity,
          agent_identity: config.agentIdentity,
          identity: authz.identity,
          displayName: config.displayName,
          reason: authz.ok ? undefined : authz.reason,
        });
      },
      { scope: MESH_SCOPE },
    );

    api.registerGatewayMethod(
      "mesh.list_capabilities",
      (opts) => {
        const authz = authorizeMeshClient(config, opts);
        if (!authz.ok) {
          sendError(opts, authz.reason, { identity: authz.identity });
          return;
        }
        opts.respond(true, {
          agent: config.displayName ?? "openclaw",
          identity: authz.identity,
          caller_identity: authz.identity,
          auth_user: authz.identity,
          gateway_identity: config.agentIdentity,
          agent_identity: config.agentIdentity,
          methods: ["mesh.health", "mesh.list_capabilities", "mesh.send_task", "mesh.reply"],
          delivery: "async_task_callback",
          task_states: [...TASK_STATES],
        });
      },
      { scope: MESH_SCOPE },
    );

    api.registerGatewayMethod(
      "mesh.reply",
      (opts) => {
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
      },
      { scope: MESH_SCOPE },
    );

    api.registerGatewayMethod(
      "mesh.send_task",
      (opts) => {
        captureDeps(opts);
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
        recordTransitionBestEffort(config, {
          taskId,
          status: "accepted",
          note: `Mesh-gateway accepted task from ${authz.identity}.`,
        });
        void runMeshTask({
          api,
          opts,
          config,
          eventParams: taskParams,
          taskId,
          callerIdentity: authz.identity,
          message,
          title: stringValue(taskParams.title),
          model: stringValue(taskParams.model),
        });
      },
      { scope: MESH_SCOPE },
    );

    // -------------------------------------------------------------------------
    // Outbound agent tools
    // -------------------------------------------------------------------------

    const resolvedRosterPath =
      config.rosterPath ?? process.env["MESH_ROSTER_PATH"] ?? defaultRosterPath();

    api.registerTool({
      name: "mesh_list_agents",
      label: "List Mesh Agents",
      description:
        "List agents on the Tailscale mesh with their online/offline status. Pings each agent's mesh.health endpoint.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params) {
        let roster: Roster;
        try {
          roster = await loadRoster(resolvedRosterPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
            details: { error: msg },
          };
        }

        const agentNames = Object.keys(roster.agents ?? {});
        const results = await Promise.all(
          agentNames.map(async (name) => {
            const agent = roster.agents[name];
            const client = new MeshClient(agent, config.displayName ?? "openclaw");
            try {
              await client.connect(MESH_CONNECT_TIMEOUT_MS);
              const health = await client.rpc("mesh.health", {}, MESH_CONNECT_TIMEOUT_MS);
              client.close();
              const payload = health.payload ?? {};
              return {
                name,
                display_name: agent.display_name ?? name,
                gateway_url: agent.gateway_url,
                online: true,
                gateway_identity: payload["gateway_identity"] ?? payload["agent_identity"],
                authorized: payload["peer_authorized"] === true,
              };
            } catch {
              client.close();
              return {
                name,
                display_name: agent.display_name ?? name,
                gateway_url: agent.gateway_url,
                online: false,
              };
            }
          }),
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
          details: { agents: results },
        };
      },
    });

    api.registerTool({
      name: "mesh_send_task",
      label: "Send Mesh Task",
      description:
        "Send an async task to another agent on the Tailscale mesh. Returns after acceptance — does not wait for completion.",
      parameters: Type.Object({
        agent_name: Type.String({ description: "Target agent name from the roster" }),
        goal: Type.String({ description: "What needs to be done" }),
        context: Type.Optional(Type.String({ description: "Background context" })),
        start: Type.Optional(
          Type.Union([Type.Literal("queued"), Type.Literal("now")], {
            description: 'Start mode: "queued" (default) or "now"',
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const {
          agent_name,
          goal,
          context: ctx,
          start,
        } = params as {
          agent_name: string;
          goal: string;
          context?: string;
          start?: "queued" | "now";
        };

        let roster: Roster;
        try {
          roster = await loadRoster(resolvedRosterPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }) }],
            details: { ok: false, error: msg },
          };
        }

        let agent: RosterAgent;
        try {
          agent = lookupAgent(roster, agent_name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }) }],
            details: { ok: false, error: msg },
          };
        }

        const client = new MeshClient(agent, config.displayName ?? "openclaw");
        try {
          await client.connect(MESH_CONNECT_TIMEOUT_MS);
          const connId = client.connectionId;
          const taskId = randomUUID();
          const fromAgent = config.displayName ?? "openclaw";
          const messageParts = [goal];
          if (ctx) {
            messageParts.push(`Context:\n${ctx}`);
          }
          const message = messageParts.join("\n\n");
          const taskParams: Record<string, unknown> = {
            task_id: taskId,
            from_agent: fromAgent,
            title: `Task from ${fromAgent}`,
            message,
            context: ctx ?? "",
            reply_target: connId ? { conn_id: connId } : undefined,
            requested_start_mode: start === "now" ? "now" : "queued",
          };
          const identity = config.agentIdentity;
          if (identity) {
            taskParams["from_identity"] = identity;
          }
          const res = await client.rpc("mesh.send_task", taskParams, MESH_SEND_TIMEOUT_MS);
          client.close();
          if (!res.ok) {
            const errMsg = res.error?.message ?? "mesh send_task failed";
            const result = { ok: false, error: errMsg };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          }
          const result = {
            ok: true,
            task_id: taskId,
            status: res.payload?.["status"] ?? "accepted",
            agent: agent_name,
          };

          // Record outbound in per-contact mesh session
          const contactIdentity = agent.expected_identity ?? agent_name;
          void recordOutboundInMeshSession(
            contactIdentity,
            agent_name,
            `[Outbound mesh task to ${agent_name}] ${message}`,
          );

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        } catch (err) {
          client.close();
          const msg = err instanceof Error ? err.message : String(err);
          const result = { ok: false, error: msg };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        }
      },
    });

    api.registerTool({
      name: "mesh_send_message",
      label: "Send Mesh Message",
      description:
        "Send a message to another agent on the Tailscale mesh and wait for their response (up to 120s).",
      parameters: Type.Object({
        agent_name: Type.String({ description: "Target agent name from the roster" }),
        message: Type.String({ description: "The message to send" }),
      }),
      async execute(_toolCallId, params) {
        const { agent_name, message } = params as {
          agent_name: string;
          message: string;
        };

        let roster: Roster;
        try {
          roster = await loadRoster(resolvedRosterPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }) }],
            details: { ok: false, error: msg },
          };
        }

        let agent: RosterAgent;
        try {
          agent = lookupAgent(roster, agent_name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: msg }) }],
            details: { ok: false, error: msg },
          };
        }

        const client = new MeshClient(agent, config.displayName ?? "openclaw");
        try {
          await client.connect(MESH_CONNECT_TIMEOUT_MS);
          const connId = client.connectionId;
          const taskId = randomUUID();
          const fromAgent = config.displayName ?? "openclaw";
          const taskParams: Record<string, unknown> = {
            task_id: taskId,
            from_agent: fromAgent,
            title: "Mesh Message",
            message,
            context: "",
            reply_target: connId ? { conn_id: connId } : undefined,
            requested_start_mode: "now",
          };
          const identity = config.agentIdentity;
          if (identity) {
            taskParams["from_identity"] = identity;
          }
          const ack = await client.rpc("mesh.send_task", taskParams, MESH_SEND_TIMEOUT_MS);
          if (!ack.ok) {
            client.close();
            const errMsg = ack.error?.message ?? "mesh send_task failed";
            const result = { ok: false, error: errMsg };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
              details: result,
            };
          }
          const final = await client.waitForTask(taskId, MESH_SYNC_TIMEOUT_MS);
          client.close();
          const status = final.payload?.["status"] as string | undefined;
          const result = {
            ok: status === "completed",
            task_id: taskId,
            status,
            summary: final.payload?.["summary"],
            response: final.payload?.["details"] ?? final.payload?.["summary"],
            agent: agent_name,
          };

          // Record outbound in per-contact mesh session
          const contactIdentity = agent.expected_identity ?? agent_name;
          const responseText =
            typeof result.response === "string" ? result.response : "(no response)";
          void recordOutboundInMeshSession(
            contactIdentity,
            agent_name,
            `[Outbound mesh message to ${agent_name}] ${message}\n\n[Response] ${responseText}`,
          );

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        } catch (err) {
          client.close();
          const msg = err instanceof Error ? err.message : String(err);
          const result = { ok: false, error: msg };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          };
        }
      },
    });
  },
};

export default plugin;
