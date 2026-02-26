import { randomUUID } from "node:crypto";
import type {
  ListRequest,
  MemoryCreateInput,
  MemoryRecord,
  MemoryUpsertInput,
  SearchRequest,
  TimelineRequest,
} from "./types.js";
import { MemoryApiError } from "./errors.js";

export type MemorySearchResult = {
  record: MemoryRecord;
  score: number;
};

export type MemoryListResult = {
  records: MemoryRecord[];
  nextCursor?: string;
};

export type MemoryGetOptions = {
  includeDeleted?: boolean;
};

export type MemoryStore = {
  create: (tenantId: string, input: MemoryCreateInput) => Promise<MemoryRecord>;
  bulkCreate: (tenantId: string, inputs: MemoryCreateInput[]) => Promise<MemoryRecord[]>;
  upsert: (tenantId: string, input: MemoryUpsertInput) => Promise<MemoryRecord>;
  get: (tenantId: string, id: string, options?: MemoryGetOptions) => Promise<MemoryRecord | null>;
  delete: (tenantId: string, id: string) => Promise<boolean>;
  list: (tenantId: string, request: ListRequest) => Promise<MemoryListResult>;
  timeline: (tenantId: string, request: TimelineRequest) => Promise<MemoryRecord[]>;
  search: (tenantId: string, request: SearchRequest) => Promise<MemorySearchResult[]>;
  queryEmbeddingModel: string;
  queryEmbeddingVersion: string;
};

export class InMemoryMemoryStore implements MemoryStore {
  readonly queryEmbeddingModel = "lexical-v1";
  readonly queryEmbeddingVersion = "1";

  private readonly recordsByTenant = new Map<string, Map<string, MemoryRecord>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(tenantId: string, input: MemoryCreateInput): Promise<MemoryRecord> {
    const timestamp = this.now().toISOString();
    const record: MemoryRecord = {
      ...input,
      id: randomUUID(),
      tenant_id: tenantId,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: undefined,
    };
    this.getTenantRecords(tenantId).set(record.id, record);
    return record;
  }

