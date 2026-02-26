import { Type } from "@sinclair/typebox";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const plugin = {
  id: "memory-pgvector",
  name: "Memory (PGVector)",
  description: "Routes memory search/get calls through centralized memory server",
  kind: "memory" as const,
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerTool({
      label: "Memory Search",
      name: "memory_search",
      description:
        "Search centralized memory-server records for this tenant using semantic retrieval.",
      parameters: MemorySearchSchema,
      execute: async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const maxResults = readNumberParam(params, "maxResults") ?? 5;
        const minScore = readNumberParam(params, "minScore") ?? 0;

        const response = await callMemoryServer({
          method: "POST",
          path: "/memories/search",
          body: {
            query_text: query,
            top_k: maxResults,
            min_score: minScore,
          },
        });

        if (!response.ok) {
          return jsonResult({
            results: [],
            disabled: true,
            error: response.error ?? response.payload ?? "memory search failed",
          });
        }

        const records = Array.isArray(response.records) ? response.records : [];
        const scores = Array.isArray(response.scores) ? response.scores : [];
        const results = records.map((record, index) => toMemorySearchResult(record, scores[index]));

        return jsonResult({
          results,
          provider: "memory-server",
          model: response.query_embedding_model ?? "unknown",
          fallback: undefined,
          citations: "off",
        });
      },
    });

    api.registerTool({
      label: "Memory Get",
      name: "memory_get",
      description: "Fetch one memory record by ID from centralized memory-server.",
      parameters: MemoryGetSchema,
      execute: async (_toolCallId, params) => {
        const rawPath = readStringParam(params, "path");
        const rawId = readStringParam(params, "id");
        const id = extractMemoryId(rawPath ?? rawId ?? "");
        if (!id) {
          return jsonResult({ path: rawPath ?? rawId ?? "", text: "", disabled: true, error: "memory id required" });
        }
        const response = await callMemoryServer({
          method: "GET",
          path: `/memories/${encodeURIComponent(id)}`,
        });
        if (!response.ok) {
          return jsonResult({ path: rawPath ?? id, text: "", disabled: true, error: response.error ?? response.payload });
        }
        const record = response.record;
        if (!record || typeof record !== "object" || Array.isArray(record)) {
          return jsonResult({ path: rawPath ?? id, text: "", disabled: true, error: "malformed memory record response" });
        }
        const content = typeof record.content === "string" ? record.content : "";
        return jsonResult({
          path: rawPath ?? `memory:${id}`,
          text: content,
        });
      },
    });

    api.logger.info("memory-pgvector: registered memory_search and memory_get tools");
  },
};

async function callMemoryServer(params: {
  method: "POST" | "GET";
  path: string;
  body?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const baseUrl = process.env.OPENCLAW_MEMORY_SERVER_URL?.trim();
  const token = process.env.OPENCLAW_MEMORY_SERVER_TOKEN?.trim();
  if (!baseUrl || !token) {
    return {
      ok: false,
      disabled: true,
      error: "OPENCLAW_MEMORY_SERVER_URL and OPENCLAW_MEMORY_SERVER_TOKEN are required",
    };
  }

  const endpointUrl = resolveMemoryEndpoint(baseUrl, params.path);
  const response = await fetch(endpointUrl, {
    method: params.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    payload = { ok: false, error: "invalid_json_response" };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      payload,
    };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      error: "unexpected_payload",
    };
  }

  return payload as Record<string, unknown>;
}

function resolveMemoryEndpoint(baseUrl: string, endpointPath: string): URL {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  const relativePath = endpointPath.replace(/^\/+/, "");
  return new URL(relativePath, base);
}

function toMemorySearchResult(record: unknown, score: unknown): {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory";
} {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {
      path: "memory:unknown",
      startLine: 1,
      endLine: 1,
      score: 0,
      snippet: "",
      source: "memory",
    };
  }
  const value = record as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "unknown";
  const snippet = typeof value.content === "string" ? value.content : "";
  const lines = snippet === "" ? 1 : snippet.split("\n").length;
  return {
    path: `memory:${id}`,
    startLine: 1,
    endLine: Math.max(1, lines),
    score: typeof score === "number" && Number.isFinite(score) ? score : 0,
    snippet,
    source: "memory",
  };
}

function extractMemoryId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("memory:")) {
    return trimmed.slice("memory:".length);
  }
  return trimmed;
}

export default plugin;
