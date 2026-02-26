import { randomUUID } from "node:crypto";
import { SlmPipelineError } from "./errors.js";
import type { QaCategoryService } from "./qa-categories.js";
import type { QaProjectionService } from "./qa-projection.js";
import type { SlmPipelineRouter } from "./routes.js";
import type {
  QaCategoryRecord,
  QaProjectionRecord,
  QaRecordOrigin,
  QaRecordStatus,
  ReviewActionActor,
} from "./types.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_LIST_PAGES = 10;

export type PipelineReviewEventInput = {
  tenantId: string;
  question: string;
  answer: string;
  actor?: ReviewActionActor;
  refId?: string;
  traceId?: string;
  sourceChannelJid?: string;
  metadata?: Record<string, unknown>;
};

export type PipelineReviewEventSink = {
  emitApprovedEvent: (input: PipelineReviewEventInput) => Promise<{
    traceId: string;
    refId?: string;
  }>;
};

export class PipelineAppService {
  constructor(
    private readonly router: SlmPipelineRouter,
    private readonly categoryService: QaCategoryService,
    private readonly qaProjectionService: QaProjectionService,
    private readonly reviewEventSink: PipelineReviewEventSink,
  ) {}

  async listCategories(params: {
    tenantId: string;
    providerKey?: string;
    channelKey?: string;
    includeInactive?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<{ records: QaCategoryRecord[]; next_cursor: string | null }> {
    return await this.categoryService.list({
      tenantId: params.tenantId,
      providerKey: params.providerKey,
      channelKey: params.channelKey,
      includeInactive: params.includeInactive,
      cursor: params.cursor,
      limit: params.limit,
    });
  }

  async createCategory(params: {
    tenantId: string;
    providerKey: string;
    channelKey: string;
    categoryKey: string;
    displayName: string;
    sortOrder?: number;
  }): Promise<QaCategoryRecord> {
    const record = await this.categoryService.create({
      tenantId: params.tenantId,
      providerKey: params.providerKey,
      channelKey: params.channelKey,
      categoryKey: params.categoryKey,
      displayName: params.displayName,
      sortOrder: params.sortOrder,
    });
    if (record.tenant_id !== params.tenantId) {
      throw new Error("qa category tenant mismatch");
    }
    return record;
  }

  async updateCategory(params: {
    tenantId: string;
    categoryId: string;
    displayName?: string;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<QaCategoryRecord | null> {
    const record = await this.categoryService.update({
      tenantId: params.tenantId,
      categoryId: params.categoryId,
      displayName: params.displayName,
      isActive: params.isActive,
      sortOrder: params.sortOrder,
    });
    if (!record) {
      return null;
    }
    if (record.tenant_id !== params.tenantId) {
      throw new Error("qa category tenant mismatch");
    }
    return record;
  }

  async listQa(params: {
    tenantId: string;
    providerKey?: string;
    channelKey?: string;
    categoryId?: string;
    status?: QaRecordStatus;
    cursor?: string;
    limit?: number;
    query?: string;
  }): Promise<{ records: QaProjectionRecord[]; next_cursor: string | null }> {
    const targetLimit = normalizeListLimit(params.limit);
    const records: QaProjectionRecord[] = [];
    let cursor = params.cursor;
    let nextCursor: string | null = null;

    // Continue scanning pages until we fill the requested tenant-scoped result set.
    for (let page = 0; page < MAX_LIST_PAGES && records.length < targetLimit; page += 1) {
      const listed = await this.qaProjectionService.list({
        providerKey: params.providerKey,
        channelKey: params.channelKey,
        categoryId: params.categoryId,
        status: params.status,
        cursor,
        limit: targetLimit,
        query: params.query,
      });
      const pageRecords = listed.records.filter((record) => record.tenant_id === params.tenantId);
      for (const record of pageRecords) {
        records.push(record);
        if (records.length >= targetLimit) {
          break;
        }
      }

      nextCursor = listed.next_cursor;
      if (!nextCursor) {
        break;
      }
      if (records.length >= targetLimit) {
        break;
      }
      cursor = nextCursor;
    }

    return {
      records,
      next_cursor: nextCursor,
    };
  }

  async getQa(params: {
    tenantId: string;
    projectionId: string;
  }): Promise<QaProjectionRecord | null> {
    const record = await this.qaProjectionService.getById(params.projectionId);
    if (!record || record.tenant_id !== params.tenantId) {
      return null;
    }
    return record;
  }

  async updateQa(params: {
    tenantId: string;
    question: string;
    answer: string;
    actor?: ReviewActionActor;
    sourceChannel?: string;
    sourceRef?: string;
    traceId?: string;
    refId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<QaProjectionRecord> {
    const traceId = params.traceId?.trim() || randomUUID();
    const refId = params.refId?.trim() || randomUUID();
    const reviewEvent = await this.reviewEventSink.emitApprovedEvent({
      tenantId: params.tenantId,
      question: params.question,
      answer: params.answer,
      actor: params.actor,
      traceId,
      refId,
      sourceChannelJid: params.sourceChannel,
      metadata: params.metadata,
    });
    const record = await this.qaProjectionService.upsertCurrentAnswer({
      tenantId: params.tenantId,
      question: params.question,
      answer: params.answer,
      sourceChannel: params.sourceChannel ?? "zoom",
      sourceRef: params.sourceRef ?? refId,
      traceId: reviewEvent.traceId,
      refId: reviewEvent.refId ?? refId,
      actor: params.actor,
    });
    if (record.tenant_id !== params.tenantId) {
      throw new Error("qa projection tenant mismatch");
    }
    return record;
  }

  async createQa(params: {
    tenantId: string;
    question: string;
    answer: string;
    providerKey: string;
    channelKey: string;
    categoryId: string;
    categoryKey?: string;
    status?: QaRecordStatus;
    origin?: QaRecordOrigin;
    actor?: ReviewActionActor;
    sourceChannel?: string;
    sourceRef?: string;
    traceId?: string;
    refId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<QaProjectionRecord> {
    await this.requireCategory({
      tenantId: params.tenantId,
      categoryId: params.categoryId,
    });
    const status = params.status ?? "draft";
    const normalizedSourceChannel =
      params.sourceChannel ?? `${params.providerKey.trim().toLowerCase()}:${params.channelKey.trim().toLowerCase()}`;
    const traceId = params.traceId?.trim() || randomUUID();
    const refId = params.refId?.trim() || randomUUID();
    let finalTraceId = traceId;
    let finalRefId = refId;

    if (status === "validated") {
      const reviewEvent = await this.reviewEventSink.emitApprovedEvent({
        tenantId: params.tenantId,
        question: params.question,
        answer: params.answer,
        actor: params.actor,
        traceId,
        refId,
        sourceChannelJid: normalizedSourceChannel,
        metadata: params.metadata,
      });
      finalTraceId = reviewEvent.traceId;
      finalRefId = reviewEvent.refId ?? refId;
    }

    const record = await this.qaProjectionService.create({
      tenantId: params.tenantId,
      question: params.question,
      answer: params.answer,
      providerKey: params.providerKey,
      channelKey: params.channelKey,
      categoryId: params.categoryId,
      categoryKey: params.categoryKey,
      status,
      origin: params.origin ?? "manual",
      sourceChannel: normalizedSourceChannel,
      sourceRef: params.sourceRef ?? finalRefId,
      traceId: finalTraceId,
      refId: finalRefId,
      actor: params.actor,
    });
    if (record.tenant_id !== params.tenantId) {
      throw new Error("qa projection tenant mismatch");
    }
    return record;
  }

  async updateQaById(params: {
    tenantId: string;
    projectionId: string;
    question?: string;
    answer?: string;
    providerKey?: string;
    channelKey?: string;
    categoryId?: string;
    categoryKey?: string;
    status?: QaRecordStatus;
    origin?: QaRecordOrigin;
    actor?: ReviewActionActor;
    sourceChannel?: string;
    sourceRef?: string;
    traceId?: string;
    refId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<QaProjectionRecord | null> {
    const existing = await this.getQa({
      tenantId: params.tenantId,
      projectionId: params.projectionId,
    });
    if (!existing) {
      return null;
    }
    const question = params.question ?? existing.question;
    const answer = params.answer ?? existing.answer;
    const providerKey = params.providerKey ?? existing.provider_key ?? "zoom";
    const channelKey = params.channelKey ?? existing.channel_key ?? providerKey;
    const categoryId = params.categoryId ?? existing.category_id;
    if (!categoryId) {
      throw new SlmPipelineError(400, "invalid_category", "category_id is required");
    }
    await this.requireCategory({
      tenantId: params.tenantId,
      categoryId,
    });
    const status = params.status ?? existing.status;
    const sourceChannel = params.sourceChannel ?? existing.source_channel ?? `${providerKey}:${channelKey}`;
    const traceId = params.traceId?.trim() || randomUUID();
    const refId = params.refId?.trim() || randomUUID();
    let finalTraceId = traceId;
    let finalRefId = refId;

    if (status === "validated") {
      const reviewEvent = await this.reviewEventSink.emitApprovedEvent({
        tenantId: params.tenantId,
        question,
        answer,
        actor: params.actor,
        traceId,
        refId,
        sourceChannelJid: sourceChannel,
        metadata: params.metadata,
      });
      finalTraceId = reviewEvent.traceId;
      finalRefId = reviewEvent.refId ?? refId;
    }

    const record = await this.qaProjectionService.updateById({
      projectionId: params.projectionId,
      tenantId: params.tenantId,
      question,
      answer,
      providerKey,
      channelKey,
      categoryId,
      categoryKey: params.categoryKey,
      status,
      origin: params.origin ?? existing.origin,
      sourceChannel,
      sourceRef: params.sourceRef ?? existing.source_ref ?? finalRefId,
      traceId: finalTraceId,
      refId: finalRefId,
      actor: params.actor,
    });
    if (!record) {
      return null;
    }
    if (record.tenant_id !== params.tenantId) {
      throw new Error("qa projection tenant mismatch");
    }
    return record;
  }

  private async requireCategory(params: {
    tenantId: string;
    categoryId: string;
  }): Promise<void> {
    const category = await this.categoryService.getById({
      tenantId: params.tenantId,
      categoryId: params.categoryId,
    });
    if (!category) {
      throw new SlmPipelineError(404, "category_not_found", "category not found");
    }
  }

  async enqueueTraining(params: {
    tenantId: string;
    baseModel: string;
    splitSeed?: number;
    idempotencyKey?: string;
    source?: "zoom" | "library";
    providerKey?: string;
    channelKey?: string;
    categoryId?: string;
    status?: QaRecordStatus;
  }): Promise<{
    dataset_id: string;
    run_id: string;
    status: string;
    attempts: number;
  }> {
    const splitSeed =
      Number.isFinite(params.splitSeed) && (params.splitSeed ?? 0) > 0
        ? Math.floor(params.splitSeed as number)
        : 7;
    const keyBase = params.idempotencyKey?.trim() || randomUUID();
    const importResult = await this.router.handle({
      method: "POST",
      path: "/v1/slm/qa-events/import",
      headers: authHeader(params.tenantId),
      body: {
        tenant_id: params.tenantId,
        source: params.source ?? "library",
        provider_key: params.providerKey,
        channel_key: params.channelKey,
        category_id: params.categoryId,
        status: params.status ?? "validated",
        idempotency_key: `${keyBase}:import`,
      },
    });
    if (importResult.status >= 400) {
      throw new Error(extractErrorMessage(importResult.body, "qa import failed"));
    }

    const buildResult = await this.router.handle({
      method: "POST",
      path: "/v1/slm/datasets/build",
      headers: authHeader(params.tenantId),
      body: {
        tenant_id: params.tenantId,
        split_seed: splitSeed,
        idempotency_key: `${keyBase}:dataset`,
      },
    });
    if (buildResult.status >= 400) {
      throw new Error(extractErrorMessage(buildResult.body, "dataset build failed"));
    }
    const datasetId = asStringValue((buildResult.body as Record<string, unknown>)?.dataset_id);
    if (!datasetId) {
      throw new Error("dataset build did not return dataset_id");
    }

    const runResult = await this.router.handle({
      method: "POST",
      path: "/v1/slm/training/runs",
      headers: authHeader(params.tenantId),
      body: {
        tenant_id: params.tenantId,
        dataset_id: datasetId,
        base_model: params.baseModel,
        idempotency_key: `${keyBase}:train`,
      },
    });
    if (runResult.status >= 400) {
      throw new Error(extractErrorMessage(runResult.body, "training run failed"));
    }
    return {
      dataset_id: datasetId,
      run_id: asStringValue((runResult.body as Record<string, unknown>)?.run_id) ?? "",
      status: asStringValue((runResult.body as Record<string, unknown>)?.status) ?? "unknown",
      attempts: asNumberValue((runResult.body as Record<string, unknown>)?.attempts) ?? 0,
    };
  }
}

function authHeader(tenantId: string): Record<string, string> {
  return {
    authorization: `Bearer tenant:${tenantId}`,
  };
}

function asStringValue(input: unknown): string | undefined {
  return typeof input === "string" && input.trim().length > 0 ? input.trim() : undefined;
}

function asNumberValue(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const err = (body as { error?: { message?: unknown } }).error;
    if (err && typeof err.message === "string" && err.message.trim()) {
      return err.message.trim();
    }
  }
  return fallback;
}

function normalizeListLimit(limit: number | undefined): number {
  const numeric = typeof limit === "number" ? limit : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return DEFAULT_LIST_LIMIT;
  }
  const rounded = Math.floor(numeric);
  if (rounded < 1) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(MAX_LIST_LIMIT, rounded);
}
