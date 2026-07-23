// Zoom send plane for scopelybot: chatbot-token acquisition, the comfort
// message ("On it...") posted on inbound requests — context-aware since
// Slice 4, classified deterministically from the inbound text — the generic
// deterministic text send (confirm prompts, escalations, digests), and the
// per-channel thread anchor that threads deterministic posts under the
// originating request.

// ScopelyBot Zoom channel JID — update this after creating the channel in Zoom
const SCOPELYBOT_CHANNEL = process.env.SCOPELYBOT_ZOOM_CHANNEL ?? "";

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
  if (!resp.ok) {
    throw new Error(`Zoom token failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

const COMFORT_MESSAGES = [
  "On it — pulling up the details now...",
  "Looking into that, one moment...",
  "Checking Scopely VIP, hang tight...",
  "Gathering the info now...",
  "Let me dig into that...",
];

// Deterministic domain classification for context-aware comfort messages
// (Slice 4). Keyword regex only — no model, no network. Ordered: the first
// matching domain wins, so more specific vocabularies (users, pricing) sit
// above the broad session/deal bucket. Falls back to the generic pool.
const COMFORT_DOMAINS: Array<{ re: RegExp; text: string }> = [
  {
    re: /\buser|password|login|log ?in|verification|account|email address\b/i,
    text: "Checking user records...",
  },
  { re: /\bpric|rate card|discount|cost|curve|quote\b/i, text: "Pulling pricing details..." },
  { re: /\bvendor|card config|scoping card|project type\b/i, text: "Checking vendor configuration..." },
  {
    re: /\bsession|deal|sow|approv|archive|reopen|clone|pipeline|scope\b/i,
    text: "Looking into the deal pipeline...",
  },
  {
    re: /\bhealth|status|error|log|extract|monitor|uptime|down\b/i,
    text: "Checking system health...",
  },
  { re: /\bgithub|issue|repo|deploy|release\b/i, text: "Checking the repo and deploys..." },
];

// Trivial greetings/acks get a real coordinator reply anyway — a comfort
// message on top is pure noise. Deliberately narrow: anything with actual
// request content must still get its comfort message.
const GREETING_RE =
  /^(?:hi|hello|hey|yo|thanks?|thank you|ok(?:ay)?|got it|good (?:morning|afternoon|evening)|gm)[\s!.]*$/i;

// Pick the comfort text for an inbound message: domain-matched when the
// vocabulary is recognizable, otherwise the legacy random pool.
export function pickComfortText(inboundText: string): string {
  for (const { re, text } of COMFORT_DOMAINS) {
    if (re.test(inboundText)) return text;
  }
  return COMFORT_MESSAGES[Math.floor(Math.random() * COMFORT_MESSAGES.length)];
}

export async function sendComfortMessage(
  channelJid: string,
  replyToMessageId?: string,
  inboundText?: string,
): Promise<void> {
  // Only send to the designated ScopelyBot channel
  if (!SCOPELYBOT_CHANNEL || channelJid !== SCOPELYBOT_CHANNEL) {
    return;
  }

  const botJid = process.env.ZOOM_BOT_JID ?? "";
  const accountId = process.env.ZOOM_ACCOUNT_ID ?? "";
  if (!botJid || !accountId) {
    return;
  }

  // Skip trivial greetings — the coordinator's real reply is enough.
  const inbound = (inboundText ?? "").trim();
  if (inbound && GREETING_RE.test(inbound)) {
    return;
  }

  const text = pickComfortText(inbound);
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
        head: { text: "ScopelyBot" },
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
    console.error("[scopelybot] comfort message failed:", err);
  }
}

// Generic text send to a Zoom channel (reuses the bot token). Used by the
// confirm gate to deterministically post the CONFIRM prompt (with the code).
// Pass replyToMessageId to thread the message under the originating request.
export async function sendScopelyText(
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
      content: { head: { text: "ScopelyBot" }, body: [{ type: "message", text }] },
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
    console.error("[scopelybot] sendScopelyText failed:", err);
  }
}

// Per-channel thread anchor for confirm-prompt delivery. The confirm gate stages
// inside a spoke subagent, decoupled from the inbound message event, so it has no
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

// Resolve which message id a direct send (comfort / CONFIRM prompt) should
// thread under. Zoom only renders a bot reply inside a thread when its
// reply_main_message_id is the thread ROOT. For an inbound that is itself a
// thread reply, metadata.messageId is the CHILD message and metadata.threadId
// (canonical, from the zoom adapter's MessageThreadId) is the root — anchoring
// at the child silently orphans the message: it exists via the API but never
// renders in the thread the humans are watching (live incident 2026-07-22:
// two CONFIRM prompts "never popped up" and expired unseen). Prefer the root.
export function resolveInboundThreadAnchor(metadata: {
  messageId?: unknown;
  threadId?: unknown;
}): string | undefined {
  const threadId =
    typeof metadata.threadId === "string" && metadata.threadId.trim().length > 0
      ? metadata.threadId.trim()
      : undefined;
  const messageId =
    typeof metadata.messageId === "string" && metadata.messageId.trim().length > 0
      ? metadata.messageId.trim()
      : undefined;
  return threadId ?? messageId;
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
