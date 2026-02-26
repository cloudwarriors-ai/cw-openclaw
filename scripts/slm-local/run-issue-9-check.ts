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

if (!reviewEventsPath) {
  throw new Error("SLM_QA_EVENTS_PATH is required");
}

await waitForGatewayReady();

const seededQa = await readFirstSeededQa(reviewEventsPath);
const idSuffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;

const importResponse = await requestSlm("POST", "/v1/slm/qa-events/import", {
  tenant_id: tenantId,
  source: "zoom",
  idempotency_key: `pipeline-import-${idSuffix}`,
});
const importedCount = asNumber(importResponse.imported_count) ?? 0;
if (importedCount < 1) {
  throw new Error(`qa import returned imported_count=${importedCount}`);
}

const datasetResponse = await requestSlm("POST", "/v1/slm/datasets/build", {
  tenant_id: tenantId,
  split_seed: 7,
  idempotency_key: `pipeline-dataset-${idSuffix}`,
});
const datasetId = asString(datasetResponse.dataset_id);
if (!datasetId) {
  throw new Error("dataset build did not return dataset_id");
}

const runResponse = await requestSlm("POST", "/v1/slm/training/runs", {
  tenant_id: tenantId,
  dataset_id: datasetId,
  base_model: "forge-slm-base",
  idempotency_key: `pipeline-train-${idSuffix}`,
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
const projectionId = qaUpdate.record?.projection_id;
if (!projectionId) {
  throw new Error("slm.control.qa.update did not return projection_id");
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
}>("slm.control.training.enqueue", {
  tenant_id: tenantId,
  base_model: "forge-slm-base",
  split_seed: 7,
  idempotency_key: `gateway-enqueue-${idSuffix}`,
});
if (!enqueueResult.dataset_id || !enqueueResult.run_id) {
  throw new Error("slm.control.training.enqueue missing dataset_id/run_id");
}

const qaProjectionRecords = await listMemories({
  namespace: "slm.qa.current",
  kind: "qa_projection",
  limit: 10,
});
if (qaProjectionRecords.length < 1) {
  throw new Error("memory namespace slm.qa.current has no qa_projection records");
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      stage: "pipeline",
      tenant_id: tenantId,
      imported_count: importedCount,
      dataset_id: datasetId,
      run_id: runId,
      run_status: runStatus,
      review_queue_count: reviewItems.length,
      qa_projection_count: qaProjectionRecords.length,
      gateway_qa_count: qaListCount,
      enqueue_run_id: enqueueResult.run_id,
    },
    null,
    2,
  )}\n`,
);

async function waitForGatewayReady(): Promise<void> {
  const timeoutMs = 60_000;
  const startedAt = Date.now();
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

async function readFirstSeededQa(filePath: string): Promise<{
  question: string;
  answer: string;
  ref_id?: string;
}> {
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

function truncateForGatewayField(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
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
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function isMemoryRecord(value: unknown): value is {
  id: string;
  tenant_id: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { id?: unknown; tenant_id?: unknown };
  return typeof candidate.id === "string" && typeof candidate.tenant_id === "string";
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
