import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set(["api_key", "auth_token", "secret", "password", "token"]);

export type SlmPipelineEventType =
  | "dataset.build_started"
  | "dataset.build_succeeded"
  | "dataset.build_failed"
  | "training.run_started"
  | "training.run_succeeded"
  | "training.run_failed"
  | "feedback.applied";

export type SlmPipelineEvent = {
  event_id: string;
  tenant_id: string;
  trace_id: string;
  event_type: SlmPipelineEventType;
  created_at: string;
  input_hash: string;
  output_hash: string;
  metadata?: Record<string, unknown>;
};

export type SlmPipelineEventInput = {
  tenantId: string;
  traceId?: string;
  eventType: SlmPipelineEventType;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

export type SlmPipelineEventSink = {
  emit: (input: SlmPipelineEventInput) => Promise<SlmPipelineEvent>;
};

export class NoopSlmPipelineEventSink implements SlmPipelineEventSink {
  async emit(input: SlmPipelineEventInput): Promise<SlmPipelineEvent> {
    const createdAt = new Date().toISOString();
    return {
      event_id: randomUUID(),
      tenant_id: input.tenantId,
      trace_id: input.traceId ?? randomUUID(),
      event_type: input.eventType,
      created_at: createdAt,
      input_hash: hashPayload(input.input ?? {}),
      output_hash: hashPayload(input.output ?? {}),
      metadata: normalizeMetadata(input.metadata),
    };
  }
}

export class JsonlSlmPipelineEventSink implements SlmPipelineEventSink {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async emit(input: SlmPipelineEventInput): Promise<SlmPipelineEvent> {
    const createdAt = new Date().toISOString();
    const event: SlmPipelineEvent = {
      event_id: randomUUID(),
      tenant_id: input.tenantId,
      trace_id: input.traceId ?? randomUUID(),
      event_type: input.eventType,
      created_at: createdAt,
      input_hash: hashPayload(input.input ?? {}),
      output_hash: hashPayload(input.output ?? {}),
      metadata: normalizeMetadata(input.metadata),
    };
    await this.enqueueWrite(`${JSON.stringify(event)}\n`);
    return event;
  }

  private async enqueueWrite(line: string): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf8");
    });
    return this.writeQueue;
  }
}

export function resolveDefaultSlmPipelineEventsPath(stateDir: string): string {
  return path.join(stateDir, "slm-pipeline-events.jsonl");
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalizeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const scrubbed = scrubSensitive(metadata);
  if (!scrubbed || typeof scrubbed !== "object" || Array.isArray(scrubbed)) {
    return undefined;
  }
  return scrubbed as Record<string, unknown>;
}

function scrubSensitive(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubSensitive(entry));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubSensitive(entry);
  }
  return out;
}
