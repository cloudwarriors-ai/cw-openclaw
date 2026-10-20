// Shared confirm-gate staging helper for scopelybot write tools.
//
// THE invariant: a write tool's execute() must only STAGE — it calls stageWrite()
// (which registers a pending action and delivers the CONFIRM prompt to the channel)
// and never calls scopelyFetch with a mutating method directly. The real mutation
// lives in the `run` closure, fired ONLY by tryExecuteConfirm() (confirm.ts)
// when a human replies `CONFIRM <code>`. The LLM cannot fabricate that inbound message,
// so the bot cannot self-mutate. Tests assert scopelyFetch is not called during execute().

import { createHash } from "node:crypto";
import { readBackendProfile } from "./backend-profile.js";
import { capabilityRefusal, currentToolName } from "./capability-registry.js";
import { getChannelThreadAnchor, sendScopelyText } from "./comfort.js";
import { formatBackendErrorDetail } from "./confirm.js";
import { formatNativePreview } from "./confirmation-preview.js";
import { nativeWriteScope } from "./ops-write-policy.js";
import { makeCode, putPending, takePending } from "./pending-confirm.js";
import { redactText } from "./redaction.js";
import { jsonResult } from "./scopely-api.js";
import { makeShortCode } from "./short-confirm-code.js";

type FetchResult = Promise<{ ok: boolean; status: number; data: unknown }>;

// One staged mutation awaiting flush into a confirm prompt.
type StagedItem = {
  summary: string;
  backendAction?: { pending_action_id: string; preview_sha256: string };
  displaySummary?: string;
  run: (ctx?: { actor?: string }) => FetchResult;
};

// Per-item outcome of a confirmed bundle, surfaced back to the human so partial
// application is never silent (deletes/updates over HTTP are not transactional).
// `detail` carries the backend's redacted error message on failure so the
// human sees WHY (e.g. a validation message), not just a status code.
export type BundleItemResult = { summary: string; ok: boolean; status: number; detail?: string };

// Open coalescing bundles, keyed by channel. A bundle collects every stageWrite
// issued within the debounce window (one agent turn typically stages its writes
// in a single parallel burst — observed live 2026-07-20: "Make Ring Central like
// 8x8" staged 6 mutations within 52ms, producing SIX prompts and SIX codes; the
// human then had no single thing to approve). Flushing posts ONE prompt with ONE
// code covering every item.
const bundles = new Map<string, { items: StagedItem[]; timer: ReturnType<typeof setTimeout> }>();

