import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { MemoryServerClient } from "./memory-client.js";
import type { ApprovedQaRecord, ImportQaRequest } from "./types.js";

const MEMORY_LIST_PAGE_LIMIT = 200;

export type QaSourceType = "zoom" | "library";

export type QaSourceListRequest = {
  tenantId: string;
  source: QaSourceType;
  providerKey?: string;
  channelKey?: string;
  categoryId?: string;
  status?: "draft" | "validated" | "archived";
};

export type QaSource = {
  listApprovedQa: (request: QaSourceListRequest) => Promise<ApprovedQaRecord[]>;
};

export class InMemoryQaSource implements QaSource {
  private readonly records: ApprovedQaRecord[] = [];

  add(record: Omit<ApprovedQaRecord, "example_id"> & { example_id?: string }): void {
    this.records.push({
      ...record,
      example_id: record.example_id ?? randomUUID(),
    });
  }

  async listApprovedQa(request: QaSourceListRequest): Promise<ApprovedQaRecord[]> {
    if (request.source === "zoom") {
      return this.records.filter(
        (record) =>
          record.tenant_id === request.tenantId &&
          record.source_channel === "zoom",
      );
    }
    const status = request.status ?? "validated";
    return this.records.filter((record) => {
      const provider = (record.provider_key ?? record.source_channel).toLowerCase();
      const channel = (record.channel_key ?? record.source_channel).toLowerCase();
      return (
        record.tenant_id === request.tenantId &&
        (record.status ?? "validated") === status &&
        (!request.providerKey || provider === request.providerKey) &&
        (!request.channelKey || channel === request.channelKey) &&
        (!request.categoryId || record.category_id === request.categoryId)
      );
    });
  }
}

export class JsonlReviewEventQaSource implements QaSource {
  constructor(private readonly filePath: string) {}

  async listApprovedQa(request: QaSourceListRequest): Promise<ApprovedQaRecord[]> {
    if (request.source !== "zoom") {
      return [];
    }
    let content = "";
    try {
      content = await fs.readFile(this.filePath, "utf8");
    } catch {
      return [];
    }

    const out: ApprovedQaRecord[] = [];
    const seen = new Set<string>();

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const event = parseEvent(trimmed);
      if (!event || event.tenant_id !== request.tenantId || event.event_type !== "qa.approved") {
        continue;
      }
      const question = typeof event.question === "string" ? event.question.trim() : "";
      const answer = typeof event.answer === "string" ? event.answer.trim() : "";
      if (!question || !answer || seen.has(event.event_id)) {
        continue;
      }

      out.push({
        example_id: event.event_id,
        tenant_id: request.tenantId,
        source_channel: "zoom",
        source_message_ids: typeof event.ref_id === "string" ? [event.ref_id] : [event.event_id],
        question,
        answer,
        citations: [],
        approved_by: typeof event.actor_name === "string" ? event.actor_name : "reviewer",
        approved_at: event.created_at,
        provider_key: "zoom",
        channel_key: "zoom",
        status: "validated",
        origin: "import",
      });
      seen.add(event.event_id);
    }

    return out;
  }
}

export class MemoryProjectionQaSource implements QaSource {
  constructor(private readonly memoryClient: MemoryServerClient) {}