  async bulkCreate(tenantId: string, inputs: MemoryCreateInput[]): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for (const input of inputs) {
      out.push(await this.create(tenantId, input));
    }
    return out;
  }

  async upsert(tenantId: string, input: MemoryUpsertInput): Promise<MemoryRecord> {
    const bucket = this.getTenantRecords(tenantId);
    const current = bucket.get(input.id);
    const timestamp = this.now().toISOString();
    if (current) {
      const updated: MemoryRecord = {
        ...current,
        namespace: input.namespace,
        kind: input.kind,
        content: input.content,
        metadata: input.metadata,
        source_ref: input.source_ref,
        updated_at: timestamp,
        deleted_at: undefined,
      };
      bucket.set(updated.id, updated);
      return updated;
    }

    if (this.existsInOtherTenant(tenantId, input.id)) {
      throw new MemoryApiError(
        409,
        "id_conflict",
        "memory id already exists in a different tenant",
      );
    }

    const created: MemoryRecord = {
      ...input,
      tenant_id: tenantId,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: undefined,
    };
    bucket.set(created.id, created);
    return created;
  }

  async get(tenantId: string, id: string, options?: MemoryGetOptions): Promise<MemoryRecord | null> {
    const record = this.getTenantRecords(tenantId).get(id) ?? null;
    if (!record) {
      return null;
    }
    if (record.deleted_at && !options?.includeDeleted) {
      return null;
    }
    return record;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const bucket = this.getTenantRecords(tenantId);
    const current = bucket.get(id);
    if (!current || current.deleted_at) {
      return false;
    }
    const timestamp = this.now().toISOString();
    bucket.set(id, {
      ...current,
      deleted_at: timestamp,
      updated_at: timestamp,
    });
    return true;
  }

  async list(tenantId: string, request: ListRequest): Promise<MemoryListResult> {
    const decodedCursor = request.cursor ? decodeListCursor(request.cursor) : null;
    if (decodedCursor) {
      ensureCursorMatchesRequest(decodedCursor, request);
    }

    const records = [...this.getTenantRecords(tenantId).values()]
      .filter((record) => !request.namespace || record.namespace === request.namespace)
      .filter((record) => !request.kind || record.kind === request.kind)
      .filter((record) => request.include_deleted || !record.deleted_at)
      .filter((record) => metadataMatches(record.metadata, request.metadata_filters))
      .toSorted((a, b) => compareListRecords(a, b, request.sort_by, request.sort_order));

    const paged = decodedCursor
      ? records.filter((record) => compareRecordWithCursor(record, decodedCursor) > 0)
      : records;

    const window = paged.slice(0, request.limit + 1);
    const pageRecords = window.slice(0, request.limit);
    const lastRecord = pageRecords[pageRecords.length - 1];
    const nextCursor =
      window.length > request.limit && lastRecord
        ? encodeListCursor({
            sortBy: request.sort_by,
            sortOrder: request.sort_order,
            sortValue: lastRecord[request.sort_by],
            id: lastRecord.id,
          })
        : undefined;
    return {
      records: pageRecords,
      nextCursor,
    };
  }

  async timeline(tenantId: string, request: TimelineRequest): Promise<MemoryRecord[]> {
    const fromMs = request.from ? Date.parse(request.from) : Number.NEGATIVE_INFINITY;
    const toMs = request.to ? Date.parse(request.to) : Number.POSITIVE_INFINITY;
    return [...this.getTenantRecords(tenantId).values()]
      .filter((record) => !request.namespace || record.namespace === request.namespace)
      .filter((record) => !request.kind || record.kind === request.kind)
      .filter((record) => request.include_deleted || !record.deleted_at)
      .filter((record) => {
        const createdAt = Date.parse(record.created_at);
        return createdAt >= fromMs && createdAt <= toMs;
      })
      .toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .slice(0, request.limit);
  }

  async search(tenantId: string, request: SearchRequest): Promise<MemorySearchResult[]> {
    if (request.embedding_model && request.embedding_model !== this.queryEmbeddingModel) {
      return [];
    }
    if (request.embedding_version && request.embedding_version !== this.queryEmbeddingVersion) {
      return [];
    }

    const queryTokens = tokenize(request.query_text);
    if (queryTokens.size === 0) {
      return [];
    }

    const nowMs = this.now().getTime();
    const filtered = [...this.getTenantRecords(tenantId).values()]
      .filter((record) => !request.namespace || record.namespace === request.namespace)
      .filter((record) => request.include_deleted || !record.deleted_at)
      .filter((record) => metadataMatches(record.metadata, request.metadata_filters))
      .map((record) => ({
        record,
        score: scoreRecord({
          record,
          queryTokens,
          nowMs,
        }),
      }))
      .filter((hit) => hit.score >= request.min_score)
      .toSorted(
        (a, b) =>
          b.score - a.score ||
          b.record.updated_at.localeCompare(a.record.updated_at) ||
          b.record.id.localeCompare(a.record.id),
      );

    return filtered.slice(0, request.top_k);
  }

  private getTenantRecords(tenantId: string): Map<string, MemoryRecord> {
    const existing = this.recordsByTenant.get(tenantId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, MemoryRecord>();
    this.recordsByTenant.set(tenantId, created);
    return created;
  }

  private existsInOtherTenant(tenantId: string, id: string): boolean {
    for (const [candidateTenantId, records] of this.recordsByTenant) {
      if (candidateTenantId === tenantId) {
        continue;
      }
      if (records.has(id)) {
        return true;
      }
    }
    return false;
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  );
}

