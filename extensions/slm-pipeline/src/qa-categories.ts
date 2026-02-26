import { createHash } from "node:crypto";
import type { MemoryServerClient } from "./memory-client.js";
import { SlmPipelineError } from "./errors.js";
import type { QaCategoryRecord } from "./types.js";

const TAXONOMY_NAMESPACE = "slm.qa.taxonomy";
const TAXONOMY_KIND = "qa_category";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_LIST_PAGES = 10;

export class QaCategoryService {
  constructor(
    private readonly memoryClient: MemoryServerClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(params: {
    tenantId: string;
    providerKey?: string;
    channelKey?: string;
    includeInactive?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<{ records: QaCategoryRecord[]; next_cursor: string | null }> {
    const targetLimit = normalizeListLimit(params.limit);
    const metadataFilters: Record<string, string> = {};
    if (params.providerKey) {
      metadataFilters.provider_key = params.providerKey;
    }
    if (params.channelKey) {
      metadataFilters.channel_key = params.channelKey;
    }
    if (!params.includeInactive) {
      metadataFilters.is_active = "true";
    }
    const records: QaCategoryRecord[] = [];
    let cursor = params.cursor;
    let nextCursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES && records.length < targetLimit; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const listed = await this.memoryClient.list({
        namespace: TAXONOMY_NAMESPACE,
        kind: TAXONOMY_KIND,
        metadata_filters: Object.keys(metadataFilters).length > 0 ? metadataFilters : undefined,
        cursor,
        limit: targetLimit,
        sort_by: "updated_at",
        sort_order: "desc",
      });
      const pageRecords = listed.records
        .map((record) => toQaCategoryRecord(record))
        .filter((record) => record.tenant_id === params.tenantId);
      for (const record of pageRecords) {
        records.push(record);
        if (records.length >= targetLimit) {
          break;
        }
      }
      nextCursor = listed.next_cursor;
      if (!nextCursor || records.length >= targetLimit) {
        break;
      }
      cursor = nextCursor;
    }
    records.sort(
      (a: QaCategoryRecord, b: QaCategoryRecord) =>
        a.sort_order - b.sort_order || a.display_name.localeCompare(b.display_name),
    );
    const trimmed = records.slice(0, targetLimit);

    return {
      records: trimmed,
      next_cursor: nextCursor,
    };
  }

  async getById(params: {
    tenantId: string;
    categoryId: string;
  }): Promise<QaCategoryRecord | null> {
    const record = await this.memoryClient.get(params.categoryId);
    if (
      !record ||
      record.tenant_id !== params.tenantId ||
      record.namespace !== TAXONOMY_NAMESPACE ||
      record.kind !== TAXONOMY_KIND
    ) {
      return null;
    }
    return toQaCategoryRecord(record);
  }

  async create(params: {
    tenantId: string;
    providerKey: string;
    channelKey: string;
    categoryKey: string;
    displayName: string;
    sortOrder?: number;
  }): Promise<QaCategoryRecord> {
    const providerKey = normalizeKey(params.providerKey);
    const channelKey = normalizeKey(params.channelKey);
    const categoryKey = normalizeKey(params.categoryKey);
    const categoryId = buildCategoryId(params.tenantId, providerKey, channelKey, categoryKey);
    const existing = await this.memoryClient.get(categoryId);
    if (existing && existing.tenant_id === params.tenantId && existing.namespace === TAXONOMY_NAMESPACE && existing.kind === TAXONOMY_KIND) {
      throw new SlmPipelineError(409, "category_conflict", "category already exists for provider/channel/category key");
    }
    const nowIso = this.now().toISOString();
    const created = await this.memoryClient.upsert({
      id: categoryId,
      namespace: TAXONOMY_NAMESPACE,
      kind: TAXONOMY_KIND,
      content: params.displayName.trim(),
      metadata: {
        provider_key: providerKey,
        channel_key: channelKey,
        category_key: categoryKey,
        display_name: params.displayName.trim(),
        is_active: "true",
        sort_order: String(params.sortOrder ?? 1000),
        created_at: nowIso,
        updated_at: nowIso,
      },
    });
    return toQaCategoryRecord(created);
  }

  async update(params: {
    tenantId: string;
    categoryId: string;
    displayName?: string;
    isActive?: boolean;
    sortOrder?: number;
  }): Promise<QaCategoryRecord | null> {
    const current = await this.memoryClient.get(params.categoryId);
    if (!current || current.tenant_id !== params.tenantId || current.namespace !== TAXONOMY_NAMESPACE || current.kind !== TAXONOMY_KIND) {
      return null;
    }
    const currentMetadata = current.metadata ?? {};
    const nowIso = this.now().toISOString();
    const next = await this.memoryClient.upsert({
      id: current.id,
      namespace: TAXONOMY_NAMESPACE,
      kind: TAXONOMY_KIND,
      content: params.displayName?.trim() || asString(currentMetadata.display_name) || current.content,
      metadata: {
        provider_key: asString(currentMetadata.provider_key) ?? "",
        channel_key: asString(currentMetadata.channel_key) ?? "",
        category_key: asString(currentMetadata.category_key) ?? "",
        display_name: params.displayName?.trim() || asString(currentMetadata.display_name) || current.content,
        is_active: String(params.isActive ?? asBool(currentMetadata.is_active, true)),
        sort_order: String(params.sortOrder ?? asNumber(currentMetadata.sort_order, 1000)),
        created_at: asString(currentMetadata.created_at) ?? current.created_at,
        updated_at: nowIso,
      },
    });
    return toQaCategoryRecord(next);
  }
}

function toQaCategoryRecord(record: {
  id: string;
  tenant_id: string;
  metadata?: Record<string, string | number | boolean | null>;
  created_at: string;
  updated_at: string;
}): QaCategoryRecord {
  const metadata = record.metadata ?? {};
  return {
    category_id: record.id,
    tenant_id: record.tenant_id,
    provider_key: asString(metadata.provider_key) ?? "",
    channel_key: asString(metadata.channel_key) ?? "",
    category_key: asString(metadata.category_key) ?? "",
    display_name: asString(metadata.display_name) ?? "",
    is_active: asBool(metadata.is_active, true),
    sort_order: asNumber(metadata.sort_order, 1000),
    created_at: asString(metadata.created_at) ?? record.created_at,
    updated_at: asString(metadata.updated_at) ?? record.updated_at,
  };
}

function asString(value: string | number | boolean | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: string | number | boolean | null | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asBool(value: string | number | boolean | null | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return fallback;
}

function normalizeKey(input: string): string {
  return input.trim().toLowerCase();
}

function buildCategoryId(
  tenantId: string,
  providerKey: string,
  channelKey: string,
  categoryKey: string,
): string {
  const hash = createHash("sha256")
    .update(`${tenantId}\u0000${providerKey}\u0000${channelKey}\u0000${categoryKey}`)
    .digest("hex");
  const hex = hash.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function qaTaxonomyNamespace(): string {
  return TAXONOMY_NAMESPACE;
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
