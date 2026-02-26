import { randomUUID } from "node:crypto";

import * as z from "zod";

import { DatasetBuilderService } from "./dataset-builder.js";
import { SlmPipelineError, isSlmPipelineError } from "./errors.js";
import { FeedbackMergeService } from "./feedback-merge.js";
import { HumanEvalService } from "./human-eval.js";
import { NoopSlmPipelineEventSink, type SlmPipelineEventSink } from "./pipeline-events.js";
import { InMemoryQaSource, QaIngestService, type QaSource } from "./qa-ingest.js";
import {
  applyFeedbackSchema,
  buildDatasetSchema,
  categoryCreateSchema,
  categoryListSchema,
  categoryUpdateSchema,
  importQaSchema,
  qaCreateSchema,
  qaGetSchema,
  qaListSchema,
  qaUpdateByIdSchema,
  startTrainingRunSchema,
  submitReviewSchema,
} from "./schemas.js";
import {
  createInitialSlmPipelineState,
  InMemorySlmPipelineStateStore,
  type SlmPipelineStateStore,
} from "./state-store.js";
import {
  StubTrainingExecutor,
  TrainingOrchestratorService,
  type TrainingExecutor,
} from "./training-orchestrator.js";
import type { QaCategoryRecord, QaProjectionRecord, SlmPipelineState } from "./types.js";

export type SlmPipelineRequest = {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  query?: URLSearchParams;
  body?: unknown;
};

export type SlmPipelineResponse = {
  status: number;
  body: unknown;
};

export type SlmPipelineRouter = {
  state: SlmPipelineState;
  handle: (request: SlmPipelineRequest) => Promise<SlmPipelineResponse>;
};

export type SlmPipelineLibraryApi = {
  listCategories: (params: {
    tenantId: string;
    providerKey?: string;
    channelKey?: string;
    includeInactive?: boolean;
    cursor?: string;
    limit?: number;
  }) => Promise<{ records: QaCategoryRecord[]; next_cursor: string | null }>;
  createCategory: (params: {
    tenantId: string;
    providerKey: string;
    channelKey: string;
    categoryKey: string;
    displayName: string;
    sortOrder?: number;
  }) => Promise<QaCategoryRecord>;
  updateCategory: (params: {
    tenantId: string;
    categoryId: string;
    displayName?: string;
    isActive?: boolean;
    sortOrder?: number;
  }) => Promise<QaCategoryRecord | null>;
  listQa: (params: {
    tenantId: string;
    providerKey?: string;
    channelKey?: string;
    categoryId?: string;
    status?: "draft" | "validated" | "archived";
    cursor?: string;
    limit?: number;
    query?: string;
  }) => Promise<{ records: QaProjectionRecord[]; next_cursor: string | null }>;
  createQa: (params: {
    tenantId: string;
    question: string;
    answer: string;
    providerKey: string;
    channelKey: string;
    categoryId: string;
    categoryKey?: string;
    status?: "draft" | "validated" | "archived";
    origin?: "manual" | "studio" | "import";
    sourceChannel?: string;
    sourceRef?: string;
    traceId?: string;
    refId?: string;
  }) => Promise<QaProjectionRecord>;
  updateQaById: (params: {
    tenantId: string;
    projectionId: string;
    question?: string;
    answer?: string;
    providerKey?: string;
    channelKey?: string;
    categoryId?: string;
    categoryKey?: string;
    status?: "draft" | "validated" | "archived";
    origin?: "manual" | "studio" | "import";
    sourceChannel?: string;
    sourceRef?: string;
    traceId?: string;
    refId?: string;
  }) => Promise<QaProjectionRecord | null>;
  getQa: (params: { tenantId: string; projectionId: string }) => Promise<QaProjectionRecord | null>;
};

