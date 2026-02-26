import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer } from "../../packages/memory-server/src/http-server.js";
import { createSlmDashboardApp } from "../../apps/slm-dashboard/src/server/app.js";
import { createPasswordHash } from "../../apps/slm-dashboard/src/server/password.js";
import type {
  DashboardConfig,
  GatewayMethodClient,
} from "../../apps/slm-dashboard/src/server/types.js";
import { PipelineAppService, type PipelineReviewEventSink } from "../../extensions/slm-pipeline/src/app-service.js";
import { registerSlmPipelineGatewayMethods } from "../../extensions/slm-pipeline/src/gateway-methods.js";
import { InMemoryQaSource } from "../../extensions/slm-pipeline/src/qa-ingest.js";
import { QaCategoryService } from "../../extensions/slm-pipeline/src/qa-categories.js";
import { QaProjectionService } from "../../extensions/slm-pipeline/src/qa-projection.js";
import { emitPipelineReviewEvent } from "../../extensions/slm-pipeline/src/review-events.js";
import { createSlmPipelineRouter } from "../../extensions/slm-pipeline/src/routes.js";
import { resolveMemoryServerClientFromEnv } from "../../extensions/slm-pipeline/src/memory-client.js";

type GatewayHandler = (context: {
  params?: unknown;
  client?: { connect?: unknown };
  respond: (ok: boolean, payload: unknown) => void;
}) => Promise<void>;

type Harness = {
  invokeGatewayMethod: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  dashboardUrl: string;
  memoryUrl: string;
  memoryToken: string;
  close: () => Promise<void>;
};

describe("slm pipeline + dashboard e2e", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup.pop()?.();
    }
  });

  it("runs qa and training flows through gateway and dashboard without supervisor dependency", async () => {
    const harness = await createHarness();
    cleanup.push(harness.close);

    const categoryCreate = await harness.invokeGatewayMethod<{ record?: { category_id?: string } }>(
      "slm.control.category.create",
      {
        tenant_id: "tenant-a",
        provider_key: "zoom",
        channel_key: "support",
        category_key: "qa-pipeline-e2e",
        display_name: "Pipeline E2E",
      },
    );
    const categoryId = categoryCreate.record?.category_id;
    expect(categoryId).toBeTruthy();

    const created = await harness.invokeGatewayMethod<{ record?: { projection_id?: string } }>(
      "slm.control.qa.create",
      {
        tenant_id: "tenant-a",
        question: "How do we validate pipeline changes?",
        answer: "Use deterministic fixtures and verify smoke summaries.",
        provider_key: "zoom",
        channel_key: "support",
        category_id: categoryId,
        status: "validated",
        source_channel: "zoom:support",
        source_ref: "zoom-msg-pipeline-e2e",
      },
    );
    const projectionId = created.record?.projection_id;
    expect(projectionId).toBeTruthy();

    const preLogin = await requestJson(harness.dashboardUrl, {
      method: "GET",
      path: "/api/slm/qa?limit=10",
    });
    expect(preLogin.status).toBe(401);

    const login = await requestJson(harness.dashboardUrl, {
      method: "POST",
      path: "/api/auth/login",
      body: {
        username: "operator",
        password: "pass123",
      },
    });
    expect(login.status).toBe(200);
    const sessionCookie = login.cookie;
    expect(sessionCookie).toBeTruthy();

    const qaList = await requestJson(harness.dashboardUrl, {
      method: "GET",
      path: "/api/slm/qa?limit=10",
      cookie: sessionCookie,
    });
    expect(qaList.status).toBe(200);
    const records = (((qaList.body as { data?: { records?: unknown[] } }).data?.records ?? []) as Array<{
      projection_id?: string;
    }>);
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((record) => record.projection_id === projectionId)).toBe(true);

    const qaGet = await requestJson(harness.dashboardUrl, {
      method: "GET",
      path: `/api/slm/qa/${projectionId}`,
      cookie: sessionCookie,
    });
    expect(qaGet.status).toBe(200);

    const qaPut = await requestJson(harness.dashboardUrl, {
      method: "PUT",
      path: `/api/slm/qa/${projectionId}`,
      cookie: sessionCookie,
      body: {
        answer: "Deterministic fixture smoke plus integration/e2e evidence.",
      },
    });
    expect(qaPut.status).toBe(200);

    const enqueue = await requestJson(harness.dashboardUrl, {
      method: "POST",
      path: "/api/slm/training/enqueue",
      cookie: sessionCookie,
      body: {
        base_model: "forge/slm-base",
        split_seed: 7,
      },
    });
    expect(enqueue.status).toBe(200);
    const enqueueData = (enqueue.body as { data?: { dataset_id?: string; run_id?: string } }).data;
    expect(enqueueData?.dataset_id).toBeTruthy();
    expect(enqueueData?.run_id).toBeTruthy();

    const memoryList = await requestJson(harness.memoryUrl, {
      method: "POST",
      path: "/memories/list",
      headers: {
        authorization: `Bearer ${harness.memoryToken}`,
      },
      body: {
        namespace: "slm.qa.current",
        kind: "qa_projection",
        limit: 20,
      },
    });
    expect(memoryList.status).toBe(200);
    const memoryRecords = (memoryList.body as { records?: Array<{ id: string }> }).records ?? [];
    expect(memoryRecords.length).toBeGreaterThan(0);
  });
});

