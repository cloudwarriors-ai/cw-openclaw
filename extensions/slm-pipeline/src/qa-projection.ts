import { createHash, randomUUID } from "node:crypto";
import type { MemoryServerClient } from "./memory-client.js";
import type {
  QaProjectionRecord,
  QaRecordOrigin,
  QaRecordStatus,
  ReviewActionActor,
} from "./types.js";

const QA_NAMESPACE = "slm.qa.current";
const QA_KIND = "qa_projection";

export type QaProjectionWriteInput = {
  tenantId: string;
  question: string;
  answer: string;
  providerKey?: string;
  channelKey?: string;
  categoryId?: string;
  categoryKey?: string;
  status?: QaRecordStatus;
  origin?: QaRecordOrigin;
  sourceChannel?: string;
  sourceRef?: string;
  traceId?: string;
  refId?: string;
  actor?: ReviewActionActor;
  approvedAt?: string;
  updatedAt?: string;
};

export type QaProjectionCreateInput = QaProjectionWriteInput & {
  providerKey: string;
  channelKey: string;
  categoryId: string;
};

export type QaProjectionUpdateInput = {
  projectionId: string;
  tenantId: string;
  question?: string;
  answer?: string;
  providerKey?: string;
  channelKey?: string;
  categoryId?: string;
  categoryKey?: string;
  status?: QaRecordStatus;
  origin?: QaRecordOrigin;
  sourceChannel?: string;
  sourceRef?: string;
  traceId?: string;
  refId?: string;
  actor?: ReviewActionActor;
  approvedAt?: string;
  updatedAt?: string;
};

export type QaProjectionListParams = {
  providerKey?: string;
  channelKey?: string;
  categoryId?: string;
  status?: QaRecordStatus;
  cursor?: string;
  limit?: number;
  query?: string;
};

export class QaProjectionService {
  constructor(
    private readonly memoryClient: MemoryServerClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: QaProjectionCreateInput): Promise<QaProjectionRecord> {
    const record = await this.write({
      id: randomUUID(),
      tenantId: input.tenantId,
      question: input.question,
      answer: input.answer,
      providerKey: input.providerKey,
      channelKey: input.channelKey,
      categoryId: input.categoryId,
      categoryKey: input.categoryKey,
      status: input.status ?? "draft",
      origin: input.origin ?? "manual",
      sourceChannel: input.sourceChannel,
      sourceRef: input.sourceRef,
      traceId: input.traceId,
      refId: input.refId,
      actor: input.actor,
      approvedAt: input.approvedAt,
      updatedAt: input.updatedAt,
    });
    return record;
  }

  async upsertCurrentAnswer(input: QaProjectionWriteInput): Promise<QaProjectionRecord> {
    const question = input.question.trim();
    const answer = input.answer.trim();
    if (!question || !answer) {
      throw new Error("question and answer are required");
    }
    const projectionId = buildProjectionId(input.tenantId, question);
    return await this.write({
      id: projectionId,
      tenantId: input.tenantId,
      question,
      answer,
      providerKey: input.providerKey ?? deriveProviderFromSource(input.sourceChannel),
      channelKey: input.channelKey ?? deriveChannelFromSource(input.sourceChannel),
      categoryId: input.categoryId,
      categoryKey: input.categoryKey,
      status: input.status ?? "validated",
      origin: input.origin ?? "import",
      sourceChannel: input.sourceChannel,
      sourceRef: input.sourceRef,
      traceId: input.traceId,
      refId: input.refId,
      actor: input.actor,
      approvedAt: input.approvedAt,
      updatedAt: input.updatedAt,
    });
  }

