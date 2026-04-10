import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join, dirname } from "path";

// Minimal type declarations for the OpenClaw Plugin SDK.
// See: https://docs.openclaw.ai/plugin

interface PluginLogger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface PluginServiceContext {
  config: Record<string, unknown>;
  workspaceDir?: string;
  stateDir: string;
  logger: PluginLogger;
}

interface PluginCommandContext {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
}

type PluginCommandResult = string | { text: string } | { text: string; format?: string };

interface BeforeAgentStartEvent {
  prompt?: string;
}
interface ToolResultPersistEvent {
  toolName?: string;
  params?: Record<string, unknown>;
  message?: { content?: Array<{ type: string; text?: string }> };
}
interface AgentEndEvent {
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
}
interface SessionStartEvent {
  sessionId: string;
  resumedFrom?: string;
}
interface AfterCompactionEvent {
  messageCount: number;
  tokenCount?: number;
  compactedCount: number;
}
interface SessionEndEvent {
  sessionId: string;
  messageCount: number;
  durationMs?: number;
}
interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}
interface EventContext {
  sessionKey?: string;
  workspaceDir?: string;
  agentId?: string;
}
interface MessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}

type EventCallback<T> = (event: T, ctx: EventContext) => void | Promise<void>;
type MessageEventCallback<T> = (event: T, ctx: MessageContext) => void | Promise<void>;

interface AgentToolResult {
  content: Array<{ type: string; text?: string }>;
}

interface AgentTool {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<AgentToolResult>;
}

interface PluginToolContext {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
  channelSlug?: string;
  isSupport?: boolean;
  defaultMemoryScope?: string;
  allowAllCustomersMemoryScope?: boolean;
  excludeMemorySlugs?: string[];
}

type PluginToolFactory = (ctx: PluginToolContext) => AgentTool | AgentTool[] | null | undefined;

interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  registerTool: (
    tool: AgentTool | PluginToolFactory,
    opts?: { optional?: boolean; names?: string[] },
  ) => void;
  registerService: (service: {
    id: string;
    start: (ctx: PluginServiceContext) => void | Promise<void>;
    stop?: (ctx: PluginServiceContext) => void | Promise<void>;
  }) => void;
  registerCommand: (command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }) => void;
  on: ((event: "before_agent_start", callback: EventCallback<BeforeAgentStartEvent>) => void) &
    ((event: "tool_result_persist", callback: EventCallback<ToolResultPersistEvent>) => void) &
    ((event: "agent_end", callback: EventCallback<AgentEndEvent>) => void) &
    ((event: "session_start", callback: EventCallback<SessionStartEvent>) => void) &
    ((event: "session_end", callback: EventCallback<SessionEndEvent>) => void) &
    ((event: "message_received", callback: MessageEventCallback<MessageReceivedEvent>) => void) &
    ((event: "after_compaction", callback: EventCallback<AfterCompactionEvent>) => void) &
    ((event: "gateway_start", callback: EventCallback<Record<string, never>>) => void);
  runtime: {
    channel: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;
    tools?: {
      createMemorySearchTool?: (opts: Record<string, unknown>) => AgentTool | null;
      createMemoryGetTool?: (opts: Record<string, unknown>) => AgentTool | null;
    };
  };
}

// ============================================================================
// Plugin Configuration
// ============================================================================

interface ClaudeMemPluginConfig {
  syncMemoryFile?: boolean;
  project?: string;
  workerPort?: number;
}

const DEFAULT_WORKER_PORT = 37777;
const CLAUDE_MEM_DATA_DIR = "/root/.claude-mem";

