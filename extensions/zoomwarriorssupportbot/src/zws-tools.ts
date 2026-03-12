import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { zwsFetch, jsonResult, errorResult } from "./zws-api.js";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";

export function registerZwsTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // zws_auth_status
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_auth_status",
        description: "Check Project Pulse authentication status for ZoomWarriors support. Returns current session info.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await zwsFetch("/api/auth/session");
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}` });
            return jsonResult({ ok: true, session: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_list_projects
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_list_projects",
        description: "List Project Pulse projects for ZoomWarriors. Supports optional query filters.",
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: "Filter by status (e.g. active, completed)" })),
          search: Type.Optional(Type.String({ description: "Search term" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["status", "search", "limit"]);
            const result = await zwsFetch(`/api/v1/projects${qs}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_get_project
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_get_project",
        description: "Get details of a specific Project Pulse project by ID for ZoomWarriors.",
        parameters: Type.Object({
          id: Type.String({ description: "Project ID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = await zwsFetch(`/api/v1/projects/${encodeURIComponent(params.id as string)}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_list_tasks
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_list_tasks",
        description: "List Project Pulse tasks for ZoomWarriors. Filter by project, status, assignee.",
        parameters: Type.Object({
          projectId: Type.Optional(Type.String({ description: "Filter by project ID" })),
          status: Type.Optional(Type.String({ description: "Filter by status" })),
          assigneeId: Type.Optional(Type.String({ description: "Filter by assignee user ID" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["projectId", "status", "assigneeId", "limit"]);
            const result = await zwsFetch(`/api/v1/tasks${qs}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_get_task
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_get_task",
        description: "Get details of a specific Project Pulse task by ID for ZoomWarriors.",
        parameters: Type.Object({
          id: Type.String({ description: "Task ID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = await zwsFetch(`/api/v1/tasks/${encodeURIComponent(params.id as string)}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_list_tickets
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_list_tickets",
        description: "List Project Pulse tickets for ZoomWarriors (bug reports, feature requests). Filter by status, priority, project.",
        parameters: Type.Object({
          projectId: Type.Optional(Type.String({ description: "Filter by project ID" })),
          status: Type.Optional(Type.String({ description: "Filter by status (open, in_progress, resolved, closed)" })),
          priority: Type.Optional(Type.String({ description: "Filter by priority (low, medium, high, critical)" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["projectId", "status", "priority", "limit"]);
            const result = await zwsFetch(`/api/v1/tickets${qs}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_create_ticket
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_create_ticket",
        description: "Create a new ticket in Project Pulse for ZoomWarriors. Requires title and project ID.",
        parameters: Type.Object({
          title: Type.String({ description: "Ticket title" }),
          description: Type.Optional(Type.String({ description: "Ticket description (markdown supported)" })),
          projectId: Type.String({ description: "Project ID to create ticket in" }),
          priority: Type.Optional(Type.String({ description: "Priority: low, medium, high, critical" })),
          assigneeId: Type.Optional(Type.String({ description: "User ID to assign" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = await zwsFetch("/api/v1/tickets", {
              method: "POST",
              body: JSON.stringify({
                title: params.title,
                description: params.description,
                projectId: params.projectId,
                priority: params.priority,
                assigneeId: params.assigneeId,
              }),
            });
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_update_ticket
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_update_ticket",
        description: "Update an existing Project Pulse ticket for ZoomWarriors.",
        parameters: Type.Object({
          id: Type.String({ description: "Ticket ID" }),
          title: Type.Optional(Type.String({ description: "New title" })),
          description: Type.Optional(Type.String({ description: "New description" })),
          status: Type.Optional(Type.String({ description: "New status" })),
          priority: Type.Optional(Type.String({ description: "New priority" })),
          assigneeId: Type.Optional(Type.String({ description: "New assignee user ID" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const { id, ...body } = params;
            const result = await zwsFetch(`/api/v1/tickets/${encodeURIComponent(id as string)}`, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_list_users
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_list_users",
        description: "List Project Pulse users for ZoomWarriors.",
        parameters: Type.Object({
          role: Type.Optional(Type.String({ description: "Filter by role" })),
          search: Type.Optional(Type.String({ description: "Search by name or email" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["role", "search"]);
            const result = await zwsFetch(`/api/v1/users${qs}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_get_timesheets
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_get_timesheets",
        description: "Get Project Pulse timesheet data for ZoomWarriors. Filter by user, project, date range.",
        parameters: Type.Object({
          userId: Type.Optional(Type.String({ description: "Filter by user ID" })),
          projectId: Type.Optional(Type.String({ description: "Filter by project ID" })),
          startDate: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD)" })),
          endDate: Type.Optional(Type.String({ description: "End date (YYYY-MM-DD)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["userId", "projectId", "startDate", "endDate"]);
            const result = await zwsFetch(`/api/v1/timesheets${qs}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_search
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_search",
        description: "Full-text search across Project Pulse for ZoomWarriors (projects, tasks, tickets, users).",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          type: Type.Optional(Type.String({ description: "Limit to type: projects, tasks, tickets, users" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const qs = buildQuery(params, ["query", "type", "limit"]);
            const result = await zwsFetch(`/api/v1/search${qs}`);
            if (!result.ok) return jsonResult({ ok: false, error: `HTTP ${result.status}`, details: result.data });
            return jsonResult({ ok: true, data: result.data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}

function buildQuery(params: Record<string, unknown>, keys: string[]): string {
  const qs = new URLSearchParams();
  for (const key of keys) {
    if (params[key] !== undefined && params[key] !== null) {
      qs.set(key, String(params[key]));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}
