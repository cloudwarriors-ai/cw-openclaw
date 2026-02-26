import { randomUUID } from "node:crypto";
import type { QaProjectionService } from "./qa-projection.js";
import type { SlmPipelineRouter } from "./routes.js";
import type { QaProjectionRecord, ReviewActionActor } from "./types.js";

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
    private readonly qaProjectionService: QaProjectionService,
    private readonly reviewEventSink: PipelineReviewEventSink,
  ) {}

  async listQa(params: {
    tenantId: string;
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

  async enqueueTraining(params: {
    tenantId: string;
    baseModel: string;
    splitSeed?: number;
    idempotencyKey?: string;
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
        source: "zoom",
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