function optionalStringParam(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function stringParam(value: unknown, fallback = ""): string {
  return optionalStringParam(value) ?? fallback;
}

function numberParam(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

// ============================================================================
// Worker HTTP Client
// ============================================================================

function workerBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function workerPost(
  port: number,
  path: string,
  body: Record<string, unknown>,
  logger: PluginLogger,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${workerBaseUrl(port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      logger.warn(`[claude-mem] Worker POST ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as Record<string, unknown>;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
    return null;
  }
}

function workerPostFireAndForget(
  port: number,
  path: string,
  body: Record<string, unknown>,
  logger: PluginLogger,
): void {
  fetch(`${workerBaseUrl(port)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[claude-mem] Worker POST ${path} failed: ${message}`);
  });
}

async function workerGetText(
  port: number,
  path: string,
  logger: PluginLogger,
): Promise<string | null> {
  try {
    const response = await fetch(`${workerBaseUrl(port)}${path}`);
    if (!response.ok) {
      logger.warn(`[claude-mem] Worker GET ${path} returned ${response.status}`);
      return null;
    }
    return await response.text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[claude-mem] Worker GET ${path} failed: ${message}`);
    return null;
  }
}

// ============================================================================
// Worker Process Management
// ============================================================================

let workerProcess: ChildProcess | null = null;

function ensureDataDir(): void {
  if (!existsSync(CLAUDE_MEM_DATA_DIR)) {
    mkdirSync(CLAUDE_MEM_DATA_DIR, { recursive: true });
  }
  const logsDir = join(CLAUDE_MEM_DATA_DIR, "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
}

function ensureSettings(port: number): void {
  const settingsPath = join(CLAUDE_MEM_DATA_DIR, "settings.json");
  if (!existsSync(settingsPath)) {
    const settings = {
      workerPort: port,
      dataDir: CLAUDE_MEM_DATA_DIR,
      logLevel: "info",
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }
}

async function startWorker(port: number, logger: PluginLogger): Promise<boolean> {
  // Find the worker binary relative to this extension
  const workerPath = join(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "worker",
    "worker-service.cjs",
  );

  if (!existsSync(workerPath)) {
    logger.error(`[claude-mem] Worker binary not found at ${workerPath}`);
    return false;
  }

  ensureDataDir();
  ensureSettings(port);

  // Use full path to bun — PATH may not include /root/.bun/bin inside Docker
  const bunBin = existsSync("/root/.bun/bin/bun") ? "/root/.bun/bin/bun" : "bun";
  logger.info(`[claude-mem] Starting worker: ${bunBin} ${workerPath} start`);

  workerProcess = spawn(bunBin, [workerPath, "start"], {
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: CLAUDE_MEM_DATA_DIR,
      CLAUDE_MEM_WORKER_PORT: String(port),
      CLAUDE_MEM_WORKER_HOST: "0.0.0.0",
      // Point to external Chroma container instead of spawning local
      CLAUDE_MEM_CHROMA_MODE: "external",
      CLAUDE_MEM_CHROMA_HOST: "claude-mem-chroma",
      CLAUDE_MEM_CHROMA_PORT: "8000",
      // Ensure OpenRouter provider config is set
      CLAUDE_MEM_PROVIDER: "openrouter",
      CLAUDE_MEM_OPENROUTER_MODEL: "anthropic/claude-sonnet-4-5",
      CLAUDE_MEM_OPENROUTER_APP_NAME: "moltbot-claude-mem",
      // Pass through the OpenRouter API key from gateway env
      CLAUDE_MEM_OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  workerProcess.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      logger.info(`[claude-mem:worker] ${line}`);
    }
  });

  workerProcess.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      logger.warn(`[claude-mem:worker] ${line}`);
    }
  });

  workerProcess.on("exit", (code: number | null) => {
    logger.warn(`[claude-mem] Worker process exited with code ${code}`);
    workerProcess = null;
  });

  // Wait for worker to become healthy (up to 15 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${workerBaseUrl(port)}/api/health`);
      if (res.ok) {
        logger.info(`[claude-mem] Worker is healthy on port ${port}`);
        return true;
      }
    } catch {
      // Worker not ready yet
    }
  }

  logger.error("[claude-mem] Worker failed to start within 15 seconds");
  return false;
}

