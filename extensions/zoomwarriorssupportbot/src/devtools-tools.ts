import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";

const DEVTOOLS_BASE = () => process.env.ZWS_DEVTOOLS_API_URL ?? process.env.BIGHEAD_DEVTOOLS_API_URL ?? "http://bighead-devtools-api:9100";
const DEVTOOLS_TOKEN = () => process.env.ZWS_DEV_TOOLS_API ?? process.env.BIGHEAD_DEV_TOOLS_API ?? process.env.DEV_TOOLS_API ?? "";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }] };
}

async function zwsDevtoolsFetch(
  endpoint: string,
  options?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const token = DEVTOOLS_TOKEN();
  if (!token) {
    return { ok: false, status: 0, data: { error: "ZWS_DEV_TOOLS_API env var not set" } };
  }

  const resp = await fetch(`${DEVTOOLS_BASE()}${endpoint}`, {
    ...options,
    headers: {
      ...options?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  const data = resp.headers.get("content-type")?.includes("application/json")
    ? await resp.json()
    : await resp.text();

  return { ok: resp.ok, status: resp.status, data };
}

export function registerDevtoolsTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // zws_devtools_list_containers
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_devtools_list_containers",
        description: "List all Docker containers on the ZoomWarriors server with their name, image, state, and status.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await zwsDevtoolsFetch("/api/v1/containers");
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, containers: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_devtools_get_logs
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_devtools_get_logs",
        description: "Get logs from a Docker container on the ZoomWarriors server. Returns the last N lines of logs.",
        parameters: Type.Object({
          container_id: Type.String({ description: "The container ID or name" }),
          tail: Type.Optional(Type.Number({ description: "Number of lines to return (default 200)", default: 200 })),
          since: Type.Optional(Type.String({ description: "Show logs since timestamp (e.g. '2024-01-01T00:00:00Z') or relative (e.g. '1h')" })),
          until: Type.Optional(Type.String({ description: "Show logs until timestamp" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const containerId = params.container_id as string;
            const queryParams = new URLSearchParams();
            queryParams.set("tail", String(params.tail ?? 200));
            if (params.since) queryParams.set("since", params.since as string);
            if (params.until) queryParams.set("until", params.until as string);
            const result = await zwsDevtoolsFetch(
              `/api/v1/containers/${encodeURIComponent(containerId)}/logs?${queryParams.toString()}`,
            );
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, logs: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_devtools_list_files
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_devtools_list_files",
        description: "List files and directories at a given path in the ZoomWarriors codebase.",
        parameters: Type.Object({
          path: Type.Optional(Type.String({ description: "Directory path to list (defaults to root)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const path = params.path as string | undefined;
            const endpoint = path ? `/api/v1/files/${encodeURIComponent(path)}` : "/api/v1/files";
            const result = await zwsDevtoolsFetch(endpoint);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, files: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_devtools_read_file
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_devtools_read_file",
        description: "Read the contents of a file from the ZoomWarriors codebase.",
        parameters: Type.Object({
          path: Type.String({ description: "File path to read" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const path = params.path as string;
            const result = await zwsDevtoolsFetch(`/api/v1/files/${encodeURIComponent(path)}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, content: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_devtools_db_tables
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_devtools_db_tables",
        description: "List all tables in the public schema of the ZoomWarriors database.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await zwsDevtoolsFetch("/api/v1/db/tables");
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, tables: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_devtools_db_table_schema
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_devtools_db_table_schema",
        description: "Get the column definitions for a ZoomWarriors database table.",
        parameters: Type.Object({
          table_name: Type.String({ description: "The table name to get schema for" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const tableName = params.table_name as string;
            const result = await zwsDevtoolsFetch(`/api/v1/db/tables/${encodeURIComponent(tableName)}/schema`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, columns: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_devtools_db_query
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_devtools_db_query",
        description: "Execute a read-only SQL query (SELECT or WITH only) against the ZoomWarriors database. Returns up to 1000 rows.",
        parameters: Type.Object({
          sql: Type.String({ description: "The SQL query to execute (SELECT or WITH only)" }),
          params: Type.Optional(Type.Array(Type.Unknown(), { description: "Parameterized query values ($1, $2, etc.)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const body: Record<string, unknown> = { sql: params.sql };
            if (params.params) body.params = params.params;
            const result = await zwsDevtoolsFetch("/api/v1/db/query", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, ...result.data as object });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
