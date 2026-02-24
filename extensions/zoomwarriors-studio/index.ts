import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { zw2Fetch, getZw2Base } from "../zoomwarriors/zw2-auth.js";

const ZW2_BASE = getZw2Base();

// --- Helpers ---

function absoluteUrl(path: string): string {
  if (path.startsWith("/")) return `${ZW2_BASE}${path}`;
  return path;
}

function processDict(data: any): any {
  if (typeof data !== "object" || data === null) return data;
  const result: any = Array.isArray(data) ? [] : {};
  for (const key in data) {
    let val = data[key];
    if (typeof val === "string" && (key.endsWith("_url") || key === "url")) {
      val = absoluteUrl(val);
    } else if (typeof val === "object") {
      val = processDict(val);
    }
    result[key] = val;
  }
  return result;
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(processDict(data)) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}

// --- Plugin ---

const plugin = {
  id: "zoomwarriors-studio",
  name: "ZoomWarriors Studio",
  description: "Submit, monitor, and approve ZoomWarriors Developer Studio change requests",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // ============================================================
    // SLOT MANAGEMENT (3 tools)
    // ============================================================

    // zw_studio_list_slots
    api.registerTool(() => ({
      name: "zw_studio_list_slots",
      description:
        "List preview slots and their availability. Use available_only to filter to unlocked slots.",
      parameters: Type.Object({
        available_only: Type.Optional(
          Type.Boolean({ description: "If true, only return unlocked/available slots" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const endpoint = params.available_only
            ? "/api/v1/developer-studio/slots/available/"
            : "/api/v1/developer-studio/slots/";
          const result = await zw2Fetch(endpoint, { method: "GET" });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_lock_slot
    api.registerTool(() => ({
      name: "zw_studio_lock_slot",
      description:
        "Lock a preview slot for exclusive use before submitting a developer change request.",
      parameters: Type.Object({
        slot_id: Type.Number({ description: "The slot database ID to lock" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const slotId = params.slot_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/slots/${slotId}/lock/`, {
            method: "POST",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_unlock_slot
    api.registerTool(() => ({
      name: "zw_studio_unlock_slot",
      description: "Unlock a preview slot, releasing it for other users.",
      parameters: Type.Object({
        slot_id: Type.Number({ description: "The slot database ID to unlock" }),
        force: Type.Optional(
          Type.Boolean({ description: "Force unlock even if locked by another user (admin)" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const slotId = params.slot_id as number;
          const body: Record<string, unknown> = {};
          if (params.force) body.force = true;
          const result = await zw2Fetch(`/api/v1/developer-studio/slots/${slotId}/unlock/`, {
            method: "POST",
            ...(Object.keys(body).length > 0 ? { body: JSON.stringify(body) } : {}),
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // ============================================================
    // DEVELOPER REQUESTS (4 tools)
    // ============================================================

    // zw_studio_submit_developer_request
    api.registerTool(() => ({
      name: "zw_studio_submit_developer_request",
      description:
        "Submit a full-stack developer change request. Requires a locked slot. AI agents implement the change, build Docker preview containers, and capture screenshots.",
      parameters: Type.Object({
        request_text: Type.String({
          description: "Natural-language description of the change to implement (10-2000 chars)",
        }),
        slot_id: Type.Optional(
          Type.Number({ description: "Slot database ID (must be locked by you)" }),
        ),
        mode: Type.Optional(
          Type.String({
            description: 'Request mode: "fullstack" (default) or other supported modes',
          }),
        ),
        session_id: Type.Optional(
          Type.Number({ description: "Link to an existing conversational session" }),
        ),
        screenshot_mode_override: Type.Optional(
          Type.String({ description: 'Screenshot mode: "modified", "all", or "custom"' }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const body: Record<string, unknown> = {
            request_text: params.request_text,
          };
          if (params.slot_id !== undefined) body.slot_number = params.slot_id;
          if (params.mode) body.mode = params.mode;
          if (params.session_id !== undefined) body.session_id = params.session_id;
          if (params.screenshot_mode_override)
            body.screenshot_mode_override = params.screenshot_mode_override;

          const result = await zw2Fetch("/api/v1/developer-studio/requests/", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_get_request
    api.registerTool(() => ({
      name: "zw_studio_get_request",
      description:
        "Get the current status of a developer change request including task_steps progress, preview URLs, screenshots, and files changed.",
      parameters: Type.Object({
        request_id: Type.Number({ description: "The change request ID" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const reqId = params.request_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/requests/${reqId}/`, {
            method: "GET",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_list_requests
    api.registerTool(() => ({
      name: "zw_studio_list_requests",
      description:
        "List the current user's developer change requests. Returns recent requests with their statuses.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.String({
            description:
              'Filter by status: "pending", "processing", "preview", "approved", "merged", "failed", "rejected"',
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const qs = params.status ? `?status=${params.status}` : "";
          const result = await zw2Fetch(`/api/v1/developer-studio/requests/${qs}`, {
            method: "GET",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_get_request_stats
    api.registerTool(() => ({
      name: "zw_studio_get_request_stats",
      description:
        "Get aggregate statistics for the user's developer change requests (counts by status, totals).",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await zw2Fetch("/api/v1/developer-studio/requests/stats/", {
            method: "GET",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // ============================================================
    // REQUEST ACTIONS (3 tools)
    // ============================================================

    // zw_studio_approve_request
    api.registerTool(() => ({
      name: "zw_studio_approve_request",
      description:
        "Approve a developer change request that is in 'preview' status. Creates a GitHub pull request with the changes.",
      parameters: Type.Object({
        request_id: Type.Number({ description: "The change request ID to approve" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const reqId = params.request_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/requests/${reqId}/approve/`, {
            method: "POST",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_cancel_request
    api.registerTool(() => ({
      name: "zw_studio_cancel_request",
      description: "Cancel a pending or processing developer change request.",
      parameters: Type.Object({
        request_id: Type.Number({ description: "The change request ID to cancel" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const reqId = params.request_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/requests/${reqId}/cancel/`, {
            method: "POST",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_cleanup_request
    api.registerTool(() => ({
      name: "zw_studio_cleanup_request",
      description:
        "Tear down Docker preview containers for a completed or cancelled request. Also unlocks the associated slot.",
      parameters: Type.Object({
        request_id: Type.Number({ description: "The change request ID to clean up" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const reqId = params.request_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/requests/${reqId}/cleanup/`, {
            method: "POST",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // ============================================================
    // FRONTEND / DESIGNER REQUESTS (2 tools)
    // ============================================================

    // zw_studio_submit_frontend_request
    api.registerTool(() => ({
      name: "zw_studio_submit_frontend_request",
      description:
        "Submit a frontend-only (designer mode) change request. No slot required. For CSS, layout, styling, and UI component changes.",
      parameters: Type.Object({
        request_text: Type.String({
          description: "Natural-language description of the UI change (10-2000 chars)",
        }),
        screenshot_mode_override: Type.Optional(
          Type.String({ description: 'Screenshot mode: "modified", "all", or "custom"' }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const body: Record<string, unknown> = {
            request_text: params.request_text,
          };
          if (params.screenshot_mode_override)
            body.screenshot_mode_override = params.screenshot_mode_override;

          const result = await zw2Fetch("/api/v1/frontend-studio/requests/", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_get_frontend_request
    api.registerTool(() => ({
      name: "zw_studio_get_frontend_request",
      description:
        "Get the current status of a frontend change request including task_steps, preview URL, screenshots, and files changed.",
      parameters: Type.Object({
        request_id: Type.Number({ description: "The frontend change request ID" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const reqId = params.request_id as number;
          const result = await zw2Fetch(`/api/v1/frontend-studio/requests/${reqId}/`, {
            method: "GET",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // ============================================================
    // CONVERSATIONAL REFINEMENT (4 tools)
    // ============================================================

    // zw_studio_start_session
    api.registerTool(() => ({
      name: "zw_studio_start_session",
      description:
        "Start a conversational refinement session. An AI agent will ask clarifying questions before executing the change request.",
      parameters: Type.Object({
        change_request_text: Type.Optional(
          Type.String({ description: "Initial change request description to refine" }),
        ),
        change_request_id: Type.Optional(
          Type.Number({ description: "Existing change request ID to refine" }),
        ),
        slot_id: Type.Optional(
          Type.Number({ description: "Slot ID to associate with this session" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const body: Record<string, unknown> = {};
          if (params.change_request_text) body.change_request_text = params.change_request_text;
          if (params.change_request_id !== undefined)
            body.change_request_id = params.change_request_id;
          if (params.slot_id !== undefined) body.slot_id = params.slot_id;

          const result = await zw2Fetch("/api/v1/developer-studio/sessions/start-conversational/", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_session_chat
    api.registerTool(() => ({
      name: "zw_studio_session_chat",
      description:
        "Send a message in a conversational refinement session. The AI agent will respond with follow-up questions or confirm readiness.",
      parameters: Type.Object({
        session_id: Type.Number({ description: "The session ID" }),
        content: Type.String({ description: "Message content to send" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const sessionId = params.session_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/sessions/${sessionId}/chat/`, {
            method: "POST",
            body: JSON.stringify({ content: params.content }),
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_session_proceed
    api.registerTool(() => ({
      name: "zw_studio_session_proceed",
      description:
        "Execute the refined change request from a conversational session. Only call when the session's is_ready_to_execute is true.",
      parameters: Type.Object({
        session_id: Type.Number({ description: "The session ID to proceed with" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const sessionId = params.session_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/sessions/${sessionId}/proceed/`, {
            method: "POST",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // zw_studio_get_session
    api.registerTool(() => ({
      name: "zw_studio_get_session",
      description:
        "Get a conversational session with its full message history, status, and is_ready_to_execute flag.",
      parameters: Type.Object({
        session_id: Type.Number({ description: "The session ID" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const sessionId = params.session_id as number;
          const result = await zw2Fetch(`/api/v1/developer-studio/sessions/${sessionId}/`, {
            method: "GET",
          });
          return jsonResult({ ok: result.ok, status: result.status, data: result.data });
        } catch (err) {
          return errorResult(err);
        }
      },
    }));
  },
};

export default plugin;