export function createSlmPipelineRouter(params?: {
  qaSource?: QaSource;
  stateStore?: SlmPipelineStateStore;
  trainingExecutor?: TrainingExecutor;
  eventSink?: SlmPipelineEventSink;
  libraryApi?: SlmPipelineLibraryApi;
}): SlmPipelineRouter {
  const qaSource = params?.qaSource ?? new InMemoryQaSource();
  const stateStore = params?.stateStore ?? new InMemorySlmPipelineStateStore();
  const ingest = new QaIngestService(qaSource);
  const datasetBuilder = new DatasetBuilderService();
  const training = new TrainingOrchestratorService(params?.trainingExecutor ?? new StubTrainingExecutor());
  const humanEval = new HumanEvalService();
  const feedbackMerge = new FeedbackMergeService();
  const eventSink = params?.eventSink ?? new NoopSlmPipelineEventSink();
  const libraryApi = params?.libraryApi;
  const state = createInitialSlmPipelineState();
  const inFlightIdempotency = new Set<string>();

  return {
    state,
    async handle(request) {
      const traceId = randomUUID();
      try {
        const runtimeState = await stateStore.getState();
        const method = request.method.toUpperCase();
        const query = request.query ?? new URL(request.path, "http://localhost").searchParams;
        const path = normalizePath(request.path);
        const tenantId = requireTenantId(request.headers?.authorization);

        if (libraryApi) {
          if (method === "GET" && path === "/v1/slm/categories") {
            const payload = categoryListSchema.parse({
              tenant_id: query.get("tenant_id") ?? "",
              provider_key: emptyToUndefined(query.get("provider_key")),
              channel_key: emptyToUndefined(query.get("channel_key")),
              include_inactive: readBooleanQuery(query.get("include_inactive"), false),
              cursor: emptyToUndefined(query.get("cursor")),
              limit: readPositiveInt(query.get("limit"), 50),
            });
            assertTenant(payload.tenant_id, tenantId);
            const listed = await libraryApi.listCategories({
              tenantId,
              providerKey: payload.provider_key,
              channelKey: payload.channel_key,
              includeInactive: payload.include_inactive,
              cursor: payload.cursor,
              limit: payload.limit,
            });
            return ok(traceId, listed);
          }

          if (method === "POST" && path === "/v1/slm/categories") {
            const payload = categoryCreateSchema.parse(request.body ?? {});
            assertTenant(payload.tenant_id, tenantId);
            const record = await libraryApi.createCategory({
              tenantId,
              providerKey: payload.provider_key,
              channelKey: payload.channel_key,
              categoryKey: payload.category_key,
              displayName: payload.display_name,
              sortOrder: payload.sort_order,
            });
            return ok(traceId, { record });
          }

          const categoryId = parsePathParam(path, "/v1/slm/categories/");
          if (method === "PATCH" && categoryId) {
            const payload = categoryUpdateSchema.parse({
              ...(request.body && typeof request.body === "object" && !Array.isArray(request.body)
                ? request.body
                : {}),
              tenant_id: (request.body as { tenant_id?: string } | undefined)?.tenant_id ?? "",
              category_id: categoryId,
            });
            assertTenant(payload.tenant_id, tenantId);
            const record = await libraryApi.updateCategory({
              tenantId,
              categoryId,
              displayName: payload.display_name,
              isActive: payload.is_active,
              sortOrder: payload.sort_order,
            });
            if (!record) {
              throw new SlmPipelineError(404, "category_not_found", "category not found");
            }
            return ok(traceId, { record });
          }

          if (method === "GET" && path === "/v1/slm/qa") {
            const payload = qaListSchema.parse({
              tenant_id: query.get("tenant_id") ?? "",
              provider_key: emptyToUndefined(query.get("provider_key")),
              channel_key: emptyToUndefined(query.get("channel_key")),
              category_id: emptyToUndefined(query.get("category_id")),
              status: emptyToUndefined(query.get("status")),
              cursor: emptyToUndefined(query.get("cursor")),
              limit: readPositiveInt(query.get("limit"), 50),
              query: emptyToUndefined(query.get("query")),
            });
            assertTenant(payload.tenant_id, tenantId);
            const listed = await libraryApi.listQa({
              tenantId,
              providerKey: payload.provider_key,
              channelKey: payload.channel_key,
              categoryId: payload.category_id,
              status: payload.status,
              cursor: payload.cursor,
              limit: payload.limit,
              query: payload.query,
            });
            return ok(traceId, listed);
          }

          if (method === "POST" && path === "/v1/slm/qa") {
            const payload = qaCreateSchema.parse(request.body ?? {});
            assertTenant(payload.tenant_id, tenantId);
            const record = await libraryApi.createQa({
              tenantId,
              question: payload.question,
              answer: payload.answer,
              providerKey: payload.provider_key,
              channelKey: payload.channel_key,
              categoryId: payload.category_id,
              categoryKey: payload.category_key,
              status: payload.status,
              origin: payload.origin,
              sourceChannel: payload.source_channel,
              sourceRef: payload.source_ref,
              traceId: payload.trace_id,
              refId: payload.ref_id,
            });
            return ok(traceId, { record });
          }

          const projectionId = parsePathParam(path, "/v1/slm/qa/");
          if (projectionId && method === "GET") {
            const payload = qaGetSchema.parse({
              tenant_id: query.get("tenant_id") ?? "",
              projection_id: projectionId,
            });
            assertTenant(payload.tenant_id, tenantId);
            const record = await libraryApi.getQa({
              tenantId,
              projectionId: payload.projection_id,
            });
            if (!record) {
              throw new SlmPipelineError(404, "qa_not_found", "qa record not found");
            }
            return ok(traceId, { record });
          }

          if (projectionId && method === "PUT") {
            const payload = qaUpdateByIdSchema.parse({
              ...(request.body && typeof request.body === "object" && !Array.isArray(request.body)
                ? request.body
                : {}),
              tenant_id: (request.body as { tenant_id?: string } | undefined)?.tenant_id ?? "",
              projection_id: projectionId,
            });
            assertTenant(payload.tenant_id, tenantId);
            const record = await libraryApi.updateQaById({
              tenantId,
              projectionId: payload.projection_id,
              question: payload.question,
              answer: payload.answer,
              providerKey: payload.provider_key,
              channelKey: payload.channel_key,
              categoryId: payload.category_id,
              categoryKey: payload.category_key,
              status: payload.status,
              origin: payload.origin,
              sourceChannel: payload.source_channel,
              sourceRef: payload.source_ref,
              traceId: payload.trace_id,
              refId: payload.ref_id,
            });
            if (!record) {
              throw new SlmPipelineError(404, "qa_not_found", "qa record not found");
            }
            return ok(traceId, { record });
          }
        }

        if (method === "POST" && path === "/v1/slm/qa-events/import") {
          const payload = importQaSchema.parse(request.body ?? {});
          assertTenant(payload.tenant_id, tenantId);
          const dedupeKey = buildIdempotencyKey(tenantId, payload.idempotency_key, "import");
          if (runtimeState.idempotency.has(dedupeKey) || inFlightIdempotency.has(dedupeKey)) {
            return accepted(traceId, { deduped: true });
          }
          inFlightIdempotency.add(dedupeKey);
          try {
            const imported = await ingest.importApproved(payload, runtimeState.approvedQa);
            const previousLength = runtimeState.approvedQa.length;
            for (const record of imported) {
              runtimeState.approvedQa.push(record);
            }
            await commitStateMutation({
              stateStore,
              state: runtimeState,
              dedupeKey,
              rollback: () => {
                runtimeState.approvedQa.splice(previousLength);
              },
            });
            return accepted(traceId, { imported_count: imported.length });
          } finally {
            inFlightIdempotency.delete(dedupeKey);
          }
        }

        if (method === "POST" && path === "/v1/slm/datasets/build") {
          const payload = buildDatasetSchema.parse(request.body ?? {});
          assertTenant(payload.tenant_id, tenantId);
          const dedupeKey = buildIdempotencyKey(tenantId, payload.idempotency_key, "dataset");
          if (runtimeState.idempotency.has(dedupeKey) || inFlightIdempotency.has(dedupeKey)) {
            return accepted(traceId, { deduped: true });
          }
          inFlightIdempotency.add(dedupeKey);
          try {
            const approved = runtimeState.approvedQa.filter((record) => record.tenant_id === tenantId);
            if (approved.length === 0) {
              throw new SlmPipelineError(409, "empty_source", "no approved Q&A records for tenant");
            }
            await emitEventSafely(eventSink, {
              tenantId,
              traceId,
              eventType: "dataset.build_started",
              input: {
                split_seed: payload.split_seed,
                approved_count: approved.length,
              },
            });
            const dataset = await buildDatasetWithLifecycle({
              datasetBuilder,
              eventSink,
              tenantId,
              traceId,
              splitSeed: payload.split_seed,
              approvedQa: approved,
            });
            runtimeState.datasets.set(dataset.dataset_id, dataset);
            await commitStateMutation({
              stateStore,
              state: runtimeState,
              dedupeKey,
              rollback: () => {
                runtimeState.datasets.delete(dataset.dataset_id);
              },
            });
            await emitEventSafely(eventSink, {
              tenantId,
              traceId,
              eventType: "dataset.build_succeeded",
              input: {
                split_seed: payload.split_seed,
              },
              output: {
                dataset_id: dataset.dataset_id,
                manifest_hash: dataset.manifest_hash,
                train_count: dataset.train.length,
                eval_count: dataset.eval.length,
              },
            });
            return accepted(traceId, {
              dataset_id: dataset.dataset_id,
              manifest_hash: dataset.manifest_hash,
            });
          } finally {
            inFlightIdempotency.delete(dedupeKey);
          }
        }

        if (method === "POST" && path === "/v1/slm/training/runs") {
          const payload = startTrainingRunSchema.parse(request.body ?? {});
          assertTenant(payload.tenant_id, tenantId);
          const dedupeKey = buildIdempotencyKey(tenantId, payload.idempotency_key, "train");
          if (runtimeState.idempotency.has(dedupeKey) || inFlightIdempotency.has(dedupeKey)) {
            return accepted(traceId, { deduped: true });
          }
          inFlightIdempotency.add(dedupeKey);
          try {
            const dataset = runtimeState.datasets.get(payload.dataset_id);
            if (!dataset || dataset.tenant_id !== tenantId) {
              throw new SlmPipelineError(404, "dataset_not_found", "dataset not found");
            }
            await emitEventSafely(eventSink, {
              tenantId,
              traceId,
              eventType: "training.run_started",
              input: {
                dataset_id: dataset.dataset_id,
                base_model: payload.base_model,
              },
            });
            const output = await training.startRun({
              tenantId,
              dataset,
              baseModel: payload.base_model,
            });
            runtimeState.runs.set(output.run.run_id, output.run);
            const createdItemIds: string[] = [];
            for (const item of output.evalItems) {
              runtimeState.evalItems.set(item.item_id, item);
              createdItemIds.push(item.item_id);
            }
            await commitStateMutation({
              stateStore,
              state: runtimeState,
              dedupeKey,
              rollback: () => {
                runtimeState.runs.delete(output.run.run_id);
                for (const itemId of createdItemIds) {
                  runtimeState.evalItems.delete(itemId);
                }
              },
              rollbackState: false,
              rollbackIdempotency: false,
            });
            if (output.run.status === "succeeded") {
              await emitEventSafely(eventSink, {
                tenantId,
                traceId,
                eventType: "training.run_succeeded",
                input: {
                  run_id: output.run.run_id,
                  dataset_id: dataset.dataset_id,
                  base_model: payload.base_model,
                },
                output: {
                  adapter_path: output.run.adapter_path,
                  attempts: output.attempts,
                },
              });
            } else {
              await emitEventSafely(eventSink, {
                tenantId,
                traceId,
                eventType: "training.run_failed",
                input: {
                  run_id: output.run.run_id,
                  dataset_id: dataset.dataset_id,
                  base_model: payload.base_model,
                },
                output: {
                  error: output.run.error_message,
                  attempts: output.attempts,
                },
              });
            }
            return accepted(traceId, {
              run_id: output.run.run_id,
              status: output.run.status,
              attempts: output.attempts,
            });
          } finally {
            inFlightIdempotency.delete(dedupeKey);
          }
        }

        const runId = parsePathParam(path, "/v1/slm/training/runs/");
        if (method === "GET" && runId) {
          const run = runtimeState.runs.get(runId);
          if (!run || run.tenant_id !== tenantId) {
            throw new SlmPipelineError(404, "run_not_found", "training run not found");
          }
          return ok(traceId, run);
        }

        if (method === "GET" && path === "/v1/slm/eval/review-queue") {
          const queryTenantId = query.get("tenant_id") ?? "";
          assertTenant(queryTenantId, tenantId);
          const limitRaw = query.get("limit") ?? "25";
          const limit = Number.parseInt(limitRaw, 10);
          const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25;
          const items = humanEval.getQueue({
            tenantId,
            evalItems: runtimeState.evalItems,
            limit: safeLimit,
          });
          return ok(traceId, { items });
        }

        const reviewItemId = parsePathParam(path, "/v1/slm/eval/review/");
        if (method === "POST" && reviewItemId) {
          const payload = submitReviewSchema.parse(request.body ?? {});
          const item = humanEval.submitReview({
            evalItems: runtimeState.evalItems,
            itemId: reviewItemId,
            tenantId,
            request: payload,
          });
          await stateStore.saveState(runtimeState);
          return ok(traceId, { item });
        }

        if (method === "POST" && path === "/v1/slm/feedback/apply") {
          const payload = applyFeedbackSchema.parse(request.body ?? {});
          assertTenant(payload.tenant_id, tenantId);
          const dedupeKey = buildIdempotencyKey(tenantId, payload.idempotency_key, "feedback");
          if (runtimeState.idempotency.has(dedupeKey) || inFlightIdempotency.has(dedupeKey)) {
            return accepted(traceId, { deduped: true });
          }
          inFlightIdempotency.add(dedupeKey);
          try {
            const actions = feedbackMerge.apply({
              request: payload,
              evalItems: runtimeState.evalItems,
            });
            const previousLength = runtimeState.feedbackActions.length;
            for (const action of actions) {
              runtimeState.feedbackActions.push(action);
            }
            await commitStateMutation({
              stateStore,
              state: runtimeState,
              dedupeKey,
              rollback: () => {
                runtimeState.feedbackActions.splice(previousLength);
              },
            });
            await emitEventSafely(eventSink, {
              tenantId,
              traceId,
              eventType: "feedback.applied",
              input: {
                run_id: payload.run_id,
                requested_item_ids: payload.item_ids.length,
                max_ratio: payload.max_ratio,
              },
              output: {
                applied_count: actions.length,
              },
            });
            return accepted(traceId, {
              applied_count: actions.length,
              feedback_ids: actions.map((action) => action.feedback_id),
            });
          } finally {
            inFlightIdempotency.delete(dedupeKey);
          }
        }

        throw new SlmPipelineError(404, "not_found", "route not found");
      } catch (err) {
        return toErrorResponse(traceId, err);
      }
    },
  };
}

