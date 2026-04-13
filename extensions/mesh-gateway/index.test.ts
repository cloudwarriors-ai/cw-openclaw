import { beforeEach, describe, expect, it, vi } from "vitest";
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

function createApi() {
  const handlers = new Map<string, GatewayRequestHandler>();
  const api = {
    id: "mesh-gateway",
    name: "Mesh Gateway",
    source: "extensions/mesh-gateway/index.ts",
    config: {},
    pluginConfig: {
      enabled: true,
      displayName: "Chad Agent",
      agentIdentity: "agent@cloudwarriors.ai",
      allowedUsers: ["chad.simon@cloudwarriors.ai"],
    },
    runtime: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
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
  return { api, handlers };
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the mesh RPC surface", () => {
    const { handlers } = createApi();
    expect([...handlers.keys()].toSorted()).toEqual([
      "mesh.health",
      "mesh.list_capabilities",
      "mesh.reply",
      "mesh.send_task",
    ]);
  });

  it("reports Tailscale authorization state in mesh.health", () => {
    const { handlers } = createApi();
    const opts = createOptions();
    void handlers.get("mesh.health")?.(opts);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        enabled: true,
        tailscale_auth_active: true,
        peer_authorized: true,
        identity: "chad.simon@cloudwarriors.ai",
        caller_identity: "chad.simon@cloudwarriors.ai",
        gateway_identity: "agent@cloudwarriors.ai",
        agent_identity: "agent@cloudwarriors.ai",
      }),
    );
  });

  it("rejects non-allowlisted Tailscale users", () => {
    const { handlers } = createApi();
    const opts = createOptions(
      {},
      { client: { authMethod: "tailscale", authUser: "nope@example.com" } as never },
    );
    void handlers.get("mesh.list_capabilities")?.(opts);
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ error: "identity_not_allowlisted" }),
    );
  });

  it("rejects invalid replies", () => {
    const { handlers } = createApi();
    const opts = createOptions({ task_id: "task-1", status: "nonsense" });
    void handlers.get("mesh.reply")?.(opts);
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

    void handlers.get("mesh.send_task")?.(opts);

    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ task_id: "task-1", status: "accepted" }),
    );
    expect(runCronIsolatedAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Say hello",
        sessionKey: "mesh:chad.simon@cloudwarriors.ai",
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
});
