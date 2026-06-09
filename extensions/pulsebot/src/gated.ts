// Shared confirm-gate staging helper for pulsebot write tools.
//
// THE invariant: a write tool's execute() must only STAGE — it calls stageWrite()
// (which registers a pending action and delivers the CONFIRM prompt to the channel)
// and never calls ppFetch with a mutating method directly. The real mutation lives
// in the `run` closure, fired ONLY by tryExecuteConfirm() (confirm.ts) when a human
// replies `CONFIRM <code>`. The LLM cannot fabricate that inbound message, so the bot
// cannot self-mutate. Tests assert ppFetch is not called during execute().
//
// Ported from the proven bigheadbot/scopelybot implementation (see
// docs/reference/hub-and-spoke-implementation-guide.md §7).

import { PULSEBOT_CHANNEL, getChannelThreadAnchor, sendPulseText } from "./comfort.js";
import { makeCode, putPending } from "./pending-confirm.js";
import { jsonResult } from "./pp-api.js";

type RunResult = Promise<{ ok: boolean; status: number; data: unknown }>;

// Stage a gated mutation. Does NOT execute — the real call fires only when a
// human replies `CONFIRM <code>` (consumed in the before_dispatch hook).
//
// The confirm prompt — INCLUDING the code — is delivered to the channel
// deterministically here, threaded under the originating request. The code must
// never travel back through the LLM coordinator: a small model fabricates,
// rewrites, re-relays, and duplicates codes (observed live on scopelybot). So the
// tool result the model sees is CODE-FREE; the model only learns a prompt was
// posted and must stay silent.
export async function stageWrite(summary: string, run: () => RunResult) {
  // Read the channel at call time (not module load) so env that loads after import
  // — and test stubbing — both resolve correctly. Fall back to the bot's known
  // channel constant so production NEVER drops to the inline (LLM-relayed) prompt.
  const channel = process.env.PULSEBOT_ZOOM_CHANNEL ?? PULSEBOT_CHANNEL;
  // Bind the staged action to that channel: only a CONFIRM from it can fire the
  // action (takePending enforces the match). Code is unpredictable (crypto).
  const code = makeCode();
  putPending({ code, conversationId: channel, summary, run });
  const prompt =
    `⚠️ Confirm: ${summary} on PROD.\n` +
    `Reply \`CONFIRM ${code}\` within 5 minutes to proceed, or ignore to cancel.`;

  if (channel) {
    await sendPulseText(channel, prompt, getChannelThreadAnchor(channel));
    return jsonResult({
      staged: true,
      awaiting_confirmation: true,
      message:
        "Confirm prompt was posted to the channel for the user. " +
        "Reply NO_REPLY — do not repeat, relay, or invent the confirmation code.",
    });
  }
  // No channel configured (dev/test only): fall back to returning the prompt
  // inline so the gate still works outside the live deployment.
  return jsonResult({ staged: true, message: prompt });
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
