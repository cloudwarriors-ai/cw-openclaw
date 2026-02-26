import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer } from "../../packages/memory-server/src/http-server.js";
import { PipelineAppService } from "../../extensions/slm-pipeline/src/app-service.js";
import { registerSlmPipelineGatewayMethods } from "../../extensions/slm-pipeline/src/gateway-methods.js";
import { InMemoryQaSource } from "../../extensions/slm-pipeline/src/qa-ingest.js";
import { QaProjectionService } from "../../extensions/slm-pipeline/src/qa-projection.js";
import { emitPipelineReviewEvent } from "../../extensions/slm-pipeline/src/review-events.js";
import { createSlmPipelineRouter } from "../../extensions/slm-pipeline/src/routes.js";
import { resolveMemoryServerClientFromEnv as resolvePipelineMemoryClientFromEnv } from "../../extensions/slm-pipeline/src/memory-client.js";
import { SlmSupervisorAppService } from "../../extensions/slm-supervisor/src/app-service.js";
import { registerSlmPilotCommand } from "../../extensions/slm-supervisor/src/command-mode.js";
import { registerSlmSupervisorGatewayMethods } from "../../extensions/slm-supervisor/src/gateway-methods.js";
import { resolveMemoryServerClientFromEnv as resolveSupervisorMemoryClientFromEnv } from "../../extensions/slm-supervisor/src/memory-client.js";
import { SlmSupervisorOrchestrator } from "../../extensions/slm-supervisor/src/orchestrator.js";
import { resolveTraceExporterFromEnv } from "../../extensions/slm-supervisor/src/trace-exporter.js";
import { TrainingStudioService } from "../../extensions/slm-supervisor/src/training-studio.js";

type GatewayHandler = (context: {
  params?: unknown;
  client?: { connect?: unknown };
  respond: (ok: boolean, payload: unknown) => void;
}) => Promise<void>;

type CommandHandler = (ctx: {
  senderId?: string;
  channel: string;
  isAuthorizedSender: boolean;
  args?: string;
  commandBody: string;
  config: unknown;
}) => Promise<{ text?: string }>;

type Harness = {
  invokeGatewayMethod: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  invokeCommand: (name: string, args: string) => Promise<{ text?: string }>;
  memoryList: (namespace: string, kind: string) => Promise<Array<{ id: string; tenant_id: string }>>;
  close: () => Promise<void>;
};

describe("slm gateway control e2e", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup.pop()?.();
    }
  });

  it("runs deterministic slm.control.* roundtrip and persists outputs", async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);

    const update = await harness.invokeGatewayMethod<{ record?: { projection_id?: string } }>(
      "slm.control.qa.update",
      {
        tenant_id: "tenant-a",
        question: "How do we run safe deploys?",
        answer: "Use canary rollout, monitor errors, and keep a rollback checkpoint.",
        source_channel: "zoom",
        source_ref: "zoom-msg-qa-update",
      },
    );
    const projectionId = update.record?.projection_id;
    expect(projectionId).toBeTruthy();

    const listed = await harness.invokeGatewayMethod<{ records?: Array<{ projection_id: string }> }>(
      "slm.control.qa.list",
      {
        tenant_id: "tenant-a",
        limit: 10,
      },
    );
    expect(Array.isArray(listed.records) && listed.records.length > 0).toBe(true);

    const fetched = await harness.invokeGatewayMethod<{ record?: { projection_id?: string } }>(
      "slm.control.qa.get",
      {
        tenant_id: "tenant-a",
        projection_id: projectionId,
      },
    );
    expect(fetched.record?.projection_id).toBe(projectionId);

    const enqueue = await harness.invokeGatewayMethod<{
      dataset_id?: string;
      run_id?: string;
      status?: string;
    }>("slm.control.training.enqueue", {
      tenant_id: "tenant-a",
      base_model: "forge/slm-base",
      split_seed: 7,
      idempotency_key: "roundtrip-enqueue-key-001",
    });
    expect(enqueue.dataset_id).toBeTruthy();
    expect(enqueue.run_id).toBeTruthy();

    const start = await harness.invokeGatewayMethod<{ session?: { session_id?: string } }>(
      "slm.control.session.start",
      {
        tenant_id: "tenant-a",
        question: "How should we respond to production incidents?",
      },
    );
    const sessionId = start.session?.session_id;
    expect(sessionId).toBeTruthy();

    const turn = await harness.invokeGatewayMethod<{
      turn?: { turn_id?: string };
      supervisor?: { trace_id?: string };
    }>("slm.control.session.turn", {
      tenant_id: "tenant-a",
      session_id: sessionId,
      user_prompt: "Draft an incident update for customers.",
      edited_answer: "Acknowledge impact, share mitigation, and provide next update ETA.",
    });
    expect(turn.turn?.turn_id).toBeTruthy();
    expect(turn.supervisor?.trace_id).toBeTruthy();

    const finish = await harness.invokeGatewayMethod<{ session?: { status?: string } }>(
      "slm.control.session.finish",
      {
        tenant_id: "tenant-a",
        session_id: sessionId,
      },
    );
    expect(finish.session?.status).toBe("finished");

    const qaRecords = await harness.memoryList("slm.qa.current", "qa_projection");
    expect(qaRecords.length).toBeGreaterThan(0);
    const sessionRecords = await harness.memoryList("slm.training.sessions", "training_session");
    expect(sessionRecords.length).toBeGreaterThan(0);
    const turnRecords = await harness.memoryList("slm.training.sessions", "training_session_turn");
    expect(turnRecords.length).toBeGreaterThan(0);
    const traceRecords = await harness.memoryList("slm.supervisor.trace", "decision_trace");
    expect(traceRecords.length).toBeGreaterThan(0);
  });

  it("supports pilot /slm command mode with fallback path", async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);

    const response = await harness.invokeCommand("slm", "please answer this forbidden policy request");
    expect(response.text).toContain("source_path=frontier_direct_fallback");
    expect(response.text).toContain("trace_id=");
  });
});

