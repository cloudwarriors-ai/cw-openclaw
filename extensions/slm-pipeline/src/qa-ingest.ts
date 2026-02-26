import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ApprovedQaRecord, ImportQaRequest } from "./types.js";

export type QaSource = {
  listApprovedQa: (tenantId: string, source: "zoom") => Promise<ApprovedQaRecord[]>;
};

export class InMemoryQaSource implements QaSource {
  private readonly records: ApprovedQaRecord[] = [];

  add(record: Omit<ApprovedQaRecord, "example_id"> & { example_id?: string }): void {
    this.records.push({
      ...record,
      example_id: record.example_id ?? randomUUID(),
    });
  }

  async listApprovedQa(tenantId: string, source: "zoom"): Promise<ApprovedQaRecord[]> {
    return this.records.filter((record) => record.tenant_id === tenantId && record.source_channel === source);
  }
}

export class JsonlReviewEventQaSource implements QaSource {
  constructor(private readonly filePath: string) {}

  async listApprovedQa(tenantId: string, source: "zoom"): Promise<ApprovedQaRecord[]> {
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
      if (!event || event.tenant_id !== tenantId || event.event_type !== "qa.approved") {
        continue;
      }
      const question = typeof event.question === "string" ? event.question.trim() : "";
      const answer = typeof event.answer === "string" ? event.answer.trim() : "";
      if (!question || !answer || seen.has(event.event_id)) {
        continue;
      }

      out.push({
        example_id: event.event_id,
        tenant_id: tenantId,
        source_channel: source,
        source_message_ids: typeof event.ref_id === "string" ? [event.ref_id] : [event.event_id],
        question,
        answer,
        citations: [],
        approved_by: typeof event.actor_name === "string" ? event.actor_name : "reviewer",
        approved_at: event.created_at,
      });
      seen.add(event.event_id);
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
    const sourceRecords = await this.source.listApprovedQa(request.tenant_id, request.source);
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
