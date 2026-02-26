import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { EmbeddingProvider } from "./embeddings.js";
import type {
  ListRequest,
  MemoryCreateInput,
  MemoryRecord,
  MemoryUpsertInput,
  SearchRequest,
  TimelineRequest,
} from "./types.js";
import { resolveEmbeddingProviderFromEnv } from "./embeddings.js";
import { MemoryApiError } from "./errors.js";
import {
  decodeListCursor,
  encodeListCursor,
  ensureCursorMatchesRequest,
  type MemoryGetOptions,
  type MemoryListResult,
  type MemorySearchResult,
  type MemoryStore,
} from "./store.js";

const DEFAULT_EMBEDDING_VERSION = "1";

type MemoryRow = {
  id: string;
  tenant_id: string;
  namespace: string;
  kind: string;
  content: string;
  metadata_json: Record<string, string | number | boolean | null> | null;
  source_ref: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

type Queryable = {
  query: (query: string, values?: unknown[]) => Promise<unknown>;
};

export class PostgresMemoryStore implements MemoryStore {
  readonly queryEmbeddingModel: string;
  readonly queryEmbeddingVersion: string;

  private readonly pool: Pool;
  private readonly embeddingProvider: EmbeddingProvider;
  private schemaReady: Promise<void> | null = null;

  constructor(params: {
    connectionString: string;
    embeddingProvider?: EmbeddingProvider;
    maxConnections?: number;
  }) {
    this.pool = new Pool({
      connectionString: params.connectionString,
      max: params.maxConnections ?? 10,
      application_name: "openclaw-memory-server",
    });
    this.embeddingProvider =
      params.embeddingProvider ?? resolveEmbeddingProviderFromEnv(process.env);
    this.queryEmbeddingModel = this.embeddingProvider.model;
    this.queryEmbeddingVersion = this.embeddingProvider.version || DEFAULT_EMBEDDING_VERSION;
  }

  async create(tenantId: string, input: MemoryCreateInput): Promise<MemoryRecord> {
    await this.ensureSchema();
    const embedding = await this.embeddingProvider.embed(input.content);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = randomUUID();
      const created = await client.query<MemoryRow>(
        `INSERT INTO memories (id, tenant_id, namespace, kind, content, metadata_json, source_ref, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL)
         RETURNING *`,
        [
          id,
          tenantId,
          input.namespace,
          input.kind,
          input.content,
          JSON.stringify(input.metadata ?? {}),
          input.source_ref ?? null,
        ],
      );
      await this.upsertVector(client, {
        memoryId: id,
        tenantId,
        embedding,
      });
      await this.logAccess(client, {
        tenantId,
        operation: "create",
        status: "ok",
      });
      await client.query("COMMIT");
      const row = created.rows[0];
      if (!row) {
        throw new Error("memory insert returned no rows");
      }
      return toMemoryRecord(row);
    } catch (error) {
      await client.query("ROLLBACK");
      await this.logAccess(client, {
        tenantId,
        operation: "create",
        status: "error",
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async bulkCreate(tenantId: string, inputs: MemoryCreateInput[]): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for (const input of inputs) {
      out.push(await this.create(tenantId, input));
    }
    return out;
  }

  async upsert(tenantId: string, input: MemoryUpsertInput): Promise<MemoryRecord> {
    await this.ensureSchema();
    const embedding = await this.embeddingProvider.embed(input.content);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existingTenant = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM memories WHERE id = $1",
        [input.id],
      );
      const existing = existingTenant.rows[0];
      if (existing && existing.tenant_id !== tenantId) {
        throw new MemoryApiError(
          409,
          "id_conflict",
          "memory id already exists in a different tenant",
        );
      }

      const saved = await client.query<MemoryRow>(
        `INSERT INTO memories (id, tenant_id, namespace, kind, content, metadata_json, source_ref, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL)
         ON CONFLICT (id)
         DO UPDATE SET
           namespace = EXCLUDED.namespace,
           kind = EXCLUDED.kind,
           content = EXCLUDED.content,
           metadata_json = EXCLUDED.metadata_json,
           source_ref = EXCLUDED.source_ref,
           updated_at = NOW(),
           deleted_at = NULL
         WHERE memories.tenant_id = EXCLUDED.tenant_id
         RETURNING *`,
        [
          input.id,
          tenantId,
          input.namespace,
          input.kind,
          input.content,
          JSON.stringify(input.metadata ?? {}),
          input.source_ref ?? null,
        ],
      );
      const row = saved.rows[0];
      if (!row) {
        throw new MemoryApiError(
          409,
          "id_conflict",
          "memory id already exists in a different tenant",
        );
      }

      await this.upsertVector(client, {
        memoryId: input.id,
        tenantId,
        embedding,
      });
      await this.logAccess(client, {
        tenantId,
        operation: "upsert",
        status: "ok",
      });
      await client.query("COMMIT");
      return toMemoryRecord(row);
    } catch (error) {
      await client.query("ROLLBACK");
      await this.logAccess(client, {
        tenantId,
        operation: "upsert",
        status: "error",
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async get(tenantId: string, id: string, options?: MemoryGetOptions): Promise<MemoryRecord | null> {
    await this.ensureSchema();
    const query = options?.includeDeleted
      ? "SELECT * FROM memories WHERE tenant_id = $1 AND id = $2"
      : "SELECT * FROM memories WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL";
    const result = await this.pool.query<MemoryRow>(query, [tenantId, id]);
    await this.logAccess(this.pool, {
      tenantId,
      operation: "get",
      status: "ok",
    });
    return result.rows[0] ? toMemoryRecord(result.rows[0]) : null;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE memories
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, id],
    );
    await this.logAccess(this.pool, {
      tenantId,
      operation: "delete",
      status: "ok",
    });
    return result.rowCount > 0;
  }

  async list(tenantId: string, request: ListRequest): Promise<MemoryListResult> {
    await this.ensureSchema();
    const sortColumn = request.sort_by === "updated_at" ? "m.updated_at" : "m.created_at";
    const sortDirection = request.sort_order === "asc" ? "ASC" : "DESC";
    const whereParts = ["m.tenant_id = $1"];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    if (request.namespace) {
      whereParts.push(`m.namespace = $${paramIdx}`);
      params.push(request.namespace);
      paramIdx += 1;
    }

    if (request.kind) {
      whereParts.push(`m.kind = $${paramIdx}`);
      params.push(request.kind);
      paramIdx += 1;
    }

    if (!request.include_deleted) {
      whereParts.push("m.deleted_at IS NULL");
    }

    if (request.metadata_filters && Object.keys(request.metadata_filters).length > 0) {
      whereParts.push(`m.metadata_json @> $${paramIdx}::jsonb`);
      params.push(JSON.stringify(request.metadata_filters));
      paramIdx += 1;
    }

    const cursor = request.cursor ? decodeListCursor(request.cursor) : null;
    if (cursor) {
      ensureCursorMatchesRequest(cursor, request);
      const comparator = request.sort_order === "asc" ? ">" : "<";
      whereParts.push(
        `(${sortColumn}, m.id) ${comparator} ($${paramIdx}::timestamptz, $${paramIdx + 1}::uuid)`,
      );
      params.push(cursor.sortValue, cursor.id);
      paramIdx += 2;
    }

    params.push(request.limit + 1);
    const limitParam = `$${paramIdx}`;

    const result = await this.pool.query<MemoryRow>(
      `SELECT m.*
       FROM memories m
       WHERE ${whereParts.join(" AND ")}
       ORDER BY ${sortColumn} ${sortDirection}, m.id ${sortDirection}
       LIMIT ${limitParam}`,
      params,
    );
    await this.logAccess(this.pool, {
      tenantId,
      operation: "list",
      status: "ok",
    });

    const pageRows = result.rows.slice(0, request.limit);
    const records = pageRows.map((row) => toMemoryRecord(row));
    const lastRecord = records[records.length - 1];
    const nextCursor =
      result.rows.length > request.limit && lastRecord
        ? encodeListCursor({
            sortBy: request.sort_by,
            sortOrder: request.sort_order,
            sortValue: lastRecord[request.sort_by],
            id: lastRecord.id,
          })
        : undefined;

    return {
      records,
      nextCursor,
    };
  }

  async search(tenantId: string, request: SearchRequest): Promise<MemorySearchResult[]> {
    await this.ensureSchema();
    const queryEmbedding = await this.embeddingProvider.embed(request.query_text);
    const queryEmbeddingModel = request.embedding_model ?? this.queryEmbeddingModel;
    const queryEmbeddingVersion = request.embedding_version ?? this.queryEmbeddingVersion;
    const whereParts = ["m.tenant_id = $1", "v.tenant_id = $1"];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    if (request.namespace) {
      whereParts.push(`m.namespace = $${paramIdx}`);
      params.push(request.namespace);
      paramIdx += 1;
    }

    if (request.metadata_filters && Object.keys(request.metadata_filters).length > 0) {
      whereParts.push(`m.metadata_json @> $${paramIdx}::jsonb`);
      params.push(JSON.stringify(request.metadata_filters));
      paramIdx += 1;
    }

    if (!request.include_deleted) {
      whereParts.push("m.deleted_at IS NULL");
    }

    whereParts.push(`v.embedding_model = $${paramIdx}`);
    params.push(queryEmbeddingModel);
    paramIdx += 1;

    whereParts.push(`v.embedding_version = $${paramIdx}`);
    params.push(queryEmbeddingVersion);
    paramIdx += 1;

    const vectorParam = `$${paramIdx}`;
    params.push(toPgVector(queryEmbedding));
    paramIdx += 1;

    const minScoreParam = `$${paramIdx}`;
    params.push(request.min_score);
    paramIdx += 1;

    const topKParam = `$${paramIdx}`;
    params.push(request.top_k);

    const result = await this.pool.query<MemoryRow & { score: number }>(
      `SELECT
         m.*,
         (1 - (v.embedding <=> ${vectorParam}::vector)) AS score
       FROM memories m
       INNER JOIN memory_vectors v ON v.memory_id = m.id
       WHERE ${whereParts.join(" AND ")}
         AND (1 - (v.embedding <=> ${vectorParam}::vector)) >= ${minScoreParam}
       ORDER BY score DESC, m.updated_at DESC, m.id DESC
       LIMIT ${topKParam}`,
      params,
    );
    await this.logAccess(this.pool, {
      tenantId,
      operation: "search",
      status: "ok",
    });
    return result.rows.map((row) => ({
      record: toMemoryRecord(row),
      score: row.score,
    }));
  }

  async timeline(tenantId: string, request: TimelineRequest): Promise<MemoryRecord[]> {
    await this.ensureSchema();
    const whereParts = ["m.tenant_id = $1"];
    const params: unknown[] = [tenantId];
    let paramIdx = 2;

    if (request.namespace) {
      whereParts.push(`m.namespace = $${paramIdx}`);
      params.push(request.namespace);
      paramIdx += 1;
    }

    if (request.kind) {
      whereParts.push(`m.kind = $${paramIdx}`);
      params.push(request.kind);
      paramIdx += 1;
    }

    if (request.from) {
      whereParts.push(`m.created_at >= $${paramIdx}::timestamptz`);
      params.push(request.from);
      paramIdx += 1;
    }

    if (request.to) {
      whereParts.push(`m.created_at <= $${paramIdx}::timestamptz`);
      params.push(request.to);
      paramIdx += 1;
    }

    if (!request.include_deleted) {
      whereParts.push("m.deleted_at IS NULL");
    }

    params.push(request.limit);
    const limitParam = `$${paramIdx}`;
    const result = await this.pool.query<MemoryRow>(
      `SELECT m.*
       FROM memories m
       WHERE ${whereParts.join(" AND ")}
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT ${limitParam}`,
      params,
    );
    await this.logAccess(this.pool, {
      tenantId,
      operation: "timeline",
      status: "ok",
    });
    return result.rows.map((row) => toMemoryRecord(row));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return this.schemaReady;
    }
    this.schemaReady = this.applySchema();
    return this.schemaReady;
  }

  private async applySchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`
        CREATE TABLE IF NOT EXISTS memories (
          id UUID PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          namespace TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_ref TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at TIMESTAMPTZ
        )
      `);
      await client.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ");
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_vectors (
          memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          tenant_id TEXT NOT NULL,
          embedding VECTOR NOT NULL,
          embedding_model TEXT NOT NULL,
          embedding_version TEXT NOT NULL DEFAULT '${DEFAULT_EMBEDDING_VERSION}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_access_log (
          id BIGSERIAL PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_memories_tenant_namespace_created ON memories (tenant_id, namespace, created_at DESC)",
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_memories_tenant_deleted ON memories (tenant_id, deleted_at)",
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_memories_metadata_gin ON memories USING gin (metadata_json)",
      );
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_memory_vectors_tenant_memory ON memory_vectors (tenant_id, memory_id)",
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      this.schemaReady = null;
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertVector(
    client: PoolClient,
    params: {
      memoryId: string;
      tenantId: string;
      embedding: number[];
    },
  ): Promise<void> {
    const result = await client.query<{ memory_id: string }>(
      `INSERT INTO memory_vectors (memory_id, tenant_id, embedding, embedding_model, embedding_version)
       VALUES ($1, $2, $3::vector, $4, $5)
       ON CONFLICT (memory_id)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         embedding = EXCLUDED.embedding,
         embedding_model = EXCLUDED.embedding_model,
         embedding_version = EXCLUDED.embedding_version,
         created_at = NOW()
       WHERE memory_vectors.tenant_id = EXCLUDED.tenant_id
       RETURNING memory_id`,
      [
        params.memoryId,
        params.tenantId,
        toPgVector(params.embedding),
        this.embeddingProvider.model,
        this.embeddingProvider.version || DEFAULT_EMBEDDING_VERSION,
      ],
    );
    if (!result.rows[0]) {
      throw new MemoryApiError(
        409,
        "id_conflict",
        "memory vector already exists in a different tenant",
      );
    }
  }

  private async logAccess(
    client: Queryable,
    params: {
      tenantId: string;
      operation: string;
      status: string;
    },
  ): Promise<void> {
    try {
      await client.query(
        `INSERT INTO memory_access_log (tenant_id, operation, request_hash, status, latency_ms)
         VALUES ($1, $2, $3, $4, 0)`,
        [
          params.tenantId,
          params.operation,
          `${params.tenantId}:${params.operation}`,
          params.status,
        ],
      );
    } catch {
      // Access logs must never fail request handling.
    }
  }
}

export function resolvePostgresMemoryStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PostgresMemoryStore | null {
  const connectionString = (env.OPENCLAW_MEMORY_SERVER_DB_URL || env.SLM_PG_URL || "").trim();
  if (!connectionString) {
    return null;
  }
  return new PostgresMemoryStore({
    connectionString,
    embeddingProvider: resolveEmbeddingProviderFromEnv(env),
  });
}

function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    namespace: row.namespace,
    kind: row.kind,
    content: row.content,
    metadata: row.metadata_json ?? undefined,
    source_ref: row.source_ref ?? undefined,
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
    deleted_at: row.deleted_at ? normalizeDate(row.deleted_at) : undefined,
  };
}

function toPgVector(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error("embedding vector cannot be empty");
  }
  return `[${embedding.join(",")}]`;
}

function normalizeDate(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}
