// Call context for audit rows (PK-7b-1): the requester, tool and OpenClaw ids
// of the current tool call, carried through its async work by
// AsyncLocalStorage, so every row the call writes (tool_call, http intent and
// outcome, refusals) names the same requester. Attribution here is ctx-only:
// a tool run by the coordinator itself takes its requester from the trusted
// tool-factory ctx.requesterSenderId; anything else is resolved:false. Spoke
// attribution (spawn-label stamp and cross-check) is PK-7b-2 and replaces
// requesterFromToolCtx's "missing" for spoke sessions.

import { AsyncLocalStorage } from "node:async_hooks";
import { boundedText } from "./audit-chain.js";

export type Principal = {
  resolved: boolean;
  zoom_operator_id: string | null;
  source: "ctx" | "before_dispatch" | "none";
  reason: "missing" | "announce_run" | "system" | null;
};

export const SYSTEM_PRINCIPAL: Principal = {
  resolved: false,
  zoom_operator_id: null,
  source: "none",
  reason: "system",
};

export type CallContext = {
  tool: string;
  trigger: "tool";
  requester: Principal;
  openclaw: { agent_id: string | null; session_key: string | null; tool_call_id: string | null };
  action: { tool: string; family: string | null; op_class: string; registry_status: string };
};

const calls = new AsyncLocalStorage<CallContext>();

export function currentCall(): CallContext | undefined {
  return calls.getStore();
}

export function runInCall<T>(ctx: CallContext, fn: () => T): T {
  return calls.run(ctx, fn);
}

// The coordinator's own sessions; a spawned spoke runs as agent:<id>:subagent:<uuid>.
const COORDINATOR_SESSION = /^agent:scopelybot:(?!(?:.*:)?subagent:)/;

/**
 * The requester of every call made with tools built from this factory ctx: the
 * sender of a human-triggered coordinator run; announce_run for a coordinator
 * run with no sender (announce/completion); missing for anything else (spokes
 * carry no sender, probe S0). Never the bot, never read from tool params.
 */
export function requesterFromToolCtx(
  ctx: { sessionKey?: string; requesterSenderId?: string } | undefined,
): Principal {
  const coordinator = COORDINATOR_SESSION.test(ctx?.sessionKey ?? "");
  const sender = coordinator ? ctx?.requesterSenderId?.trim() : undefined;
  if (sender) {
    return { resolved: true, zoom_operator_id: boundedText(sender), source: "ctx", reason: null };
  }
  const reason = coordinator ? "announce_run" : "missing";
  return { resolved: false, zoom_operator_id: null, source: "none", reason };
}