async function createHarness(): Promise<Harness> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-e2e-"));
  const memoryToken = "memory-token";
  const memoryTenant = "tenant-a";
  const memoryServer = createMemoryHttpServer({
    authResolver: (token) => {
      if (token !== memoryToken) {
        return null;
      }
      return {
        tenantId: memoryTenant,
        subject: "e2e",
        isAdmin: true,
      };
    },
  });

  memoryServer.listen(0, "127.0.0.1");
  await once(memoryServer, "listening");
  const address = memoryServer.address() as AddressInfo;
  const memoryUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    OPENCLAW_MEMORY_SERVER_URL: memoryUrl,
    OPENCLAW_MEMORY_SERVER_TOKEN: memoryToken,
    OPENCLAW_SLM_PILOT_TENANT: memoryTenant,
  };

  const qaEventsPath = path.join(tmpDir, "review-events.jsonl");
  const qaSource = new InMemoryQaSource();
  qaSource.add({
    tenant_id: memoryTenant,
    source_channel: "zoom",
    source_message_ids: ["seed-1"],
    question: "How do we validate gateway health?",
    answer: "Run health probes and verify channel connectivity.",
    citations: [],
    approved_by: "reviewer",
    approved_at: "2026-02-24T00:00:00.000Z",
  });

  const pipelineRouter = createSlmPipelineRouter({ qaSource });
  const pipelineMemoryClient = resolvePipelineMemoryClientFromEnv(env);
  const qaProjectionService = new QaProjectionService(pipelineMemoryClient);
  const pipelineApp = new PipelineAppService(pipelineRouter, qaProjectionService, {
    emitApprovedEvent: async (input) => {
      const event = await emitPipelineReviewEvent({
        tenantId: input.tenantId,
        eventType: "qa.approved",
        traceId: input.traceId,
        refId: input.refId,
        actorId: input.actor?.actor_id,
        actorName: input.actor?.actor_name,
        sourceChannelJid: input.sourceChannelJid,
        question: input.question,
        answer: input.answer,
        metadata: input.metadata,
        storePath: qaEventsPath,
      });
      return {
        traceId: event.trace_id,
        refId: event.ref_id,
      };
    },
  });

  const supervisorOrchestrator = new SlmSupervisorOrchestrator(
    undefined,
    undefined,
    undefined,
    undefined,
    resolveTraceExporterFromEnv(env),
  );
  const supervisorMemoryClient = resolveSupervisorMemoryClientFromEnv(env);
  const trainingStudio = new TrainingStudioService(supervisorOrchestrator, supervisorMemoryClient);
  const supervisorApp = new SlmSupervisorAppService(supervisorOrchestrator, trainingStudio);

  const gatewayHandlers = new Map<string, GatewayHandler>();
  const commandHandlers = new Map<string, CommandHandler>();
  const api = {
    registerGatewayMethod(method: string, handler: GatewayHandler) {
      gatewayHandlers.set(method, handler);
    },
    registerCommand(definition: { name: string; handler: CommandHandler }) {
      commandHandlers.set(definition.name, definition.handler);
    },
  } as unknown as OpenClawPluginApi;

  registerSlmPipelineGatewayMethods(api, pipelineApp);
  registerSlmSupervisorGatewayMethods(api, supervisorApp);
  registerSlmPilotCommand(api, supervisorApp, env);

  const invokeGatewayMethod = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    const handler = gatewayHandlers.get(method);
    if (!handler) {
      throw new Error(`gateway method not registered: ${method}`);
    }
    let result: { ok: boolean; payload: unknown } | null = null;
    await handler({
      params,
      client: {
        connect: {
          instanceId: "operator-e2e",
          clientName: "operator",
          role: "reviewer",
        },
      },
      respond: (ok, payload) => {
        result = { ok, payload };
      },
    });
    if (!result) {
      throw new Error(`gateway method returned no result: ${method}`);
    }
    if (!result.ok) {
      throw new Error(`gateway method failed (${method}): ${JSON.stringify(result.payload)}`);
    }
    return result.payload as T;
  };

  const invokeCommand = async (name: string, args: string): Promise<{ text?: string }> => {
    const handler = commandHandlers.get(name);
    if (!handler) {
      throw new Error(`command not registered: ${name}`);
    }
    return await handler({
      channel: "telegram",
      isAuthorizedSender: true,
      commandBody: `/${name} ${args}`,
      args,
      config: {},
      senderId: "pilot-operator",
    });
  };

  const memoryList = async (
    namespace: string,
    kind: string,
  ): Promise<Array<{ id: string; tenant_id: string }>> => {
    const response = await fetch(`${memoryUrl}/memories/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${memoryToken}`,
      },
      body: JSON.stringify({
        namespace,
        kind,
        limit: 50,
      }),
    });
    const payload = (await response.json()) as { records?: Array<{ id: string; tenant_id: string }> };
    return Array.isArray(payload.records) ? payload.records : [];
  };

  return {
    invokeGatewayMethod,
    invokeCommand,
    memoryList,
    close: async () => {
      memoryServer.close();
      await once(memoryServer, "close");
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}
