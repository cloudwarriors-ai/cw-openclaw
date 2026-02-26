import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { callGateway } from "../../src/gateway/call.js";

const tenantId = (process.env.SLM_TEST_TENANT || "tenant-local").trim();
const gatewayHttpUrl = (process.env.SLM_GATEWAY_HTTP_URL || "http://127.0.0.1:28789").trim();
const gatewayWsUrl = (process.env.SLM_GATEWAY_WS_URL || "ws://127.0.0.1:28789").trim();
const gatewayToken = process.env.SLM_GATEWAY_TOKEN?.trim() || undefined;
const gatewayPassword = process.env.SLM_GATEWAY_PASSWORD?.trim() || undefined;
const slmHttpToken = (process.env.SLM_HTTP_AUTH_TOKEN || "slm-local-http-token").trim();
const memoryUrl = (process.env.OPENCLAW_MEMORY_SERVER_URL || "http://127.0.0.1:19090").trim();
const memoryToken = (process.env.OPENCLAW_MEMORY_SERVER_TOKEN || "moltbot-local-token").trim();
const reviewEventsPath = (process.env.SLM_QA_EVENTS_PATH || "").trim();
const providerKey = "zoom";
const channelKey = "zoom";

await waitForGatewayReady();

const seededQa = await resolveSeedQa(reviewEventsPath);
const idSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const categoryKey = buildCategoryKey(idSuffix);

let seedMode: "library_api" | "legacy_gateway_update" = "legacy_gateway_update";
let categoryId: string | undefined;
let projectionId: string | undefined;

const librarySeed = await trySeedViaLibraryApi({
  tenantId,
  providerKey,
  channelKey,
  categoryKey,
  question: seededQa.question,
  answer: seededQa.answer,
  refId: seededQa.ref_id,
});
if (librarySeed) {
  seedMode = "library_api";
  categoryId = librarySeed.categoryId;
  projectionId = librarySeed.projectionId;
} else {
  const qaUpdate = await callGatewayMethod<{ record?: { projection_id?: string } }>(
    "slm.control.qa.update",
    {
      tenant_id: tenantId,
      question: truncateForGatewayField(seededQa.question, 4_000),
      answer: truncateForGatewayField(seededQa.answer, 12_000),
      ref_id: seededQa.ref_id ?? randomUUID(),
      source_channel: "zoom",
      source_ref: seededQa.ref_id ?? randomUUID(),
    },
  );
  projectionId = qaUpdate.record?.projection_id;
  if (!projectionId) {
    throw new Error("slm.control.qa.update did not return projection_id");
  }
}

let importMode: "library" | "zoom" = "library";
let importResponse: Record<string, unknown> | undefined;
if (categoryId) {
  try {
    importResponse = await requestSlm("POST", "/v1/slm/qa-events/import", {
      tenant_id: tenantId,
      source: "library",
      provider_key: providerKey,
      channel_key: channelKey,
      category_id: categoryId,
      status: "validated",
      idempotency_key: `smoke-import-library-${idSuffix}`,
    });
  } catch (error) {
    if (!reviewEventsPath) {
      throw error;
    }
  }
}
if (!importResponse) {
  if (!reviewEventsPath) {
    throw new Error(
      "library seed/import failed and SLM_QA_EVENTS_PATH is not set for legacy fallback",
    );
  }
  importMode = "zoom";
  importResponse = await requestSlm("POST", "/v1/slm/qa-events/import", {
    tenant_id: tenantId,
    source: "zoom",
    idempotency_key: `smoke-import-zoom-${idSuffix}`,
  });
}
let importedCount = asNumber(importResponse.imported_count) ?? 0;
if (importedCount < 1 && importMode === "library" && reviewEventsPath) {
  importMode = "zoom";
  const legacyImport = await requestSlm("POST", "/v1/slm/qa-events/import", {
    tenant_id: tenantId,
    source: "zoom",
    idempotency_key: `smoke-import-zoom-fallback-${idSuffix}`,
  });
  importedCount = asNumber(legacyImport.imported_count) ?? 0;
  if (importedCount < 1) {
    throw new Error(
      `qa import returned imported_count=${importedCount}`,
    );
  }
} else if (importedCount < 1) {
  throw new Error(`qa import returned imported_count=${importedCount}`);
}

