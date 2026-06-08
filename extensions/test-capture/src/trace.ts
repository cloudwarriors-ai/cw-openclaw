// Routing/tool trace for hub-and-spoke assertions. before_tool_call fires for EVERY
// tool call across the coordinator AND every spawned spoke (hooks are process-global),
// carrying agentId / runId / channelId via the tool context — so the trace shows which
// spoke the coordinator routed to (sessions_spawn → params.agentId) and which domain
// tools each spoke then called. agent_end marks turn boundaries (completion signal).
//
// Recording is gated on an active armed run, so nothing is written during normal
// operation. Hooks are observe-only (return void) and wrapped so a store error can
// never block or alter a real tool call.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { DatabaseSync } from "node:sqlite";
import { getArmed, recordTrace } from "./store.js";

export function registerTraceHooks(api: OpenClawPluginApi, db: DatabaseSync): void {
  api.on("before_tool_call", (event, ctx) => {
    try {
      const { runId } = getArmed(db);
      if (!runId) return; // only record during an armed test run
      const params = (event?.params ?? {}) as Record<string, unknown>;
      const toolName = typeof event?.toolName === "string" ? event.toolName : null;
      const targetAgentId =
        toolName === "sessions_spawn" && typeof params.agentId === "string"
          ? params.agentId
          : null;
      recordTrace(db, {
        runId, // the armed test-run id, so outbound + trace share one correlation id
        ts: Date.now(),
        kind: "tool_call",
        agentId: ctx?.agentId ?? null,
        channelId: ctx?.channelId ?? null,
        sessionKey: ctx?.sessionKey ?? null,
        toolName,
        targetAgentId,
        paramsJson: safeJson(params),
      });
    } catch {
      /* never break a real tool call */
    }
  });

  api.on("agent_end", (_event, ctx) => {
    try {
      const { runId } = getArmed(db);
      if (!runId) return;
      recordTrace(db, {
        runId, // armed test-run id (see tool_call note)
        ts: Date.now(),
        kind: "agent_end",
        agentId: ctx?.agentId ?? null,
        channelId: ctx?.channelId ?? null,
        sessionKey: ctx?.sessionKey ?? null,
        toolName: null,
        targetAgentId: null,
        paramsJson: null,
      });
    } catch {
      /* observe-only */
    }
  });
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
