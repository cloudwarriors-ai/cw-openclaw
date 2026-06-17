import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { listIssuesPath, praxisGet, praxisHealth } from "./praxis-client.js";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}

const plugin = {
  id: "praxis",
  name: "Praxis",
  description:
    "Praxis issue-orchestrator support tools - diagnose stuck issues, list/inspect issues and their event trace (read-only)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Register every tool as `optional: true` so per-agent allowlists scope them:
    // a non-optional plugin tool bypasses allowlists and becomes visible to EVERY
    // agent. With this, only agents whose `tools.allow` names a tool, the plugin id
    // ("praxis"), or "group:plugins" see the Praxis tools. (Mirrors zoomwarriorssupportbot.)
    const optionalApi: OpenClawPluginApi = {
      ...api,
      registerTool: (tool, opts) => api.registerTool(tool, { ...opts, optional: true }),
    };

    // Connectivity + contract check: confirms Praxis is reachable and still speaks
    // the API version this client targets (catches cross-repo contract drift).
    optionalApi.registerTool(() => ({
      name: "praxis_health",
      description:
        "Check Praxis connectivity and API-version compatibility. Run this first if other " +
        "praxis_* tools are failing, to tell a config/auth problem apart from a real issue state.",
      parameters: Type.Object({}),
      async execute() {
        try {
          return jsonResult(await praxisHealth());
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // List issues, optionally filtered by repo and/or lifecycle state.
    optionalApi.registerTool(() => ({
      name: "praxis_list_issues",
      description:
        "List issues Praxis is tracking, newest first. Optionally filter by repo full name " +
        "(e.g. 'cloudwarriors-ai/scopely') and/or lifecycle state (e.g. 'blocked', 'needs_info', " +
        "'dispatch_requested'). Use this to find stuck issues.",
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: "Filter by repo full name" })),
        state: Type.Optional(Type.String({ description: "Filter by lifecycle state" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const path = listIssuesPath({
            repo: params.repo as string | undefined,
            state: params.state as string | undefined,
          });
          return jsonResult(await praxisGet(path));
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // Single issue: state, fuses, risk score, recent events.
    optionalApi.registerTool(() => ({
      name: "praxis_get_issue",
      description:
        "Get one Praxis issue by its Praxis id: current state, fuse counters, risk score, and its " +
        "most recent events.",
      parameters: Type.Object({
        issue_id: Type.Number({ description: "The Praxis issue id (not the GitHub issue number)" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          return jsonResult(await praxisGet(`/api/v1/issues/${params.issue_id as number}`));
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // Full append-only event trace for an issue (the audit trail).
    optionalApi.registerTool(() => ({
      name: "praxis_list_events",
      description:
        "Get the full event trace (append-only audit trail) for a Praxis issue: every state " +
        "transition with actor, from/to state, and reason. Use this to reconstruct how an issue " +
        "reached its current state.",
      parameters: Type.Object({
        issue_id: Type.Number({ description: "The Praxis issue id" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          return jsonResult(await praxisGet(`/api/v1/issues/${params.issue_id as number}/events`));
        } catch (err) {
          return errorResult(err);
        }
      },
    }));

    // Support-triage aggregation: WHY an issue is where it is (redacted server-side).
    optionalApi.registerTool(() => ({
      name: "praxis_diagnose_issue",
      description:
        "Diagnose WHY a Praxis issue is stuck: fuse counters vs their caps (at_cap = tripped to " +
        "blocked), open questions awaiting a human reply, the live resolver attempt, and any " +
        "unsettled outbox effects. This is the primary triage tool. The response is redacted by " +
        "Praxis (no raw error text or tokens).",
      parameters: Type.Object({
        issue_id: Type.Number({ description: "The Praxis issue id" }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          return jsonResult(
            await praxisGet(`/api/v1/issues/${params.issue_id as number}/diagnose`),
          );
        } catch (err) {
          return errorResult(err);
        }
      },
    }));
  },
};

export default plugin;
