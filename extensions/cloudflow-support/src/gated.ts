// Shared confirm-gate staging helper for cloudflow-support write tools.
//
// THE invariant: a write tool's execute() must only STAGE — it calls stageWrite()
// (which registers a pending action and delivers the CONFIRM prompt to the channel)
// and never performs the mutation directly. The real mutation lives in the `run`
// closure, fired ONLY by tryExecuteConfirm() (confirm.ts) when a human replies
// `CONFIRM <code>`. The LLM cannot fabricate that inbound message, so the bot cannot
// self-mutate. Tests assert no mutation fires during execute().
//
// Ported from the proven bigheadbot/scopelybot implementation (see
// docs/reference/hub-and-spoke-implementation-guide.md §7).

import { CF_CHANNEL, getChannelThreadAnchor, sendCfText } from "./comfort.js";
import { jsonResult } from "./helpers.js";
import { makeCode, putPending } from "./pending-confirm.js";

let codeSeed = 1;

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
  const code = makeCode(codeSeed++ * 7919 + summary.length);
  putPending({ code, summary, run });
  const prompt =
    `⚠️ Confirm: ${summary} on PROD.\n` +
    `Reply \`CONFIRM ${code}\` within 5 minutes to proceed, or ignore to cancel.`;

  // Read the channel at call time (not module load) so env that loads after import
  // — and test stubbing — both resolve correctly. Fall back to the bot's known
  // channel constant so production NEVER drops to the inline (LLM-relayed) prompt.
  const channel = process.env.CF_ZOOM_CHANNEL ?? CF_CHANNEL;
  if (channel) {
    await sendCfText(channel, prompt, getChannelThreadAnchor(channel));
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
