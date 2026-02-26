import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type PipelineApprovedReviewEvent = {
  event_id: string;
  tenant_id: string;
  trace_id: string;
  event_type: "qa.approved";
  created_at: string;
  input_hash: string;
  output_hash: string;
  ref_id?: string;
  actor_id?: string;
  actor_name?: string;
  source_channel_jid?: string;
  question: string;
  answer: string;
  metadata?: Record<string, unknown>;
};

export async function emitPipelineReviewEvent(params: {
  tenantId: string;
  eventType: "qa.approved";
  traceId?: string;
  refId?: string;
  actorId?: string;
  actorName?: string;
  sourceChannelJid?: string;
  question: string;
  answer: string;
  metadata?: Record<string, unknown>;
  storePath: string;
  now?: () => Date;
}): Promise<PipelineApprovedReviewEvent> {
  const now = params.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const question = params.question.trim();
  const answer = params.answer.trim();
  const traceId = params.traceId?.trim() || randomUUID();
  const event: PipelineApprovedReviewEvent = {
    event_id: randomUUID(),
    tenant_id: params.tenantId,
    trace_id: traceId,
    event_type: params.eventType,
    created_at: createdAt,
    input_hash: hashJson({
      question,
      source_channel_jid: params.sourceChannelJid ?? null,
    }),
    output_hash: hashJson({ answer }),
    ref_id: params.refId?.trim() || undefined,
    actor_id: params.actorId?.trim() || undefined,
    actor_name: params.actorName?.trim() || undefined,
    source_channel_jid: params.sourceChannelJid?.trim() || undefined,
    question,
    answer,
    metadata: sanitizeMetadata(params.metadata),
  };

  await fs.mkdir(path.dirname(params.storePath), { recursive: true });
  await fs.appendFile(params.storePath, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sanitizeMetadata(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(([key]) => key.trim().length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}