async function createHarness(): Promise<Harness> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "slm-pipeline-e2e-"));
  const memoryToken = "memory-token";
  const memoryTenant = "tenant-a";
  const memoryServer = createMemoryHttpServer({
    authResolver: (token) => {
      if (token === memoryToken) {
        return {
          tenantId: memoryTenant,
          subject: "pipeline-e2e",
          isAdmin: true,
        };
      }
      return null;
    },
  });
  memoryServer.listen(0, "127.0.0.1");
  await once(memoryServer, "listening");
  const memoryAddress = memoryServer.address() as AddressInfo;
  const memoryUrl = `http://127.0.0.1:${memoryAddress.port}`;
  const env = {
    OPENCLAW_MEMORY_SERVER_URL: memoryUrl,
    OPENCLAW_MEMORY_SERVER_TOKEN: memoryToken,
  };

  const qaEventsPath = path.join(tempDir, "review-events.jsonl");
  const qaSource = new InMemoryQaSource();
  qaSource.add({
    tenant_id: memoryTenant,
    source_channel: "zoom",
    source_message_ids: ["seed-1"],
    question: "How do we run fixture-first smoke tests?",
    answer: "Use fixture QA seed and deterministic gateway methods.",
    citations: [],
    approved_by: "reviewer",
    approved_at: "2026-02-24T00:00:00.000Z",
  });

  const router = createSlmPipelineRouter({ qaSource });
  const memoryClient = resolveMemoryServerClientFromEnv(env);
  const categoryService = new QaCategoryService(memoryClient);
  const qaProjectionService = new QaProjectionService(memoryClient);
  const reviewEventSink: PipelineReviewEventSink = {
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
  };
  const appService = new PipelineAppService(
    router,
    categoryService,
    qaProjectionService,
    reviewEventSink,
  );

  const gatewayHandlers = new Map<string, GatewayHandler>();
  const api = {
    registerGatewayMethod(method: string, handler: GatewayHandler) {
      gatewayHandlers.set(method, handler);
    },
  } as unknown as OpenClawPluginApi;
  registerSlmPipelineGatewayMethods(api, appService);

  const invokeGatewayMethod = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    const handler = gatewayHandlers.get(method);
    if (!handler) {
      throw new Error(`gateway method not registered: ${method}`);
    }
    const responses: Array<{ ok: boolean; payload: unknown }> = [];
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
        responses.push({ ok, payload });
      },
    });
    const finalResult = responses[0];
    if (!finalResult) {
      throw new Error(`gateway method returned no result: ${method}`);
    }
    if (!finalResult.ok) {
      throw new Error(`gateway method failed (${method}): ${JSON.stringify(finalResult.payload)}`);
    }
    return finalResult.payload as T;
  };

  const request: GatewayMethodClient["request"] = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    return await invokeGatewayMethod<T>(method, params);
  };
  const gatewayClient: GatewayMethodClient = {
    request,
  };
  const dashboardConfig: DashboardConfig = {
    port: 0,
    cookieName: "slm_dashboard_session",
    cookieSecure: false,
    sessionTtlMs: 30 * 60 * 1000,
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayToken: "token",
    gatewayPassword: undefined,
    gatewayTimeoutMs: 15_000,
    users: [
      {
        username: "operator",
        passwordHash: createPasswordHash("pass123"),
        tenantId: memoryTenant,
        displayName: "Operator",
        role: "trainer",
      },
    ],
  };
  const clientDir = path.resolve("apps/slm-dashboard/src/client");
  const { app } = createSlmDashboardApp({
    config: dashboardConfig,
    gatewayClient,
    clientDir,
  });
  const dashboardServer = app.listen(0, "127.0.0.1");
  await once(dashboardServer, "listening");
  const dashboardAddress = dashboardServer.address() as AddressInfo;

  return {
    invokeGatewayMethod,
    dashboardUrl: `http://127.0.0.1:${dashboardAddress.port}`,
    memoryUrl,
    memoryToken,
    close: async () => {
      dashboardServer.close();
      await once(dashboardServer, "close");
      memoryServer.close();
      await once(memoryServer, "close");
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function requestJson(
  baseUrl: string,
  params: {
    method: "GET" | "POST" | "PUT";
    path: string;
    cookie?: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{
  status: number;
  body: unknown;
  cookie?: string;
}> {
  const response = await fetch(`${baseUrl}${params.path}`, {
    method: params.method,
    headers: {
      "content-type": "application/json",
      ...(params.cookie ? { cookie: params.cookie } : {}),
      ...(params.headers ?? {}),
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie") ?? undefined;
  return {
    status: response.status,
    body: await response.json(),
    cookie: setCookie ? setCookie.split(";")[0] : undefined,
  };
}