function metadataMatches(
  metadata: Record<string, string | number | boolean | null> | undefined,
  filters: Record<string, string | number | boolean | null> | undefined,
): boolean {
  if (!filters || Object.keys(filters).length === 0) {
    return true;
  }
  for (const [key, value] of Object.entries(filters)) {
    if (!metadata || metadata[key] !== value) {
      return false;
    }
  }
  return true;
}

function scoreRecord(params: {
  record: MemoryRecord;
  queryTokens: Set<string>;
  nowMs: number;
}): number {
  const contentTokens = tokenize(params.record.content);
  if (contentTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of params.queryTokens) {
    if (contentTokens.has(token)) {
      overlap += 1;
    }
  }
  const overlapScore = overlap / params.queryTokens.size;
  const ageHours = Math.max(0, (params.nowMs - Date.parse(params.record.updated_at)) / 3_600_000);
  const recencyScore = 1 / (1 + ageHours / 24);
  const weighted = overlapScore * 0.85 + recencyScore * 0.15;
  return Math.max(0, Math.min(1, weighted));
}

export type ListCursor = {
  sortBy: ListRequest["sort_by"];
  sortOrder: ListRequest["sort_order"];
  sortValue: string;
  id: string;
};

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(
    JSON.stringify({
      sort_by: cursor.sortBy,
      sort_order: cursor.sortOrder,
      sort_value: cursor.sortValue,
      id: cursor.id,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeListCursor(cursor: string): ListCursor {
  let decoded = "";
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new MemoryApiError(400, "invalid_cursor", "cursor is not valid base64url");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded) as unknown;
  } catch {
    throw new MemoryApiError(400, "invalid_cursor", "cursor payload is not valid JSON");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MemoryApiError(400, "invalid_cursor", "cursor payload must be an object");
  }

  const value = payload as {
    sort_by?: unknown;
    sort_order?: unknown;
    sort_value?: unknown;
    id?: unknown;
  };
  if (value.sort_by !== "created_at" && value.sort_by !== "updated_at") {
    throw new MemoryApiError(400, "invalid_cursor", "cursor sort_by is invalid");
  }
  if (value.sort_order !== "asc" && value.sort_order !== "desc") {
    throw new MemoryApiError(400, "invalid_cursor", "cursor sort_order is invalid");
  }
  if (typeof value.sort_value !== "string" || value.sort_value.length === 0) {
    throw new MemoryApiError(400, "invalid_cursor", "cursor sort_value is invalid");
  }
  if (Number.isNaN(Date.parse(value.sort_value))) {
    throw new MemoryApiError(400, "invalid_cursor", "cursor sort_value is not a timestamp");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new MemoryApiError(400, "invalid_cursor", "cursor id is invalid");
  }

  return {
    sortBy: value.sort_by,
    sortOrder: value.sort_order,
    sortValue: value.sort_value,
    id: value.id,
  };
}

export function ensureCursorMatchesRequest(cursor: ListCursor, request: ListRequest): void {
  if (cursor.sortBy !== request.sort_by || cursor.sortOrder !== request.sort_order) {
    throw new MemoryApiError(400, "invalid_cursor", "cursor sort does not match request sort");
  }
}

function compareListRecords(
  a: MemoryRecord,
  b: MemoryRecord,
  sortBy: ListRequest["sort_by"],
  sortOrder: ListRequest["sort_order"],
): number {
  const aValue = a[sortBy];
  const bValue = b[sortBy];
  if (sortOrder === "asc") {
    return aValue.localeCompare(bValue) || a.id.localeCompare(b.id);
  }
  return bValue.localeCompare(aValue) || b.id.localeCompare(a.id);
}

function compareRecordWithCursor(record: MemoryRecord, cursor: ListCursor): number {
  const recordSortValue = record[cursor.sortBy];
  if (cursor.sortOrder === "asc") {
    return recordSortValue.localeCompare(cursor.sortValue) || record.id.localeCompare(cursor.id);
  }
  return cursor.sortValue.localeCompare(recordSortValue) || cursor.id.localeCompare(record.id);
}