const datasetResponse = await requestSlm("POST", "/v1/slm/datasets/build", {
  tenant_id: tenantId,
  split_seed: 7,
  idempotency_key: `smoke-dataset-${idSuffix}`,
});
const datasetId = asString(datasetResponse.dataset_id);
if (!datasetId) {
  throw new Error("dataset build did not return dataset_id");
}

const runResponse = await requestSlm("POST", "/v1/slm/training/runs", {
  tenant_id: tenantId,
  dataset_id: datasetId,
  base_model: "forge-slm-base",
  idempotency_key: `smoke-train-${idSuffix}`,
});
const runId = asString(runResponse.run_id);
if (!runId) {
  throw new Error("training run did not return run_id");
}

const runStatusResponse = await requestSlm("GET", `/v1/slm/training/runs/${runId}`);
const runStatus = asString(runStatusResponse.status) || "unknown";
if (!["queued", "running", "succeeded", "failed"].includes(runStatus)) {
  throw new Error(`unexpected training run status: ${runStatus}`);
}

const reviewQueue = await requestSlm(
  "GET",
  `/v1/slm/eval/review-queue?tenant_id=${encodeURIComponent(tenantId)}&limit=10`,
);
const reviewItems = Array.isArray(reviewQueue.items) ? reviewQueue.items : [];
if (reviewItems.length < 1) {
  throw new Error("review queue is empty after successful train flow");
}

const supervisorResponse = await requestSlm("POST", "/v1/slm/supervisor/respond", {
  tenant_id: tenantId,
  channel_id: "slm-local-smoke",
  user_message: "How should we validate this integration?",
  context_refs: [],
});
const supervisorTraceId = asString(supervisorResponse.trace_id);
if (!supervisorTraceId) {
  throw new Error("supervisor respond did not return trace_id");
}

if (!projectionId) {
  throw new Error("qa seed did not produce projection_id");
}

if (seedMode === "library_api") {
  await tryCallGatewayMethod("slm.control.qa.updateById", {
    tenant_id: tenantId,
    projection_id: projectionId,
    answer: `${truncateForGatewayField(seededQa.answer, 11_900)} [updatedById]`,
    status: "validated",
  });
}

const qaList = await callGatewayMethod<{ records?: Array<{ projection_id: string }> }>(
  "slm.control.qa.list",
  {
    tenant_id: tenantId,
    limit: 10,
  },
);
const qaListCount = Array.isArray(qaList.records) ? qaList.records.length : 0;
if (qaListCount < 1) {
  throw new Error("slm.control.qa.list returned no records");
}

const qaGet = await callGatewayMethod<{ record?: { projection_id?: string } }>(
  "slm.control.qa.get",
  {
    tenant_id: tenantId,
    projection_id: projectionId,
  },
);
if (qaGet.record?.projection_id !== projectionId) {
  throw new Error("slm.control.qa.get did not return expected projection");
}

const enqueueResult = await callGatewayMethod<{
  dataset_id?: string;
  run_id?: string;
  status?: string;
}>(
  "slm.control.training.enqueue",
  {
    tenant_id: tenantId,
    base_model: "forge-slm-base",
    split_seed: 7,
    idempotency_key: `gateway-enqueue-${idSuffix}`,
    ...(categoryId
      ? {
          source: "library",
          provider_key: providerKey,
          channel_key: channelKey,
          category_id: categoryId,
          status: "validated",
        }
      : {
          source: "zoom",
        }),
  },
);
if (!enqueueResult.dataset_id || !enqueueResult.run_id) {
  throw new Error("slm.control.training.enqueue missing dataset_id/run_id");
}

