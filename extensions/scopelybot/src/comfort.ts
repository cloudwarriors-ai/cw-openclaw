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

export async function sendComfortMessage(
  channelJid: string,
  replyToMessageId?: string,
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
// user-maintenance confirm gate to post execution results.
export async function sendScopelyText(channelJid: string, text: string): Promise<void> {
  const botJid = process.env.ZOOM_BOT_JID ?? "";
  const accountId = process.env.ZOOM_ACCOUNT_ID ?? "";
  if (!channelJid || !botJid || !accountId) return;
  try {
    const token = await getToken();
    await fetch("https://api.zoom.us/v2/im/chat/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        robot_jid: botJid,
        to_jid: channelJid,
        account_id: accountId,
        content: { head: { text: "ScopelyBot" }, body: [{ type: "message", text }] },
      }),
    });
  } catch (err) {
    console.error("[scopelybot] sendScopelyText failed:", err);
  }
}