function normalizePath(pathname: string): string {
  const parsed = new URL(pathname, "http://localhost");
  const normalized = parsed.pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function emptyToUndefined(raw: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBooleanQuery(raw: string | null, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function readPositiveInt(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parsePathParam(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const tail = pathname.slice(prefix.length);
  if (!tail || tail.includes("/")) {
    return null;
  }
  return tail;
}

function requireTenantId(authorization: string | undefined): string {
  const token = (authorization ?? "").trim();
  const match = /^Bearer\s+tenant:([a-zA-Z0-9_.-]+)$/i.exec(token);
  if (!match?.[1]) {
    throw new SlmPipelineError(401, "unauthorized", "expected Bearer tenant:<tenant_id> token");
  }
  return match[1];
}

function assertTenant(payloadTenantId: string, authTenantId: string): void {
  if (payloadTenantId !== authTenantId) {
    throw new SlmPipelineError(403, "tenant_mismatch", "tenant_id does not match auth context");
  }
}

function buildIdempotencyKey(tenantId: string, idempotencyKey: string, operation: string): string {
  return `${tenantId}:${operation}:${idempotencyKey}`;
}

async function commitStateMutation(params: {
  stateStore: SlmPipelineStateStore;
  state: SlmPipelineState;
  dedupeKey: string;
  rollback: () => void;
  rollbackState?: boolean;
  rollbackIdempotency?: boolean;
}): Promise<void> {
  const rollbackState = params.rollbackState ?? true;
  const rollbackIdempotency = params.rollbackIdempotency ?? true;
  params.state.idempotency.add(params.dedupeKey);
  try {
    await params.stateStore.saveState(params.state);
  } catch (error) {
    if (rollbackIdempotency) {
      params.state.idempotency.delete(params.dedupeKey);
    }
    if (rollbackState) {
      params.rollback();
    }
    throw error;
  }
}

async function buildDatasetWithLifecycle(params: {
  datasetBuilder: DatasetBuilderService;
  eventSink: SlmPipelineEventSink;
  tenantId: string;
  traceId: string;
  splitSeed: number;
  approvedQa: SlmPipelineState["approvedQa"];
}) {
  try {
    return params.datasetBuilder.build({
      tenantId: params.tenantId,
      splitSeed: params.splitSeed,
      approvedQa: params.approvedQa,
    });
  } catch (error) {
    await emitEventSafely(params.eventSink, {
      tenantId: params.tenantId,
      traceId: params.traceId,
      eventType: "dataset.build_failed",
      input: {
        split_seed: params.splitSeed,
      },
      output: {
        error: String(error),
      },
    });
    throw error;
  }
}

async function emitEventSafely(
  eventSink: SlmPipelineEventSink,
  payload: Parameters<SlmPipelineEventSink["emit"]>[0],
): Promise<void> {
  try {
    await eventSink.emit(payload);
  } catch {
    // Event writes should never fail the API surface.
  }
}

function ok(traceId: string, payload: unknown): SlmPipelineResponse {
  return {
    status: 200,
    body: {
      ok: true,
      trace_id: traceId,
      ...asObject(payload),
    },
  };
}

function accepted(traceId: string, payload: unknown): SlmPipelineResponse {
  return {
    status: 202,
    body: {
      ok: true,
      trace_id: traceId,
      ...asObject(payload),
    },
  };
}

function toErrorResponse(traceId: string, err: unknown): SlmPipelineResponse {
  if (err instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        ok: false,
        trace_id: traceId,
        error: {
          code: "validation_error",
          message: err.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`),
        },
      },
    };
  }
  if (isSlmPipelineError(err)) {
    return {
      status: err.status,
      body: {
        ok: false,
        trace_id: traceId,
        error: {
          code: err.code,
          message: err.message,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      trace_id: traceId,
      error: {
        code: "internal_error",
        message: String(err),
      },
    },
  };
}

function asObject(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { value: payload };
}