function stopWorker(logger: PluginLogger): void {
  if (workerProcess) {
    logger.info("[claude-mem] Stopping worker process");
    workerProcess.kill("SIGTERM");
    workerProcess = null;
  }
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

export default function claudeMemPlugin(api: OpenClawPluginApi): void {
  const userConfig = (api.pluginConfig || {}) as ClaudeMemPluginConfig;
  const workerPort = userConfig.workerPort || DEFAULT_WORKER_PORT;
  const baseProjectName = userConfig.project || "openclaw";

  function getProjectName(_ctx: EventContext): string {
    return baseProjectName;
  }

  // Session tracking
  const sessionIds = new Map<string, string>();
  const workspaceDirsBySessionKey = new Map<string, string>();
  const syncMemoryFile = userConfig.syncMemoryFile !== false;

  function getContentSessionId(sessionKey?: string): string {
    const key = sessionKey || "default";
    if (!sessionIds.has(key)) {
      sessionIds.set(key, `openclaw-${key}-${Date.now()}`);
    }
    return sessionIds.get(key)!;
  }

  async function syncMemoryToWorkspace(workspaceDir: string, ctx?: EventContext): Promise<void> {
    const projects = [baseProjectName];
    const agentProject = ctx ? getProjectName(ctx) : null;
    if (agentProject && agentProject !== baseProjectName) {
      projects.push(agentProject);
    }
    const contextText = await workerGetText(
      workerPort,
      `/api/context/inject?projects=${encodeURIComponent(projects.join(","))}`,
      api.logger,
    );
    if (contextText && contextText.trim().length > 0) {
      try {
        await writeFile(join(workspaceDir, "MEMORY.md"), contextText, "utf-8");
        api.logger.info(`[claude-mem] MEMORY.md synced to ${workspaceDir}`);
      } catch (writeError: unknown) {
        const msg = writeError instanceof Error ? writeError.message : String(writeError);
        api.logger.warn(`[claude-mem] Failed to write MEMORY.md: ${msg}`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Service: Worker process lifecycle
  // ------------------------------------------------------------------
  api.registerService({
    id: "claude-mem-worker",
    start: async () => {
      const started = await startWorker(workerPort, api.logger);
      if (!started) {
        api.logger.error(
          "[claude-mem] Worker failed to start — plugin will operate in degraded mode",
        );
      }
    },
    stop: async () => {
      stopWorker(api.logger);
    },
  });

  // ------------------------------------------------------------------
  // Event: session_start
  // ------------------------------------------------------------------
  api.on("session_start", async (_event, ctx) => {
    const contentSessionId = getContentSessionId(ctx.sessionKey);
    await workerPost(
      workerPort,
      "/api/sessions/init",
      {
        contentSessionId,
        project: getProjectName(ctx),
        prompt: "",
      },
      api.logger,
    );
    api.logger.info(`[claude-mem] Session initialized: ${contentSessionId}`);
  });

  // ------------------------------------------------------------------
  // Event: message_received
  // ------------------------------------------------------------------
  api.on("message_received", async (event, ctx) => {
    const sessionKey = ctx.conversationId || ctx.channelId || "default";
    const contentSessionId = getContentSessionId(sessionKey);
    await workerPost(
      workerPort,
      "/api/sessions/init",
      {
        contentSessionId,
        project: baseProjectName,
        prompt: event.content || "[media prompt]",
      },
      api.logger,
    );
  });

  // ------------------------------------------------------------------
  // Event: after_compaction
  // ------------------------------------------------------------------
  api.on("after_compaction", async (_event, ctx) => {
    const contentSessionId = getContentSessionId(ctx.sessionKey);
    await workerPost(
      workerPort,
      "/api/sessions/init",
      {
        contentSessionId,
        project: getProjectName(ctx),
        prompt: "",
      },
      api.logger,
    );
    api.logger.info(`[claude-mem] Session re-initialized after compaction: ${contentSessionId}`);
  });

  // ------------------------------------------------------------------
  // Event: before_agent_start
  // ------------------------------------------------------------------
  api.on("before_agent_start", async (event, ctx) => {
    if (ctx.workspaceDir) {
      workspaceDirsBySessionKey.set(ctx.sessionKey || "default", ctx.workspaceDir);
    }
    const contentSessionId = getContentSessionId(ctx.sessionKey);
    await workerPost(
      workerPort,
      "/api/sessions/init",
      {
        contentSessionId,
        project: getProjectName(ctx),
        prompt: event.prompt || "agent run",
      },
      api.logger,
    );
    const isPulsebot =
      ctx.agentId === "pulsebot" ||
      (ctx.sessionKey || "").includes("pulsebot") ||
      (ctx.workspaceDir || "").includes("pulsebot");
    if (syncMemoryFile && ctx.workspaceDir && !isPulsebot) {
      await syncMemoryToWorkspace(ctx.workspaceDir, ctx);
    }
  });

  // ------------------------------------------------------------------
  // Event: tool_result_persist
  // ------------------------------------------------------------------
  api.on("tool_result_persist", (event, ctx) => {
    const toolName = event.toolName;
    if (!toolName) {
      return;
    }
    const contentSessionId = getContentSessionId(ctx.sessionKey);
    let toolResponseText = "";
    const content = event.message?.content;
    if (Array.isArray(content)) {
      toolResponseText = content
        .filter(
          (block) => (block.type === "tool_result" || block.type === "text") && "text" in block,
        )
        .map((block) => String(block.text))
        .join("\n");
    }
    workerPostFireAndForget(
      workerPort,
      "/api/sessions/observations",
      {
        contentSessionId,
        tool_name: toolName,
        tool_input: event.params || {},
        tool_response: toolResponseText,
        cwd: "",
      },
      api.logger,
    );
    const workspaceDir =
      ctx.workspaceDir || workspaceDirsBySessionKey.get(ctx.sessionKey || "default");
    const isPulsebotTrp =
      ctx.agentId === "pulsebot" ||
      (ctx.sessionKey || "").includes("pulsebot") ||
      (workspaceDir || "").includes("pulsebot");
    if (syncMemoryFile && workspaceDir && !isPulsebotTrp) {
      void syncMemoryToWorkspace(workspaceDir, ctx);
    }
  });

  // ------------------------------------------------------------------
  // Event: agent_end
  // ------------------------------------------------------------------
  api.on("agent_end", async (event, ctx) => {
    const contentSessionId = getContentSessionId(ctx.sessionKey);
    let lastAssistantMessage = "";
    if (Array.isArray(event.messages)) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const message = event.messages[i];
        if (message?.role === "assistant") {
          if (typeof message.content === "string") {
            lastAssistantMessage = message.content;
          } else if (Array.isArray(message.content)) {
            lastAssistantMessage = message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text || "")
              .join("\n");
          }
          break;
        }
      }
    }
    await workerPost(
      workerPort,
      "/api/sessions/summarize",
      {
        contentSessionId,
        last_assistant_message: lastAssistantMessage,
      },
      api.logger,
    );
    workerPostFireAndForget(
      workerPort,
      "/api/sessions/complete",
      {
        contentSessionId,
      },
      api.logger,
    );
  });

  // ------------------------------------------------------------------
  // Event: session_end
  // ------------------------------------------------------------------
  api.on("session_end", async (_event, ctx) => {
    const key = ctx.sessionKey || "default";
    sessionIds.delete(key);
    workspaceDirsBySessionKey.delete(key);
  });

  // ------------------------------------------------------------------
  // Event: gateway_start
  // ------------------------------------------------------------------
  api.on("gateway_start", async () => {
    workspaceDirsBySessionKey.clear();
    sessionIds.clear();
    api.logger.info("[claude-mem] Gateway started — session tracking reset");
  });

  // ------------------------------------------------------------------
  // Command: /claude-mem-status
  // ------------------------------------------------------------------
  api.registerCommand({
    name: "claude-mem-status",
    description: "Check Claude-Mem worker health and session status",
    handler: async () => {
      const healthText = await workerGetText(workerPort, "/api/health", api.logger);
      if (!healthText) {
        return `Claude-Mem worker unreachable at port ${workerPort}`;
      }
      try {
        const health = JSON.parse(healthText);
        return [
          "Claude-Mem Worker Status",
          `Status: ${health.status || "unknown"}`,
          `Port: ${workerPort}`,
          `Active sessions: ${sessionIds.size}`,
          `Worker PID: ${workerProcess?.pid || "unknown"}`,
        ].join("\n");
      } catch {
        return "Claude-Mem worker responded but returned unexpected data";
      }
    },
  });

  // ------------------------------------------------------------------
  // Debug/telemetry tools: obs_search, obs_save (observation layer)
  // ------------------------------------------------------------------

  api.registerTool(
    {
      name: "obs_search",
      label: "Observation Search",
      description:
        "Search debug/telemetry observations from past tool calls, decisions, and session history. " +
        "Use this for episodic debugging exploration, NOT for support/document retrieval (use memory_search for that). " +
        "Returns matching observations with IDs, titles, and summaries.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          type: {
            type: "string",
            description:
              "Filter by observation type: bugfix, feature, refactor, discovery, decision, change",
          },
          limit: { type: "number", description: "Max results to return (default 10)" },
          project: { type: "string", description: "Filter by project name (default: all)" },
        },
        required: ["query"],
      },
      execute: async (_toolCallId, params) => {
        const query = stringParam(params.query);
        const limit = numberParam(params.limit, 10);
        const type = optionalStringParam(params.type);
        const project = optionalStringParam(params.project);

        const qs = new URLSearchParams({ query, limit: String(limit) });
        if (type) {
          qs.set("type", type);
        }
        if (project) {
          qs.set("project", project);
        }

        const result = await workerGetText(
          workerPort,
          `/api/search/observations?${qs}`,
          api.logger,
        );
        if (result) {
          return { content: [{ type: "text", text: result }] };
        }

        const context = await workerGetText(
          workerPort,
          `/api/context/inject?projects=${project || baseProjectName}`,
          api.logger,
        );
        if (context) {
          return {
            content: [
              {
                type: "text",
                text: `[Observation context — search unavailable, showing recent context]\n\n${context}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: "Observation search unavailable — worker may still be initializing.",
            },
          ],
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "obs_save",
      label: "Save Observation",
      description:
        "Manually save a debug observation, decision, or fact to the telemetry layer. " +
        "Use this when you learn something important that should be remembered across sessions.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The information to save" },
          title: { type: "string", description: "Short title for the observation" },
          type: {
            type: "string",
            description: "Type: bugfix, feature, refactor, discovery, decision, change",
          },
        },
        required: ["text"],
      },
      execute: async (_toolCallId, params) => {
        const text = stringParam(params.text);
        const title = optionalStringParam(params.title);
        const type = optionalStringParam(params.type) ?? "discovery";

        const result = await workerPost(
          workerPort,
          "/api/memory/save",
          {
            text,
            title,
            type,
            project: baseProjectName,
          },
          api.logger,
        );

        if (result) {
          return {
            content: [{ type: "text", text: `Observation saved: ${title || "(untitled)"}` }],
          };
        }
        return {
          content: [
            { type: "text", text: "Failed to save observation — worker may be unavailable." },
          ],
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "obs_get",
      label: "Get Observations",
      description:
        "Fetch full observation details by IDs. Use after obs_search to get complete details " +
        "for specific observations. Always batch multiple IDs in a single call.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "number" },
            description: "Array of observation IDs to fetch (from obs_search results)",
          },
        },
        required: ["ids"],
      },
      execute: async (_toolCallId, params) => {
        const ids = Array.isArray(params.ids) ? params.ids.map(Number) : [];
        if (ids.length === 0) {
          return { content: [{ type: "text", text: "No observation IDs provided." }] };
        }
        const result = await workerPost(workerPort, "/api/observations/batch", { ids }, api.logger);
        if (result) {
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        return {
          content: [
            { type: "text", text: "Failed to fetch observations — worker may be unavailable." },
          ],
        };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "obs_timeline",
      label: "Observation Timeline",
      description:
        "Get chronological context around a specific observation or time period. " +
        "Use this to understand what was happening around a specific event or date.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query or observation ID to get context around",
          },
          limit: { type: "number", description: "Number of observations to return (default 10)" },
        },
        required: ["query"],
      },
      execute: async (_toolCallId, params) => {
        const query = stringParam(params.query);
        const limit = numberParam(params.limit, 10);
        const qs = new URLSearchParams({ query, limit: String(limit) });
        const result = await workerGetText(workerPort, `/api/timeline?${qs}`, api.logger);
        if (result) {
          return { content: [{ type: "text", text: result }] };
        }
        return {
          content: [
            { type: "text", text: "Timeline unavailable — worker may still be initializing." },
          ],
        };
      },
    },
    { optional: true },
  );

  api.logger.info(`[claude-mem] OpenClaw plugin loaded — v1.1.0 (worker: 127.0.0.1:${workerPort})`);
}
