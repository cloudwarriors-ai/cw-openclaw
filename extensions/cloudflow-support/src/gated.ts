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

import { getChannelThreadAnchor, sendCfText } from "./comfort.js";
import { jsonResult } from "./helpers.js";
import { makeCode, putPending } from "./pending-confirm.js";

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
  // — and test stubbing — both resolve correctly. `?? ""` + the falsy check below
  // also catch the compose-injected empty string (`VAR=${VAR}` with VAR unset).
  const channel = process.env.CF_ZOOM_CHANNEL ?? "";
  if (!channel) {
    // FAIL CLOSED. Without a channel the CONFIRM prompt would have to travel
    // inline through the model — codes get fabricated/relayed (observed live
    // on scopelybot) — and, since pending actions are channel-bound, an inline
    // staging could never be confirmed anyway. Refuse to stage instead of
    // silently degrading on a misconfigured deployment.
    return jsonResult({
      ok: false,
      error:
        "CF_ZOOM_CHANNEL is not configured — write staging is disabled (fail-closed). " +
        "Set the env var to the bot's Zoom channel JID.",
    });
  }
  // Bind the staged action to that channel: only a CONFIRM from it can fire the
  // action (takePending enforces the match). Code is unpredictable (crypto).
  const code = makeCode();
  putPending({ code, conversationId: channel, summary, run });
  const prompt =
    `⚠️ Confirm: ${summary} on PROD.\n` +
    `Reply \`CONFIRM ${code}\` within 5 minutes to proceed, or ignore to cancel.`;

  await sendCfText(channel, prompt, getChannelThreadAnchor(channel));
  return jsonResult({
    staged: true,
    awaiting_confirmation: true,
    message:
      "Confirm prompt was posted to the channel for the user. " +
      "Reply NO_REPLY — do not repeat, relay, or invent the confirmation code.",
  });
}
