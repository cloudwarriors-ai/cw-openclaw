// The EOA Zoom channel JID. Exported so the confirm gate (gated.ts) can deliver
// the CONFIRM prompt to the same channel deterministically when the
// EOA_ZOOM_CHANNEL env override is not set — the code must never fall back to an
// inline (LLM-relayed) prompt in production.
export const EOA_CHANNEL = "2edb7334f4d6497997dfed97c42dc862@conference.xmpp.zoom.us";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const clientId = process.env.ZOOM_CLIENT_ID ?? "";
  const clientSecret = process.env.ZOOM_CLIENT_SECRET ?? "";
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch("https://zoom.us/oauth/token?grant_type=client_credentials", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!resp.ok) throw new Error(`Zoom token failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

const COMFORT_MESSAGES = [
  "On it — pulling up the details now...",
  "Looking into that, one moment...",
  "Checking the autopilot state, hang tight...",
  "Gathering the info now...",
  "Let me dig into that...",
];

export async function sendComfortMessage(
  channelJid: string,
  replyToMessageId?: string,
): Promise<void> {
  if (channelJid !== EOA_CHANNEL) return;

  const botJid = process.env.ZOOM_BOT_JID ?? "";
  const accountId = process.env.ZOOM_ACCOUNT_ID ?? "";
  if (!botJid || !accountId) return;

  const text = COMFORT_MESSAGES[Math.floor(Math.random() * COMFORT_MESSAGES.length)];
  const normalizedReplyTo =
    typeof replyToMessageId === "string" && replyToMessageId.trim().length > 0
      ? replyToMessageId.trim()
      : undefined;

  try {
    const token = await getToken();
    const body: Record<string, unknown> = {
      robot_jid: botJid,
      to_jid: channelJid,
      account_id: accountId,
      content: {
        head: { text: "EOAutopilot" },
        body: [{ type: "message", text }],
      },
    };
    if (normalizedReplyTo) {
      body.reply_to = normalizedReplyTo;
      body.reply_main_message_id = normalizedReplyTo;
    }
    await fetch("https://api.zoom.us/v2/im/chat/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[eoa] comfort message failed:", err);
  }
}

// Generic text send to an EOA Zoom channel (reuses the bot token). Used by the
// confirm gate to deterministically post the CONFIRM prompt (with the code).
// Pass replyToMessageId to thread the message under the originating request.
export async function sendEoaText(
  channelJid: string,
  text: string,
  replyToMessageId?: string,
): Promise<void> {
  const botJid = process.env.ZOOM_BOT_JID ?? "";
  const accountId = process.env.ZOOM_ACCOUNT_ID ?? "";
  if (!channelJid || !botJid || !accountId) return;
  const replyTo =
    typeof replyToMessageId === "string" && replyToMessageId.trim().length > 0
      ? replyToMessageId.trim()
      : undefined;
  try {
    const token = await getToken();
    const body: Record<string, unknown> = {
      robot_jid: botJid,
      to_jid: channelJid,
      account_id: accountId,
      content: { head: { text: "EOAutopilot" }, body: [{ type: "message", text }] },
    };
    if (replyTo) {
      body.reply_to = replyTo;
      body.reply_main_message_id = replyTo;
    }
    await fetch("https://api.zoom.us/v2/im/chat/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[eoa] sendEoaText failed:", err);
  }
}

// Per-channel thread anchor for confirm-prompt delivery. The confirm gate stages
// inside the write tool, decoupled from the inbound message event, so it has no
// direct handle on the originating message id. The message_received hook stashes
// the latest inbound message id here (keyed by channel JID); stageWrite() reads it
// to thread the deterministic CONFIRM prompt under the user's request instead of
// posting it at channel root. In-memory, TTL-bounded; lost on restart is fine —
// a missing anchor only degrades to a root-level (still deterministic) prompt.
type ThreadAnchor = { messageId: string; expiresAt: number };
const ANCHOR_TTL_MS = 6 * 60 * 60 * 1000; // 6h, matches the zoom reply-root TTL
const threadAnchors = new Map<string, ThreadAnchor>();

export function rememberChannelThreadAnchor(channelJid: string, messageId?: string): void {
  if (!channelJid || !messageId) return;
  threadAnchors.set(channelJid, { messageId, expiresAt: Date.now() + ANCHOR_TTL_MS });
}

export function getChannelThreadAnchor(channelJid: string): string | undefined {
  const entry = threadAnchors.get(channelJid);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    threadAnchors.delete(channelJid);
    return undefined;
  }
  return entry.messageId;
}