const sessionStart = await callGatewayMethod<{ session?: { session_id?: string } }>(
  "slm.control.session.start",
  {
    tenant_id: tenantId,
    question: "How should we answer deployment questions?",
  },
);
const sessionId = sessionStart.session?.session_id;
if (!sessionId) {
  throw new Error("slm.control.session.start did not return session_id");
}

const sessionTurn = await callGatewayMethod<{
  session?: { session_id?: string };
  turn?: { turn_id?: string };
  supervisor?: { trace_id?: string };
}>("slm.control.session.turn", {
  tenant_id: tenantId,
  session_id: sessionId,
  user_prompt: "Draft a concise response for a production outage question.",
  edited_answer: "Use the runbook, acknowledge impact, and provide ETA updates every 15 minutes.",
});
if (!sessionTurn.turn?.turn_id) {
  throw new Error("slm.control.session.turn did not return turn_id");
}

const sessionFinish = await callGatewayMethod<{ session?: { status?: string } }>(
  "slm.control.session.finish",
  {
    tenant_id: tenantId,
    session_id: sessionId,
  },
);
if (sessionFinish.session?.status !== "finished") {
  throw new Error(`slm.control.session.finish expected status=finished`);
}

const qaProjectionRecords = await listMemories({
  namespace: "slm.qa.current",
  kind: "qa_projection",
  limit: 10,
});
if (qaProjectionRecords.length < 1) {
  throw new Error("memory namespace slm.qa.current has no qa_projection records");
}

const sessionRecords = await listMemories({
  namespace: "slm.training.sessions",
  kind: "training_session",
  limit: 10,
});
if (sessionRecords.length < 1) {
  throw new Error("memory namespace slm.training.sessions has no training_session records");
}

const turnRecords = await listMemories({
  namespace: "slm.training.sessions",
  kind: "training_session_turn",
  limit: 10,
});
if (turnRecords.length < 1) {
  throw new Error("memory namespace slm.training.sessions has no training_session_turn records");
}

