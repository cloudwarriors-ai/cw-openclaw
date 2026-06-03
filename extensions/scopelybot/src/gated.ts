// Shared confirm-gate staging helper for scopelybot write tools.
//
// THE invariant: a write tool's execute() must only STAGE — it calls stageWrite()
// (which registers a pending action and returns a CONFIRM prompt) and never calls
// scopelyFetch with a mutating method directly. The real mutation lives in the `run`
// closure, fired ONLY by tryExecuteConfirm() (user-maintenance-tools.ts) when a human
// replies `CONFIRM <code>`. The LLM cannot fabricate that inbound message, so the bot
// cannot self-mutate. Each slice's test asserts scopelyFetch is not called during execute().

import { makeCode, putPending } from "./pending-confirm.js";
import { jsonResult } from "./scopely-api.js";

let codeSeed = 1;

type FetchResult = Promise<{ ok: boolean; status: number; data: unknown }>;

// Stage a gated mutation and return the confirm prompt. Does NOT execute.
export function stageWrite(summary: string, run: () => FetchResult) {
  const code = makeCode(codeSeed++ * 7919 + summary.length);
  putPending({ code, summary, run });
  return jsonResult({
    staged: true,
    message:
      `⚠️ Confirm: ${summary} on PROD.\n` +
      `Reply \`CONFIRM ${code}\` within 5 minutes to proceed, or ignore to cancel.`,
  });
}

// Build a request body from only the fields the caller actually supplied, so we
// never send undefined keys that would blank out existing values on a PATCH.
export function pickBody(
  params: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of keys) {
    if (params[k] !== undefined) {
      body[k] = params[k];
    }
  }
  return body;
}

// Human-readable "k=v, k2=v2" summary of a staged body, for the confirm prompt.
export function describeChanges(body: Record<string, unknown>): string {
  return Object.entries(body)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}
