import { createHash } from "node:crypto";
import type { MemoryServerClient } from "./memory-client.js";
import type { QaProjectionRecord, ReviewActionActor } from "./types.js";

const QA_NAMESPACE = "slm.qa.current";
const QA_KIND = "qa_projection";

export type QaProjectionWriteInput = {
  tenantId: string;
  question: string;
  answer: string;
  sourceChannel?: string;
  sourceRef?: string;
  traceId?: string;
  refId?: string;
  actor?: ReviewActionActor;
  approvedAt?: string;
  updatedAt?: string;
};

export class QaProjectionService {
  constructor(
    private readonly memoryClient: MemoryServerClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsertCurrentAnswer(input: QaProjectionWriteInput): Promise<QaProjectionRecord> {
    const question = input.question.trim();
    const answer = input.answer.trim();
    if (!question || !answer) {
      throw new Error("question and answer are required");
    }

    const projectionId = buildProjectionId(input.tenantId, question);
    const approvedAt = input.approvedAt ?? this.now().toISOString();
    const updatedAt = input.updatedAt ?? approvedAt;
    const actor = normalizeActor(input.actor);
    const record = await this.memoryClient.upsert({
      id: projectionId,
      namespace: QA_NAMESPACE,
      kind: QA_KIND,
      content: `${question}\n\n${answer}`,
      metadata: {
        question,
        answer,
        source_channel: input.sourceChannel ?? "zoom",
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

  async getById(projectionId: string): Promise<QaProjectionRecord | null> {
    const record = await this.memoryClient.get(projectionId);
    if (!record || record.namespace !== QA_NAMESPACE || record.kind !== QA_KIND) {
      return null;
    }
    return toQaProjectionRecord(record);
  }

  async list(params: {
    cursor?: string;
    limit?: number;
    query?: string;
  }): Promise<{ records: QaProjectionRecord[]; next_cursor: string | null }> {
    const listed = await this.memoryClient.list({
      namespace: QA_NAMESPACE,
      kind: QA_KIND,
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

function toUuidFromHex(hex32: string): string {
  const hex = hex32.padEnd(32, "0").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function qaProjectionNamespace(): string {
  return QA_NAMESPACE;
}