const traceRecords = await listMemories({
  namespace: "slm.supervisor.trace",
  kind: "decision_trace",
  limit: 10,
});
if (traceRecords.length < 1) {
  throw new Error("memory namespace slm.supervisor.trace has no decision_trace records");
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      tenant_id: tenantId,
      seed_mode: seedMode,
      import_mode: importMode,
      category_id: categoryId,
      dataset_id: datasetId,
      run_id: runId,
      run_status: runStatus,
      imported_count: importedCount,
      review_queue_count: reviewItems.length,
      supervisor_trace_id: supervisorTraceId,
      qa_projection_count: qaProjectionRecords.length,
      training_session_count: sessionRecords.length,
      training_turn_count: turnRecords.length,
      supervisor_trace_count: traceRecords.length,
      enqueue_run_id: enqueueResult.run_id,
      session_id: sessionId,
      turn_id: sessionTurn.turn?.turn_id,
    },
    null,
    2,
  )}\n`,
);

async function waitForGatewayReady(): Promise<void> {
  const timeoutMs = 60_000;
  const startedAt = Date.now();
  // Use health method because it is always available and validates connect/auth.
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await callGatewayMethod("health", {});
      return;
    } catch {
      await delay(1_000);
    }
  }
  throw new Error(`gateway was not ready within ${timeoutMs}ms (${gatewayWsUrl})`);
}

async function callGatewayMethod<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return await callGateway<T>({
    method,
    params,
    url: gatewayWsUrl,
    token: gatewayToken,
    password: gatewayPassword,
    timeoutMs: 25_000,
  });
}

async function tryCallGatewayMethod<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await callGatewayMethod<T>(method, params);
  } catch (error) {
    if (isMethodMissingError(error)) {
      return null;
    }
    throw error;
  }
}

async function requestSlm(
  method: "GET" | "POST",
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestInit: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer tenant:${tenantId}`,
      "x-openclaw-slm-token": slmHttpToken,
    },
  };
  if (method !== "GET" && body) {
    requestInit.body = JSON.stringify(body);
  }
  const response = await fetch(resolveEndpoint(gatewayHttpUrl, endpoint), requestInit);
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `slm request failed (${response.status}) ${endpoint}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function listMemories(request: {
  namespace: string;
  kind: string;
  limit: number;
}): Promise<Array<{ id: string; tenant_id: string }>> {
  const response = await fetch(resolveEndpoint(memoryUrl, "/memories/list"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${memoryToken}`,
    },
    body: JSON.stringify(request),
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`memory list failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  const recordsRaw = Array.isArray(payload.records) ? payload.records : [];
  return recordsRaw.filter(isMemoryRecord).map((record) => ({
    id: record.id,
    tenant_id: record.tenant_id,
  }));
}

async function resolveSeedQa(filePath: string): Promise<{
  question: string;
  answer: string;
  ref_id?: string;
}> {
  if (!filePath) {
    return {
      question: "How do we validate API-first SLM smoke gates?",
      answer: "Seed via category + QA create, then run integration and e2e checks.",
      ref_id: randomUUID(),
    };
  }

  const raw = await fs.readFile(filePath, "utf8");
  const line = raw
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) {
    throw new Error(`seed events file is empty: ${filePath}`);
  }
  const parsed = JSON.parse(line) as Record<string, unknown>;
  const question = asString(parsed.question);
  const answer = asString(parsed.answer);
  if (!question || !answer) {
    throw new Error(`seed events first line does not include question/answer: ${filePath}`);
  }
  return {
    question,
    answer,
    ref_id: asString(parsed.ref_id),
  };
}

async function trySeedViaLibraryApi(params: {
  tenantId: string;
  providerKey: string;
  channelKey: string;
  categoryKey: string;
  question: string;
  answer: string;
  refId?: string;
}): Promise<{ categoryId: string; projectionId: string } | null> {
  try {
    const categoryCreate = await callGatewayMethod<{ record?: { category_id?: string } }>(
      "slm.control.category.create",
      {
        tenant_id: params.tenantId,
        provider_key: params.providerKey,
        channel_key: params.channelKey,
        category_key: params.categoryKey,
        display_name: "Smoke Validation",
      },
    );
    const categoryId = asString(categoryCreate.record?.category_id);
    if (!categoryId) {
      throw new Error("slm.control.category.create did not return category_id");
    }

    const qaCreate = await callGatewayMethod<{ record?: { projection_id?: string } }>(
      "slm.control.qa.create",
      {
        tenant_id: params.tenantId,
        question: truncateForGatewayField(params.question, 4_000),
        answer: truncateForGatewayField(params.answer, 12_000),
        provider_key: params.providerKey,
        channel_key: params.channelKey,
        category_id: categoryId,
        status: "validated",
        source_channel: `${params.providerKey}:${params.channelKey}`,
        source_ref: params.refId ?? randomUUID(),
      },
    );
    const projectionId = asString(qaCreate.record?.projection_id);
    if (!projectionId) {
      throw new Error("slm.control.qa.create did not return projection_id");
    }
    return { categoryId, projectionId };
  } catch (error) {
    if (isMethodMissingError(error)) {
      return null;
    }
    throw error;
  }
}

function buildCategoryKey(idSuffix: string): string {
  const normalized = idSuffix.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const key = `smoke-${normalized}`;
  return key.slice(0, 64);
}

function resolveEndpoint(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return new URL(endpoint.replace(/^\/+/, ""), url).toString();
}

async function parseJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isMemoryRecord(value: unknown): value is { id: string; tenant_id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.tenant_id === "string";
}

function isMethodMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("unknown method") ||
    message.includes("not registered") ||
    message.includes("gateway method not found")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateForGatewayField(input: string, maxLength: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength);
}
