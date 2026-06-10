import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { devtoolsFetch } from "./api-client.js";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}

export function registerTools(api: OpenClawPluginApi) {
  // Tool 1: List containers
  api.registerTool(() => ({
    name: "devtools_list_containers",
    description:
      "List all Docker containers on the server with their name, image, state, and status. " +
      "Use this to see what services are running.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const result = await devtoolsFetch("/api/v1/containers");
        if (!result.ok)
          return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
        return jsonResult({ ok: true, containers: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));

  // Tool 2: Get container logs
  api.registerTool(() => ({
    name: "devtools_get_logs",
    description:
      "Get logs from a Docker container. Returns the last N lines of logs. " +
      "Use devtools_list_containers first to find the container ID.",
    parameters: Type.Object({
      container_id: Type.String({ description: "The container ID or name" }),
      tail: Type.Optional(
        Type.Number({ description: "Number of lines to return (default 200)", default: 200 }),
      ),
      since: Type.Optional(
        Type.String({
          description:
            "Show logs since timestamp (e.g. '2024-01-01T00:00:00Z') or relative (e.g. '1h')",
        }),
      ),
      until: Type.Optional(Type.String({ description: "Show logs until timestamp" })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const containerId = params.container_id as string;
        const queryParams = new URLSearchParams();
        queryParams.set("tail", String(params.tail ?? 200));
        if (params.since) queryParams.set("since", params.since as string);
        if (params.until) queryParams.set("until", params.until as string);

        const result = await devtoolsFetch(
          `/api/v1/containers/${encodeURIComponent(containerId)}/logs?${queryParams.toString()}`,
        );
        if (!result.ok)
          return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
        return jsonResult({ ok: true, logs: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));

  // Tool 3: List files in a directory
  api.registerTool(() => ({
    name: "devtools_list_files",
    description:
      "List files and directories at a given path in the codebase. " +
      "Use this to browse the directory structure. Omit path to list the root.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Directory path to list (defaults to root)" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const path = params.path as string | undefined;
        const endpoint = path ? `/api/v1/files/${encodeURIComponent(path)}` : "/api/v1/files";
        const result = await devtoolsFetch(endpoint);
        if (!result.ok)
          return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
        return jsonResult({ ok: true, files: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));

  // Tool 4: Read a file
  api.registerTool(() => ({
    name: "devtools_read_file",
    description:
      "Read the contents of a file from the codebase. " +
      "Use devtools_list_files first to find available files.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to read" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const path = params.path as string;
        const result = await devtoolsFetch(`/api/v1/files/${encodeURIComponent(path)}`);
        if (!result.ok)
          return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
        return jsonResult({ ok: true, content: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));

  // Tool 5: List database tables
  api.registerTool(() => ({
    name: "devtools_db_tables",
    description:
      "List all tables in the public schema of the database. " +
      "Returns table names and types. Use this before querying to discover available tables.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const result = await devtoolsFetch("/api/v1/db/tables");
        if (!result.ok)
          return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
        return jsonResult({ ok: true, tables: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));

  // Tool 6: Get table schema
  api.registerTool(() => ({
    name: "devtools_db_table_schema",
    description:
      "Get the column definitions for a database table (column names, types, nullability, defaults). " +
      "Use devtools_db_tables first to find available tables.",
    parameters: Type.Object({
      table_name: Type.String({ description: "The table name to get schema for" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const tableName = params.table_name as string;
        const result = await devtoolsFetch(
          `/api/v1/db/tables/${encodeURIComponent(tableName)}/schema`,
        );
        if (!result.ok)
          return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
        return jsonResult({ ok: true, columns: result.data });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));

  // Tool 7: Run a read-only SQL query
  api.registerTool(() => ({
    name: "devtools_db_query",
    description:
      "Execute a read-only SQL query (SELECT or WITH/CTE only). " +
      "Returns up to 1000 rows. Use parameterized queries with $1, $2, etc. for user-provided values. " +
      "Use devtools_db_tables and devtools_db_table_schema first to understand the schema.",
    parameters: Type.Object({
      sql: Type.String({ description: "The SQL query to execute (SELECT or WITH only)" }),
      params: Type.Optional(
        Type.Array(Type.Unknown(), { description: "Parameterized query values ($1, $2, etc.)" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const sqlError = assertReadOnlySql((params.sql as string) ?? "");
        if (sqlError) return jsonResult({ ok: false, error: sqlError });
        const body: Record<string, unknown> = { sql: params.sql };
        if (params.params) body.params = params.params;
        const result = await devtoolsFetch("/api/v1/db/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!result.ok)
          return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
        return jsonResult({ ok: true, ...(result.data as object) });
      } catch (err) {
        return errorResult(err);
      }
    },
  }));
}

// Client-side defense-in-depth for devtools_db_query. The /db/query endpoint is
// contractually read-only (SELECT/WITH only), but the tool must not forward a
// non-read or stacked statement and rely on the backend to refuse it. Returns an
// error string when the SQL is not a single read-only statement, else undefined.
// Same guard as the per-bot devtools copies (bigheadbot/zws).
export function assertReadOnlySql(sql: string): string | undefined {
  const trimmed = sql.trim().replace(/;\s*$/, ""); // tolerate one trailing semicolon
  if (!/^(select|with)\b/i.test(trimmed)) {
    return "Only read-only SELECT or WITH queries are allowed.";
  }
  if (trimmed.includes(";")) {
    return "Stacked/multiple statements are not allowed; submit a single SELECT/WITH query.";
  }
  return undefined;
}