  async updateById(input: QaProjectionUpdateInput): Promise<QaProjectionRecord | null> {
    const existing = await this.getById(input.projectionId);
    if (!existing || existing.tenant_id !== input.tenantId) {
      return null;
    }
    const question = input.question?.trim() || existing.question;
    const answer = input.answer?.trim() || existing.answer;
    if (!question || !answer) {
      throw new Error("question and answer are required");
    }

    const updated = await this.write({
      id: input.projectionId,
      tenantId: input.tenantId,
      question,
      answer,
      providerKey: input.providerKey ?? existing.provider_key ?? "zoom",
      channelKey: input.channelKey ?? existing.channel_key ?? existing.provider_key ?? "zoom",
      categoryId: input.categoryId ?? existing.category_id,
      categoryKey: input.categoryKey ?? existing.category_key,
      status: input.status ?? existing.status,
      origin: input.origin ?? existing.origin,
      sourceChannel: input.sourceChannel ?? existing.source_channel,
      sourceRef: input.sourceRef ?? existing.source_ref,
      traceId: input.traceId ?? existing.trace_id,
      refId: input.refId ?? existing.ref_id,
      actor: input.actor ?? existing.actor,
      approvedAt: input.approvedAt ?? existing.approved_at,
      updatedAt: input.updatedAt,
    });
    return updated;
  }

  async getById(projectionId: string): Promise<QaProjectionRecord | null> {
    const record = await this.memoryClient.get(projectionId);
    if (!record || record.namespace !== QA_NAMESPACE || record.kind !== QA_KIND) {
      return null;
    }
    return toQaProjectionRecord(record);
  }

  async list(params: QaProjectionListParams): Promise<{ records: QaProjectionRecord[]; next_cursor: string | null }> {
    const metadataFilters: Record<string, string> = {};
    if (params.providerKey) {
      metadataFilters.provider_key = params.providerKey;
    }
    if (params.channelKey) {
      metadataFilters.channel_key = params.channelKey;
    }
    if (params.categoryId) {
      metadataFilters.category_id = params.categoryId;
    }
    if (params.status) {
      metadataFilters.status = params.status;
    }

    const listed = await this.memoryClient.list({
      namespace: QA_NAMESPACE,
      kind: QA_KIND,
      metadata_filters: Object.keys(metadataFilters).length > 0 ? metadataFilters : undefined,
      cursor: params.cursor,
      limit: params.limit,
      sort_by: "updated_at",
      sort_order: "desc",
    });
    const query = params.query?.trim().toLowerCase();
    const records = listed.records
      .map((record) => toQaProjectionRecord(record))
      .filter((record) => {
        if (!query) {
          return true;
        }
        return `${record.question}\n${record.answer}`.toLowerCase().includes(query);
      });
    return {
      records,
      next_cursor: listed.next_cursor,
    };
  }

  private async write(input: {
    id: string;
    tenantId: string;
    question: string;
    answer: string;
    providerKey?: string;
    channelKey?: string;
    categoryId?: string;
    categoryKey?: string;
    status?: QaRecordStatus;
    origin?: QaRecordOrigin;
    sourceChannel?: string;
    sourceRef?: string;
    traceId?: string;
    refId?: string;
    actor?: ReviewActionActor;
    approvedAt?: string;
    updatedAt?: string;
  }): Promise<QaProjectionRecord> {
    const question = input.question.trim();
    const answer = input.answer.trim();
    if (!question || !answer) {
      throw new Error("question and answer are required");
    }
    const nowIso = this.now().toISOString();
    const approvedAt = input.approvedAt ?? nowIso;
    const updatedAt = input.updatedAt ?? nowIso;
    const actor = normalizeActor(input.actor);
    const providerKey = sanitizeKey(input.providerKey) ?? deriveProviderFromSource(input.sourceChannel);
    const channelKey = sanitizeKey(input.channelKey) ?? deriveChannelFromSource(input.sourceChannel) ?? providerKey;
    const status = input.status ?? "draft";
    const origin = input.origin ?? "manual";
    const record = await this.memoryClient.upsert({
      id: input.id,
      namespace: QA_NAMESPACE,
      kind: QA_KIND,
      content: `${question}\n\n${answer}`,
      metadata: {
        question,
        answer,
        provider_key: providerKey ?? null,
        channel_key: channelKey ?? null,
        category_id: input.categoryId ?? null,
        category_key: input.categoryKey ?? null,
        status,
        origin,
        source_channel: input.sourceChannel ?? providerKey ?? channelKey ?? "zoom",
        source_ref: input.sourceRef ?? null,
        trace_id: input.traceId ?? null,
        ref_id: input.refId ?? null,
        approved_at: approvedAt,
        updated_at: updatedAt,
        actor_id: actor?.actor_id ?? null,
        actor_name: actor?.actor_name ?? null,
        actor_role: actor?.actor_role ?? null,
      },
      source_ref: input.sourceRef,
    });
    return toQaProjectionRecord(record);
  }
}

