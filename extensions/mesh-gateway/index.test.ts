import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCronIsolatedAgentTurn } from "../../src/cron/isolated-agent.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../../src/gateway/server-methods/types.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import plugin from "./index.js";

vi.mock("../../src/cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: vi.fn(async () => ({
    status: "ok",
    summary: "done",
    outputText: "completed result",
    delivered: false,
  })),
}));

function createApi(pluginConfigOverrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, GatewayRequestHandler>();
  const warn = vi.fn();
  const api = {
    id: "mesh-gateway",
    name: "Mesh Gateway",
    source: "extensions/mesh-gateway/index.ts",
    config: {},
    pluginConfig: {
      enabled: true,
      displayName: "Chad Agent",
      allowedUsers: ["chad.simon@cloudwarriors.ai"],
      ...pluginConfigOverrides,
    },
    runtime: {},
    logger: {
      info: vi.fn(),
      warn,
      error: vi.fn(),
    },
    registerGatewayMethod(method: string, handler: GatewayRequestHandler) {
      handlers.set(method, handler);
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (input: string) => input,
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
  plugin.register(api);
  return { api, handlers, warn };
}

function createOptions(
  params: Record<string, unknown> = {},
  overrides: Partial<GatewayRequestHandlerOptions> = {},
) {
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  const opts = {
    req: { type: "req", id: "1", method: "mesh.health", params },
    params,
    client: {
      connId: "conn-1",
      authMethod: "tailscale",
      authUser: "chad.simon@cloudwarriors.ai",
      connect: { role: "operator", scopes: ["operator.mesh"] },
    },
    isWebchatConnect: vi.fn(),
    respond,
    context: {
      deps: {},
      broadcastToConnIds,
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions & {
    respond: ReturnType<typeof vi.fn>;
    context: { broadcastToConnIds: ReturnType<typeof vi.fn> };
  };
  return opts;
}

describe("mesh-gateway plugin", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no-op fetch mock so the completion-memory POST never touches
    // a real network. Individual tests can capture calls by inspecting
    // `fetchMock.mock.calls` or by replacing the implementation.
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "mem-test" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers the mesh RPC surface", () => {
    const { handlers } = createApi();
    expect([...handlers.keys()].sort()).toEqual([
      "mesh.health",
      "mesh.list_capabilities",
      "mesh.reply",
      "mesh.send_task",
    ]);
  });

  it("reports Tailscale authorization state in mesh.health", () => {
    const { handlers } = createApi();
    const opts = createOptions();
    handlers.get("mesh.health")?.(opts);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        enabled: true,
        tailscale_auth_active: true,
        peer_authorized: true,
        identity: "chad.simon@cloudwarriors.ai",
      }),
    );
  });

  it("rejects non-allowlisted Tailscale users", () => {
    const { handlers } = createApi();
    const opts = createOptions(
      {},
      { client: { authMethod: "tailscale", authUser: "nope@example.com" } as never },
    );
    handlers.get("mesh.list_capabilities")?.(opts);
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ error: "identity_not_allowlisted" }),
    );
  });

  it("rejects invalid replies", () => {
    const { handlers } = createApi();
    const opts = createOptions({ task_id: "task-1", status: "nonsense" });
    handlers.get("mesh.reply")?.(opts);
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ error: "invalid_reply_payload" }),
    );
  });

  it("runs a valid mesh task and emits accepted/running/completed callbacks", async () => {
    const { handlers } = createApi();
    const opts = createOptions({
      task_id: "task-1",
      from_agent: "daniel",
      title: "Try mesh",
      message: "Say hello",
      model: "ollama/gemma4:26b",
    });

    handlers.get("mesh.send_task")?.(opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ task_id: "task-1", status: "accepted" }),
    );
    expect(runCronIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Say hello",
        sessionKey: "mesh:task-1",
        job: expect.objectContaining({
          payload: expect.objectContaining({
            kind: "agentTurn",
            message: "Say hello",
            model: "ollama/gemma4:26b",
          }),
        }),
      }),
    );
    await vi.waitFor(() => {
      expect(opts.context.broadcastToConnIds).toHaveBeenCalledWith(
        "mesh.task",
        expect.objectContaining({ task_id: "task-1", status: "completed" }),
        new Set(["conn-1"]),
      );
    });
    expect(opts.context.broadcastToConnIds).toHaveBeenCalledWith(
      "mesh.task",
      expect.objectContaining({ task_id: "task-1", status: "accepted" }),
      new Set(["conn-1"]),
    );
    expect(opts.context.broadcastToConnIds).toHaveBeenCalledWith(
      "mesh.task",
      expect.objectContaining({ task_id: "task-1", status: "running" }),
      new Set(["conn-1"]),
    );
  });

  it("posts a task-completed memory with a <task-meta> block after a successful run", async () => {
    const { handlers } = createApi({ localOmniMemUrl: "http://127.0.0.1:9999" });
    const opts = createOptions({
      task_id: "task-completion-1",
      from_agent: "daniel",
      dispatched_by: "chad.simon@cloudwarriors.ai",
      title: "mesh test",
      message: "run it",
    });

    handlers.get("mesh.send_task")?.(opts);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9999/api/save-memory");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.title).toBe("task-completed:task-completion-1");
    expect(body.workspaceId).toBe("default");
    expect(body.text).toContain("<task-meta>");
    expect(body.text).toContain("</task-meta>");
    const metaMatch = (body.text as string).match(/<task-meta>(.*)<\/task-meta>/s);
    expect(metaMatch).toBeTruthy();
    const meta = JSON.parse(metaMatch![1]!);
    expect(meta).toMatchObject({
      kind: "task_completion_record",
      task_id: "task-completion-1",
      status: "completed",
      completed_by: "chad.simon@cloudwarriors.ai",
      from_agent: "daniel",
      dispatched_by: "chad.simon@cloudwarriors.ai",
      simulated: false,
    });
    expect(meta.completed_at).toBeTruthy();
  });

  it("records a failure completion when the isolated agent errors", async () => {
    const mocked = vi.mocked(runCronIsolatedAgentTurn);
    mocked.mockRejectedValueOnce(new Error("isolated boom"));
    const { handlers } = createApi();
    const opts = createOptions({
      task_id: "task-failure-1",
      from_agent: "daniel",
      dispatched_by: "chad@test",
      message: "run it",
    });

    handlers.get("mesh.send_task")?.(opts);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    const meta = JSON.parse((body.text as string).match(/<task-meta>(.*)<\/task-meta>/s)![1]!);
    expect(meta.status).toBe("failed");
    expect(meta.task_id).toBe("task-failure-1");
  });

  it("skips completion-memory POST when completionMemoryEnabled=false", async () => {
    const { handlers } = createApi({ completionMemoryEnabled: false });
    const opts = createOptions({
      task_id: "task-opt-out",
      from_agent: "daniel",
      message: "run",
    });

    handlers.get("mesh.send_task")?.(opts);

    await vi.waitFor(() => {
      expect(opts.context.broadcastToConnIds).toHaveBeenCalledWith(
        "mesh.task",
        expect.objectContaining({ task_id: "task-opt-out", status: "completed" }),
        new Set(["conn-1"]),
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs and swallows completion-memory save failures", async () => {
    const { handlers, warn } = createApi();
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const opts = createOptions({
      task_id: "task-save-fail",
      from_agent: "daniel",
      message: "run",
    });

    handlers.get("mesh.send_task")?.(opts);

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    const warnMessage = String(warn.mock.calls[0]![0]);
    expect(warnMessage).toContain("task-save-fail");
    expect(warnMessage).toContain("500");
  });
});