// Debounce window for coalescing staged writes into one confirm prompt.
// Unset/0 (default) = legacy behavior: each stageWrite posts its own prompt
// inline. >0 enables bundling — opt-in via prod config so the rollout is an
// explicit, reversible env change, not a silent behavior shift.
function bundleWindowMs(): number {
  const raw = Number(process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(raw, 10_000);
}

// Compose the confirm prompt. Single item keeps the exact legacy wording;
// multiple items render a numbered list so the approver sees the COMPLETE set
// of intended changes behind the one code (John Rudolph's 2026-07-20 ask:
// "one message to confirm all intentions not broke apart").
function buildPrompt(items: StagedItem[], code: string, target = "PROD"): string {
  if (items.length === 1) {
    return (
      `⚠️ Confirm: ${items[0].displaySummary ? `change on ${target}.\n${items[0].displaySummary}` : `${items[0].summary} on ${target}.`}\n` +
      `Reply \`CONFIRM ${code}\` within 5 minutes to proceed, or ignore to cancel.`
    );
  }
  const lines = items.map((it, i) => `${i + 1}. ${it.summary}`).join("\n");
  return (
    `⚠️ Confirm ${items.length} changes on ${target}:\n${lines}\n` +
    `Reply \`CONFIRM ${code}\` within 5 minutes to apply ALL ${items.length}, or ignore to cancel.`
  );
}

// Register the pending action for a flushed bundle and post its prompt.
// Legacy codes are visible before send. Native codes become usable only after
// strict delivery acknowledgement and the captured admission scope recheck.
async function flushItems(
  channel: string,
  items: StagedItem[],
  target = "PROD",
  nativeScope?: string,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  if (nativeScope !== undefined) {
    // Refuse a known-invalid display before reserving a permanent short name.
    // Keep the actual-prompt check too; placeholder validation is not approval.
    const candidate = buildPrompt(items, "22222222", target);
    if (candidate.length > 2300 || redactText(candidate, 2300) !== candidate) {
      throw new Error("The complete native preview cannot be displayed safely.");
    }
  }
  const code = nativeScope === undefined ? makeCode() : makeShortCode();
  let pending: Parameters<typeof putPending>[0];
  if (items.length === 1) {
    // Legacy pending shape — confirm.ts renders `✅ Done: <summary>.` unchanged.
    pending = {
      code,
      conversationId: channel,
      summary: items[0].summary,
      ...(items[0].backendAction ? { backendAction: items[0].backendAction } : {}),
      ...(items[0].displaySummary === undefined ? {} : { displaySummary: items[0].displaySummary }),
      run: items[0].run,
    };
  } else {
    const summary = redactText(
      `${items.length} changes: ${items.map((it) => it.summary).join("; ")}`,
      500,
    );
    // Composite run: sequential, CONTINUE on failure (HTTP ops are not
    // transactional — stopping midway hides which items already applied), and
    // report per-item outcomes so the human sees exactly what changed.
    const run = async (ctx?: { actor?: string }) => {
      const results: BundleItemResult[] = [];
      for (const it of items) {
        try {
          const res = await it.run(ctx);
          // 4xx only — same boundary as confirm.ts (5xx bodies stay hidden).
          const detail =
            !res.ok && res.status >= 400 && res.status < 500
              ? formatBackendErrorDetail(res.data)
              : "";
          results.push({
            summary: it.summary,
            ok: res.ok,
            status: res.status,
            ...(detail ? { detail } : {}),
          });
        } catch {
          results.push({ summary: it.summary, ok: false, status: 0 });
        }
      }
      const failed = results.filter((r) => !r.ok);
      return {
        ok: failed.length === 0,
        status: failed.length === 0 ? 200 : failed[0].status,
        data: { bundle: true, applied: results.length - failed.length, results },
      };
    };
    pending = { code, conversationId: channel, summary, run };
  }
  const prompt = buildPrompt(items, nativeScope === undefined ? code : code.toUpperCase(), target);
  if (nativeScope !== undefined && (prompt.length > 2300 || redactText(prompt, 2300) !== prompt)) {
    throw new Error("The complete native preview cannot be displayed safely.");
  }
  if (nativeScope === undefined) {
    putPending(pending);
  }
  try {
    await sendScopelyText(
      channel,
      prompt,
      getChannelThreadAnchor(channel),
      nativeScope !== undefined || target !== "PROD",
    );
    if (
      nativeScope !== undefined &&
      nativeWriteScope(readBackendProfile(), process.env.SCOPELYBOT_ZOOM_CHANNEL) !== nativeScope
    ) {
      throw new Error("Admission changed during confirmation delivery.");
    }
    if (nativeScope !== undefined) {
      putPending(pending);
    }
  } catch (error) {
    // Invalidate an ambiguously delivered prompt; never retry its send.
    takePending(code, { conversationId: channel });
    throw error;
  }
}

// Timer-driven flush for an open bundle. Errors must not become unhandled
// rejections (the staging tool already returned); a failed prompt post is
// fail-safe — the pending simply expires unconfirmable in 5 minutes.
function flushBundle(channel: string): void {
  const b = bundles.get(channel);
  if (!b) {
    return;
  }
  bundles.delete(channel);
  void flushItems(channel, b.items).catch((err: unknown) => {
    console.error(`[scopelybot] confirm-prompt post failed for ${channel}:`, err);
  });
}

// Stage a gated mutation. Does NOT execute — the real call fires only when a
// human replies `CONFIRM <code>` (consumed in the before_dispatch hook).
//
// The confirm prompt — INCLUDING the code — is delivered to the channel
// deterministically here, threaded under the originating request. The code must
// never travel back through the LLM coordinator: a small model fabricates,
// rewrites, re-relays, and duplicates codes (observed live 2026-06-05). So the
// tool result the model sees is CODE-FREE; the model only learns a prompt was
// posted and must stay silent.
//
// With SCOPELYBOT_CONFIRM_BUNDLE_MS > 0, staged writes issued within the window
// coalesce into ONE prompt with ONE code (see bundles above); otherwise each
// stage posts its own prompt inline, exactly as before.
//
// `run` receives the confirming actor's id at execution time; actions that record
// who approved them (approver grants) use it, staged API calls ignore it.
export async function stageWrite(
  summary: string,
  run: (ctx?: { actor?: string }) => FetchResult,
  localBackend: boolean | { scope: string; pendingActionId?: string } = false,
) {
  // READ-ONLY REFUSAL (INV-2/INV-8): unless the live backend profile says
  // read-write, refuse BEFORE a code is minted, a pending action stored or a
  // CONFIRM prompt posted — a prompt for a write that can never run would
  // invite a human to approve nothing. The refusal names the calling tool's
  // family link (set by the capability-registry wrapper).
  if (readBackendProfile().mode !== "read-write") {
    return capabilityRefusal(currentToolName() ?? "", "blocked_read_only");
  }
  // Read the channel at call time (not module load) so env that loads after import
  // — and test stubbing — both resolve correctly.
  const channel = process.env.SCOPELYBOT_ZOOM_CHANNEL ?? "";
  if (!channel) {
    // FAIL CLOSED. Without a channel the CONFIRM prompt would have to travel
    // inline through the model — codes get fabricated/relayed (observed live
    // 2026-06-05) — and, since pending actions are channel-bound, an inline
    // staging could never be confirmed anyway. Refuse to stage instead of
    // silently degrading on a misconfigured deployment.
    return jsonResult({
      ok: false,
      error:
        "SCOPELYBOT_ZOOM_CHANNEL is not configured — write staging is disabled (fail-closed). " +
        "Set the env var to the bot's Zoom channel JID.",
    });
  }
  if (localBackend) {
    const profile = readBackendProfile();
    const scope = nativeWriteScope(profile, channel);
    const expectedScope = typeof localBackend === "object" ? localBackend.scope : scope;
    // The exact frozen preview must fit and survive redaction unchanged. Never
    // approve a shortened description or combine independent backend claims.
    if (
      !scope ||
      scope !== expectedScope ||
      (localBackend === true && profile.env !== "local") ||
      summary.length > 2000 ||
      redactText(summary, 2000) !== summary
    ) {
      return jsonResult({
        ok: false,
        error: "The exact native preview cannot be displayed safely.",
      });
    }
    let displaySummary: string;
    try {
      displaySummary = formatNativePreview(summary);
      if (displaySummary.length > 2000 || redactText(displaySummary, 2000) !== displaySummary) {
        throw new Error("Unsafe native display");
      }
    } catch {
      return jsonResult({
        ok: false,
        error: "The exact native preview cannot be displayed safely.",
      });
    }
    await flushItems(
      channel,
      [
        {
          summary,
          displaySummary,
          run,
          ...(typeof localBackend === "object" && localBackend.pendingActionId
            ? {
                backendAction: {
                  pending_action_id: localBackend.pendingActionId,
                  preview_sha256: createHash("sha256").update(summary).digest("hex"),
                },
              }
            : {}),
        },
      ],
      profile.env === "prod"
        ? "PRODUCTION"
        : profile.env === "dev"
          ? "VIP NOOB DEVELOPMENT"
          : "LOCAL SYNTHETIC DATA",
      scope,
    );
    return jsonResult({
      staged: true,
      awaiting_confirmation: true,
      message: "Confirm prompt posted. Reply NO_REPLY; do not relay the code.",
    });
  }
  const safeSummary = redactText(summary, 500);
  const windowMs = bundleWindowMs();
  if (windowMs === 0) {
    // Legacy path: bind, prompt, and return inline — one prompt per staged write.
    await flushItems(channel, [{ summary: safeSummary, run }]);
  } else {
    const existing = bundles.get(channel);
    if (existing) {
      // Extend the open bundle and push the flush out — a parallel tool burst
      // lands within milliseconds, so the reset converges quickly.
      existing.items.push({ summary: safeSummary, run });
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => flushBundle(channel), windowMs);
    } else {
      bundles.set(channel, {
        items: [{ summary: safeSummary, run }],
        timer: setTimeout(() => flushBundle(channel), windowMs),
      });
    }
  }
  return jsonResult({
    staged: true,
    awaiting_confirmation: true,
    message:
      "Confirm prompt was posted to the channel for the user. " +
      "Reply NO_REPLY — do not repeat, relay, or invent the confirmation code.",
  });
}

// Test hook: deterministically flush any open bundle without waiting for the
// debounce timer. Returns after the prompt post settles. Throws outside a
// Vitest worker (like the other test hooks); the AST closure scan forbids
// production calls.
export async function flushStagedBundlesForTest(): Promise<void> {
  if (!process.env.VITEST) {
    throw new Error("flushStagedBundlesForTest is test-only");
  }
  // Snapshot: a send may await while another turn stages a new bundle.
  // eslint-disable-next-line unicorn/no-useless-spread
  for (const [channel, b] of [...bundles]) {
    bundles.delete(channel);
    clearTimeout(b.timer);
    await flushItems(channel, b.items);
  }
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
