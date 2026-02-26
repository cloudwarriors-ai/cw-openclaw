import { randomUUID } from "node:crypto";
import * as z from "zod";
import { resolveAuthContext, type MemoryAuthResolver } from "./auth.js";
import { MemoryApiError, isMemoryApiError } from "./errors.js";
import { InMemoryMemoryStore, type MemoryStore } from "./store.js";
import {
  bulkCreateSchema,
  listRequestSchema,
  memoryCreateSchema,
  memoryUpsertSchema,
  searchRequestSchema,
  timelineRequestSchema,
} from "./types.js";

export type MemoryHttpRequest = {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
};

export type MemoryHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type MemoryServer = {
  handle: (request: MemoryHttpRequest) => Promise<MemoryHttpResponse>;
};

export function createMemoryServer(params: {
  authResolver: MemoryAuthResolver;
  store?: MemoryStore;
}): MemoryServer {
  const store = params.store ?? new InMemoryMemoryStore();

  return {
    async handle(request) {
      const traceId = randomUUID();
      try {
        const method = request.method.toUpperCase();
        const target = parseRequestTarget(request.path);
        const path = normalizePath(target.pathname);
        const canonicalPath = canonicalizePath(path);
        const auth = resolveAuthContext(
          {
            authorization: request.headers?.authorization,
            xMemoryApiKey: request.headers?.["x-memory-api-key"],
          },
          params.authResolver,
        );

        if (method === "POST" && canonicalPath === "/memories") {
          const payload = memoryCreateSchema.parse(request.body ?? {});
          const record = await store.create(auth.tenantId, payload);
          return ok(201, traceId, { record });
        }

        if (method === "POST" && canonicalPath === "/memories/bulk") {
          const payload = bulkCreateSchema.parse(request.body ?? {});
          const records = await store.bulkCreate(auth.tenantId, payload.records);
          return ok(201, traceId, { records });
        }

        if (method === "POST" && canonicalPath === "/memories/upsert") {
          const payload = memoryUpsertSchema.parse(request.body ?? {});
          const record = await store.upsert(auth.tenantId, payload);
          return ok(200, traceId, { record });
        }

        if (method === "POST" && canonicalPath === "/memories/list") {
          const payload = listRequestSchema.parse(request.body ?? {});
          const output = await store.list(auth.tenantId, payload);
          return ok(200, traceId, {
            records: output.records,
            next_cursor: output.nextCursor,
          });
        }

        if (method === "POST" && canonicalPath === "/memories/search") {
          const payload = searchRequestSchema.parse(request.body ?? {});
          const hits = await store.search(auth.tenantId, payload);
          const queryEmbeddingModel = payload.embedding_model ?? store.queryEmbeddingModel;
          const queryEmbeddingVersion = payload.embedding_version ?? store.queryEmbeddingVersion;
          return ok(200, traceId, {
            records: hits.map((hit) => hit.record),
            scores: hits.map((hit) => hit.score),
            query_embedding_model: queryEmbeddingModel,
            query_embedding_version: queryEmbeddingVersion,
          });
        }

        if (method === "POST" && canonicalPath === "/memories/migrate/file-core") {
          if (!auth.isAdmin) {
            throw new MemoryApiError(403, "forbidden", "admin role required");
          }
          const payload = bulkCreateSchema.parse(request.body ?? {});
          const records = await store.bulkCreate(auth.tenantId, payload.records);
          return ok(201, traceId, { migrated_from: "file-core", records });
        }

        if (method === "GET" && canonicalPath === "/memories/timeline") {
          const payload = timelineRequestSchema.parse(parseTimelineQuery(target.searchParams));
          const records = await store.timeline(auth.tenantId, payload);
          return ok(200, traceId, { records });
        }

        const memoryId = parseMemoryId(canonicalPath);
        if (memoryId && method === "GET") {
          const includeDeleted = readBooleanQuery(
            target.searchParams.get("include_deleted"),
            false,
          );
          const record = await store.get(auth.tenantId, memoryId, {
            includeDeleted,
          });
          if (!record) {
            throw new MemoryApiError(404, "not_found", "memory not found");
          }
          return ok(200, traceId, { record });
        }

        if (memoryId && method === "PUT") {
          const payload = memoryCreateSchema.parse(request.body ?? {});
          const record = await store.upsert(auth.tenantId, {
            ...payload,
            id: memoryId,
          });
          return ok(200, traceId, { record });
        }

        if (memoryId && method === "DELETE") {
          const deleted = await store.delete(auth.tenantId, memoryId);
          if (!deleted) {
            throw new MemoryApiError(404, "not_found", "memory not found");
          }
          return ok(200, traceId, { deleted: true });
        }

        throw new MemoryApiError(404, "not_found", "route not found");
      } catch (err) {
        return fail(traceId, err);
      }
    },
  };
}

function parseRequestTarget(pathInput: string): URL {
  if (!pathInput) {
    return new URL("/", "http://localhost");
  }
  return new URL(pathInput, "http://localhost");
}

function normalizePath(pathInput: string): string {
  if (!pathInput) {
    return "/";
  }
  const normalized = pathInput.replace(/\/+$/, "");
  return normalized || "/";
}

function parseMemoryId(pathname: string): string | null {
  if (!pathname.startsWith("/memories/")) {
    return null;
  }
  const candidate = pathname.slice("/memories/".length);
  if (!candidate || candidate.includes("/")) {
    return null;
  }
  if (
    candidate === "search" ||
    candidate === "list" ||
    candidate === "bulk" ||
    candidate === "upsert" ||
    candidate === "timeline"
  ) {
    return null;
  }
  return candidate;
}

function canonicalizePath(pathname: string): string {
  if (pathname === "/memory") {
    return "/memories";
  }
  if (pathname.startsWith("/memory/")) {
    return `/memories/${pathname.slice("/memory/".length)}`;
  }
  return pathname;
}

function parseTimelineQuery(query: URLSearchParams): Record<string, unknown> {
  return {
    namespace: emptyToUndefined(query.get("namespace")),
    kind: emptyToUndefined(query.get("kind")),
    from: emptyToUndefined(query.get("from")),
    to: emptyToUndefined(query.get("to")),
    include_deleted: readBooleanQuery(query.get("include_deleted"), false),
    limit: readPositiveInt(query.get("limit"), 100),
  };
}

function readBooleanQuery(raw: string | null, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function readPositiveInt(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function emptyToUndefined(raw: string | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function ok(status: number, traceId: string, payload: Record<string, unknown>): MemoryHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: {
      ok: true,
      trace_id: traceId,
      ...payload,
    },
  };
}

function fail(traceId: string, error: unknown): MemoryHttpResponse {
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        ok: false,
        trace_id: traceId,
        error: {
          code: "validation_error",
          message: error.issues.map(
            (issue) => `${issue.path.join(".") || "body"}: ${issue.message}`,
          ),
        },
      },
    };
  }

  if (isMemoryApiError(error)) {
    return {
      status: error.status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {
        ok: false,
        trace_id: traceId,
        error: {
          code: error.code,
          message: error.message,
        },
      },
    };
  }

  return {
    status: 500,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: {
      ok: false,
      trace_id: traceId,
      error: {
        code: "internal_error",
        message: String(error),
      },
    },
  };
}