  async listApprovedQa(request: QaSourceListRequest): Promise<ApprovedQaRecord[]> {
    if (request.source !== "library") {
      return [];
    }
    const metadataFilters: Record<string, string> = {};
    metadataFilters.status = request.status ?? "validated";
    if (request.providerKey) {
      metadataFilters.provider_key = request.providerKey;
    }
    if (request.channelKey) {
      metadataFilters.channel_key = request.channelKey;
    }
    if (request.categoryId) {
      metadataFilters.category_id = request.categoryId;
    }

    const out: ApprovedQaRecord[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const listed = await this.memoryClient.list({
        namespace: "slm.qa.current",
        kind: "qa_projection",
        metadata_filters: metadataFilters,
        cursor,
        limit: MEMORY_LIST_PAGE_LIMIT,
        sort_by: "updated_at",
        sort_order: "desc",
      });

      const mapped = listed.records.map((record): ApprovedQaRecord | null => {
        const metadata = record.metadata ?? {};
        const question = asString(metadata.question);
        const answer = asString(metadata.answer);
        if (!question || !answer) {
          return null;
        }
        return {
          example_id: record.id,
          tenant_id: record.tenant_id,
          source_channel: asString(metadata.source_channel) ?? "library",
          source_message_ids: [asString(metadata.ref_id) ?? record.id],
          question,
          answer,
          citations: [] as string[],
          approved_by: asString(metadata.actor_name) ?? "operator",
          approved_at: asString(metadata.approved_at) ?? record.updated_at,
          provider_key: asString(metadata.provider_key) ?? "zoom",
          channel_key: asString(metadata.channel_key) ?? asString(metadata.provider_key) ?? "zoom",
          category_id: asString(metadata.category_id),
          category_key: asString(metadata.category_key),
          status: asStatus(asString(metadata.status)),
          origin: asOrigin(asString(metadata.origin)),
        } satisfies ApprovedQaRecord;
      });
      const kept = mapped
        .filter((record): record is ApprovedQaRecord => record !== null)
        .filter((record) => record.tenant_id === request.tenantId);
      out.push(...kept);
      if (!listed.next_cursor) {
        break;
      }
      cursor = listed.next_cursor;
    }

    return out;
  }
}

export class CompositeQaSource implements QaSource {
  constructor(private readonly sources: QaSource[]) {}

  async listApprovedQa(request: QaSourceListRequest): Promise<ApprovedQaRecord[]> {
    const out: ApprovedQaRecord[] = [];
    const seen = new Set<string>();
    for (const source of this.sources) {
      // eslint-disable-next-line no-await-in-loop
      const listed = await source.listApprovedQa(request);
      for (const record of listed) {
        if (seen.has(record.example_id)) {
          continue;
        }
        seen.add(record.example_id);
        out.push(record);
      }
    }
    return out;
  }
}

export function resolveDefaultZoomReviewEventsPath(stateDir: string): string {
  return path.join(stateDir, "zoom-review-events.jsonl");
}

export class QaIngestService {
  constructor(private readonly source: QaSource) {}

  async importApproved(request: ImportQaRequest, existing: ApprovedQaRecord[]): Promise<ApprovedQaRecord[]> {
    const sourceRecords = await this.source.listApprovedQa({
      tenantId: request.tenant_id,
      source: request.source,
      providerKey: request.provider_key,
      channelKey: request.channel_key,
      categoryId: request.category_id,
      status: request.status,
    });
    const existingIds = new Set(existing.map((record) => record.example_id));
    return sourceRecords.filter((record) => !existingIds.has(record.example_id));
  }
}

type ReviewEvent = {
  event_id: string;
  tenant_id: string;
  event_type: string;
  created_at: string;
  ref_id?: string;
  actor_name?: string;
  question?: string;
  answer?: string;
};

function parseEvent(line: string): ReviewEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const event = parsed as Record<string, unknown>;
    if (
      typeof event.event_id !== "string" ||
      typeof event.tenant_id !== "string" ||
      typeof event.event_type !== "string" ||
      typeof event.created_at !== "string"
    ) {
      return null;
    }
    return {
      event_id: event.event_id,
      tenant_id: event.tenant_id,
      event_type: event.event_type,
      created_at: event.created_at,
      ref_id: typeof event.ref_id === "string" ? event.ref_id : undefined,
      actor_name: typeof event.actor_name === "string" ? event.actor_name : undefined,
      question: typeof event.question === "string" ? event.question : undefined,
      answer: typeof event.answer === "string" ? event.answer : undefined,
    };
  } catch {
    return null;
  }
}

function asString(value: string | number | boolean | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asStatus(value: string | undefined): "draft" | "validated" | "archived" {
  if (value === "draft" || value === "archived") {
    return value;
  }
  return "validated";
}

function asOrigin(value: string | undefined): "manual" | "studio" | "import" {
  if (value === "studio" || value === "import") {
    return value;
  }
  return "manual";
}
