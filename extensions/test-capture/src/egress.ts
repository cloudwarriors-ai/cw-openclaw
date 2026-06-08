// Egress interceptor: wraps the global `fetch` so Zoom channel-message POSTs to an
// ARMED channel JID are recorded and SUPPRESSED (synthetic 200) instead of delivered.
// Everything else — non-Zoom traffic, and Zoom messages to non-armed channels —
// passes through to the saved original fetch untouched, so production bots in other
// channels and all model/API calls behave exactly as normal.
//
// Wrapping at the `fetch` boundary (not the undici dispatcher) keeps body inspection
// trivial (the body is the JSON string the caller passed) and leaves the gateway's
// global dispatcher / proxy / timeout policy completely untouched on the passthrough
// path. All Zoom egress in this repo (core adapter + every bot's comfort.ts/zoom-dm.ts)
// uses the global `fetch`, so this single wrap covers them all.
import type { DatabaseSync } from "node:sqlite";
import { getArmed, recordOutbound } from "./store.js";

const CHANNEL_MESSAGES_PATH = "/v2/im/chat/messages";

let installed = false;

type FetchFn = typeof globalThis.fetch;

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === "object" && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

function extractText(body: Record<string, unknown>): { text: string; headText: string | null } {
  const content = (body.content ?? {}) as Record<string, unknown>;
  const head = (content.head ?? {}) as Record<string, unknown>;
  const blocks = Array.isArray(content.body) ? (content.body as Array<Record<string, unknown>>) : [];
  const text = blocks
    .map((b) => (typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
  const headText = typeof head.text === "string" ? head.text : null;
  return { text, headText };
}

/**
 * Install the fetch wrapper. Idempotent. `db` is a long-lived handle; the armed
 * capture-set is read only when a Zoom channel-message POST is seen (rare), never
 * on the hot path of ordinary fetches.
 */
export function installEgressInterceptor(db: DatabaseSync): void {
  if (installed) return;
  installed = true;
  const original: FetchFn = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    try {
      const url = urlOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const isChannelMessage =
        url.includes("api.zoom.us") && url.includes(CHANNEL_MESSAGES_PATH) && method === "POST";
      if (isChannelMessage && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const toJid = typeof body.to_jid === "string" ? body.to_jid : "";
        const { channels, runId } = getArmed(db);
        if (toJid && channels.includes(toJid)) {
          const { text, headText } = extractText(body);
          recordOutbound(db, {
            runId,
            ts: Date.now(),
            endpoint: "channel",
            toJid,
            robotJid: typeof body.robot_jid === "string" ? body.robot_jid : null,
            text,
            headText,
            replyTo: typeof body.reply_to === "string" ? body.reply_to : null,
            replyMainMessageId:
              typeof body.reply_main_message_id === "string" ? body.reply_main_message_id : null,
            rawJson: init.body,
          });
          // Synthetic success — mirrors Zoom's send response so callers proceed normally.
          const fakeId = `TESTCAP-${Math.abs((toJid + text).length * 2654435761) % 1_000_000}`;
          return new Response(JSON.stringify({ message_id: fakeId, status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
    } catch {
      // Never let capture logic break a real send — fall through to passthrough.
    }
    return original(input, init);
  }) as FetchFn;
}