export function buildProjectionId(tenantId: string, question: string): string {
  const hash = createHash("sha256")
    .update(`${tenantId}\u0000${question.trim().toLowerCase()}`)
    .digest("hex");
  return toUuidFromHex(hash.slice(0, 32));
}

function toQaProjectionRecord(record: {
  id: string;
  tenant_id: string;
  metadata?: Record<string, string | number | boolean | null>;
  updated_at: string;
}): QaProjectionRecord {
  const metadata = record.metadata ?? {};
  const actorId = asString(metadata.actor_id);
  const actorRole = asString(metadata.actor_role);
  return {
    projection_id: record.id,
    tenant_id: record.tenant_id,
    question: asString(metadata.question) ?? "",
    answer: asString(metadata.answer) ?? "",
    provider_key: asString(metadata.provider_key) ?? deriveProviderFromSource(asString(metadata.source_channel)),
    channel_key:
      asString(metadata.channel_key) ??
      deriveChannelFromSource(asString(metadata.source_channel)) ??
      asString(metadata.provider_key) ??
      "zoom",
    category_id: asString(metadata.category_id),
    category_key: asString(metadata.category_key),
    status: asQaStatus(metadata.status),
    origin: asQaOrigin(metadata.origin),
    source_channel: asString(metadata.source_channel),
    source_ref: asString(metadata.source_ref),
    trace_id: asString(metadata.trace_id),
    ref_id: asString(metadata.ref_id),
    actor:
      actorId && actorRole
        ? {
            actor_id: actorId,
            actor_name: asString(metadata.actor_name),
            actor_role:
              actorRole === "system"
                ? "system"
                : actorRole === "reviewer"
                  ? "reviewer"
                  : "operator",
          }
        : undefined,
    approved_at: asString(metadata.approved_at) ?? record.updated_at,
    updated_at: asString(metadata.updated_at) ?? record.updated_at,
  };
}

function asString(value: string | number | boolean | null | undefined): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function normalizeActor(actor: ReviewActionActor | undefined): ReviewActionActor | undefined {
  if (!actor?.actor_id) {
    return undefined;
  }
  return {
    actor_id: actor.actor_id.trim(),
    actor_name: actor.actor_name?.trim() || undefined,
    actor_role: actor.actor_role,
  };
}

function asQaStatus(value: string | number | boolean | null | undefined): QaRecordStatus {
  if (value === "validated") {
    return "validated";
  }
  if (value === "archived") {
    return "archived";
  }
  return "draft";
}

function asQaOrigin(value: string | number | boolean | null | undefined): QaRecordOrigin {
  if (value === "studio") {
    return "studio";
  }
  if (value === "import") {
    return "import";
  }
  return "manual";
}

function sanitizeKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function deriveProviderFromSource(sourceChannel: string | undefined): string {
  const source = sourceChannel?.trim().toLowerCase() || "zoom";
  if (source.includes(":")) {
    return source.split(":")[0] || "zoom";
  }
  if (source.includes("/")) {
    return source.split("/")[0] || "zoom";
  }
  return source;
}

function deriveChannelFromSource(sourceChannel: string | undefined): string {
  const source = sourceChannel?.trim().toLowerCase();
  if (!source) {
    return "zoom";
  }
  if (source.includes(":")) {
    const part = source.split(":")[1];
    return part?.trim() || source;
  }
  if (source.includes("/")) {
    const part = source.split("/")[1];
    return part?.trim() || source;
  }
  return source;
}

function toUuidFromHex(hex32: string): string {
  const hex = hex32.padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function qaProjectionNamespace(): string {
  return QA_NAMESPACE;
}
