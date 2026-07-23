import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { sendZoomMessage } from "./api.js";
import { createZoomConversationStoreFs } from "./conversation-store-fs.js";
import type { ZoomConversationStoreEntry } from "./conversation-store.js";
import {
  classifyZoomSendError,
  formatZoomSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import { getZoomRuntime } from "./runtime.js";
import { rememberZoomSentMessageId, rememberZoomSentMessageText } from "./sent-message-ids.js";
import { resolveZoomCredentials } from "./token.js";
import type { ZoomAtItem, ZoomBodyItem, ZoomConfig } from "./types.js";
import { resolveZoomUserJid } from "./user-directory.js";

export type SendZoomMessageParams = {
  /** Full config (for credentials) */
  cfg: OpenClawConfig;
  /** Conversation ID (user JID or channel JID) to send to */
  to: string;
  /** Message text */
  text: string;
  /** Whether this is a channel message */
  isChannel?: boolean;
  /** Optional: reply to a specific message */
  replyToMessageId?: string;
  /** Optional speaker label used in card heading (e.g., "PulseBot says:"). */
  speakerName?: string;
  /** Optional strict recipient safety guard for DM sends. */
  enforceRecipientSafety?: boolean;
};

export type SendZoomMessageResult = {
  messageId: string;
  conversationId: string;
};

/** Zoom Team Chat message limit */
const ZOOM_TEXT_CHUNK_LIMIT = 4000;
const XMPP_USER_JID_RE = /@xmpp\.zoom\.us$/i;
const WEBHOOK_TIMEOUT_MS = 5000;

type ZoomReplyWebhookPayload = {
  event: "bot.reply";
  payload: {
    channel_id: string;
    message: string;
    message_id: string;
    is_channel: boolean;
    speaker?: string;
  };
};

export function resolveZoomReplyWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ZOOM_REPLY_WEBHOOK_URL?.trim();
  if (explicit && explicit.startsWith("http")) return explicit;
  const fallback = env.BOT_REPLY_WEBHOOK_URL?.trim();
  if (fallback && fallback.startsWith("http")) return fallback;
  return null;
}

export function buildZoomReplyWebhookPayload(params: {
  channelId: string;
  message: string;
  messageId: string;
  isChannel: boolean;
  speakerName?: string;
}): ZoomReplyWebhookPayload {
  const speaker = params.speakerName?.trim();
  return {
    event: "bot.reply",
    payload: {
      channel_id: params.channelId,
      message: params.message,
      message_id: params.messageId,
      is_channel: params.isChannel,
      ...(speaker ? { speaker } : {}),
    },
  };
}

export function buildZoomActionMirrorText(params: {
  headText?: string;
  body: ZoomBodyItem[];
}): string {
  const parts: string[] = [];
  const head = params.headText?.trim();
  if (head) {
    parts.push(head);
  }
  for (const item of params.body) {
    if (item.type === "message") {
      const text = item.text.trim();
      if (text) parts.push(text);
      continue;
    }
    const labels = item.items.map((entry) => entry.text.trim()).filter(Boolean);
    if (labels.length > 0) {
      parts.push(`Actions: ${labels.join(" | ")}`);
    }
  }
  return parts.join("\n\n").slice(0, ZOOM_TEXT_CHUNK_LIMIT);
}

async function mirrorZoomReplyToWebhook(params: {
  log: { warn: (message: string, data?: Record<string, unknown>) => void };
  to: string;
  message: string;
  messageId: string;
  isChannel: boolean;
  speakerName?: string;
}): Promise<void> {
  const webhookUrl = resolveZoomReplyWebhookUrl();
  if (!webhookUrl) return;

  const payload = buildZoomReplyWebhookPayload({
    channelId: params.to,
    message: params.message,
    messageId: params.messageId,
    isChannel: params.isChannel,
    speakerName: params.speakerName,
  });

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text();
      params.log.warn("zoom reply webhook mirror failed", {
        status: response.status,
        body: body.slice(0, 300),
      });
    }
  } catch (err) {
    params.log.warn("zoom reply webhook mirror error", {
      error: formatUnknownError(err),
    });
  }
}

function normalizeLookupToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collectRecipientIdentityTokens(reference: {
  userJid?: string;
  userName?: string;
  userEmail?: string;
}): Set<string> {
  const tokens = new Set<string>();
  const push = (value?: string) => {
    const normalized = normalizeLookupToken(value ?? "");
    if (normalized) tokens.add(normalized);
  };

  push(reference.userJid);
  push(reference.userName);

  const userName = reference.userName?.trim() ?? "";
  if (userName) {
    for (const part of userName.split(/\s+/g)) push(part);
  }

  const email = reference.userEmail?.trim().toLowerCase() ?? "";
  if (email) {
    push(email);
    const local = email.split("@")[0] ?? "";
    push(local);
    for (const part of local.split(/[._-]+/g)) push(part);
  }

  return tokens;
}

function extractLeadingSalutationTarget(message: string): string | undefined {
  // Catch direct-address opens like "Hey Tyler", "Hi Doug,", "Hello Chad —".
  const match = message.match(/^\s*(?:hey|hi|hello)\s+([a-z][a-z0-9._-]*)\b/i);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  const normalized = normalizeLookupToken(raw);
  return normalized || undefined;
}

export function resolveZoomDmRecipientSafetyViolation(params: {
  recipient: string;
  message: string;
  reference: {
    userJid?: string;
    userName?: string;
    userEmail?: string;
  } | null;
}): string | null {
  const recipient = params.recipient.trim();
  if (!recipient || !XMPP_USER_JID_RE.test(recipient)) return null;

  const salutationTarget = extractLeadingSalutationTarget(params.message);
  if (!salutationTarget) return null;

  const reference = params.reference;
  if (!reference || (!reference.userName?.trim() && !reference.userEmail?.trim())) {
    return "unable to verify recipient identity for JID target; use email/name or run zoom_lookup_user first";
  }

  const identityTokens = collectRecipientIdentityTokens(reference);
  if (identityTokens.has(salutationTarget)) return null;

  const recipientLabel = reference.userName?.trim() || reference.userEmail?.trim() || recipient;
  return `recipient mismatch: message greets "${salutationTarget}" but target resolves to "${recipientLabel}"`;
}

export function resolveDmRecipientFromKnownConversations(
  recipient: string,
  entries: ZoomConversationStoreEntry[],
): string | null {
  const target = recipient.trim();
  if (!target) return null;
  if (XMPP_USER_JID_RE.test(target)) return target;

  const lower = target.toLowerCase();
  const normalized = normalizeLookupToken(target);
  const emailLocal = lower.includes("@") ? lower.split("@")[0] : lower;
  const normalizedEmailLocal = normalizeLookupToken(emailLocal);

  const candidates = new Set<string>();
  for (const entry of entries) {
    const userJid = entry.reference.userJid?.trim();
    if (!userJid || !XMPP_USER_JID_RE.test(userJid)) continue;

    const userEmail = entry.reference.userEmail?.trim().toLowerCase();
    const userName = entry.reference.userName?.trim() ?? "";
    const normalizedUserName = normalizeLookupToken(userName);

    if (userJid.toLowerCase() === lower) candidates.add(userJid);
    if (userEmail && userEmail === lower) candidates.add(userJid);
    if (normalizedUserName && normalizedUserName === normalized) candidates.add(userJid);
    if (normalizedUserName && normalizedEmailLocal && normalizedUserName === normalizedEmailLocal) {
      candidates.add(userJid);
    }
  }

  if (candidates.size === 1) {
    return [...candidates][0];
  }
  return null;
}

function normalizeSpeakerName(name?: string): string | undefined {
  const normalized = name?.trim();
  return normalized || undefined;
}

function resolveAgentName(cfg: OpenClawConfig, agentId?: string): string | undefined {
  const normalizedAgentId = agentId?.trim();
  if (!normalizedAgentId) return undefined;
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const entry = list.find((candidate) => candidate?.id?.trim() === normalizedAgentId);
  return normalizeSpeakerName(entry?.name);
}

function resolveSpeakerNameForSend(params: {
  cfg: OpenClawConfig;
  to: string;
  isChannel: boolean;
  speakerName?: string;
}): string | undefined {
  const explicit = normalizeSpeakerName(params.speakerName);
  if (explicit) return explicit;
  if (!params.isChannel) return undefined;

  try {
    const core = getZoomRuntime();
    const route = core.channel.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: "zoom",
      peer: { kind: "channel", id: params.to },
    });
    return resolveAgentName(params.cfg, route.agentId);
  } catch {
    return undefined;
  }
}

export function formatZoomSpeakerHeading(speakerName?: string): string {
  const normalized = normalizeSpeakerName(speakerName);
  if (!normalized) return "cwbot says:";
  return `${normalized} says:`;
}

/** Strip markdown bold markers (**) that wrap or adjoin URLs */
function cleanMarkdownUrls(text: string): string {
  // Remove ** immediately before or after URLs so links stay clickable
  return text.replace(/\*\*(https?:\/\/[^\s*]+)\*\*/g, "$1");
}

/**
 * Convert common Markdown to clean plain text for Zoom Team Chat. Zoom bot cards render with
 * is_markdown_support=false, so raw markdown shows as literal junk (e.g. "**bold**", "- bullet",
 * "## header") and the message reads like a blob. We CONVERT rather than blindly strip, to keep
 * readability: list markers become "• ", emphasis/headers lose only their markers (text kept), and
 * links become "text (url)" so the URL stays usable. Applied only when the channel opts in via
 * ZoomChannelConfig.plainText (see shouldPlainText).
 */
function toPlainTextForZoom(input: string): string {
  let t = input;
  // Fenced code blocks -> keep inner text, drop the ``` fences.
  t = t.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, "$1");
  // Headers: "## Title" -> "Title".
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Bullet list markers at line start: "- ", "* ", "+ " -> "• ".
  t = t.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  // Links [text](url) -> "text (url)".
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
  // Bold/italic: **x** / __x__ / *x* / _x_ -> x (double markers first).
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2").replace(/(^|[^_])_([^_\n]+)_/g, "$1$2");
  // Strikethrough ~~x~~ -> x.
  t = t.replace(/~~([^~]+)~~/g, "$1");
  // Inline code `x` -> x.
  t = t.replace(/`([^`]+)`/g, "$1");
  // Collapse 3+ blank lines to a single blank line (tidier in chat).
  t = t.replace(/\n{3,}/g, "\n\n");
  return t;
}

/**
 * Whether outbound text to `to` should be converted to plain text, per the per-channel
 * ZoomChannelConfig.plainText opt-in. Returns false (no conversion) for any channel without the
 * flag, so existing channels/bots are unaffected.
 */
function shouldPlainText(zoomCfg: ZoomConfig | undefined, to: string): boolean {
  return zoomCfg?.channels?.[to]?.plainText === true;
}

/** Parse mentions and generate at_items */
function parseMentions(text: string): { cleanText: string; atItems: ZoomAtItem[] } {
  const atItems: ZoomAtItem[] = [];
  let cleanText = "";
  let lastIndex = 0;

  // Pattern: <@jid> or @all
  const mentionRegex = /<@([^>]+)>|(@all)\b/g;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    // Append preceding text
    cleanText += text.slice(lastIndex, match.index);

    const startIndex = cleanText.length;
    let displayText = "";

    if (match[1]) {
      // Individual mention <@jid>
      const atContact = match[1];
      displayText = "@Member";
      cleanText += displayText;
      atItems.push({
        at_type: 1,
        start_index: startIndex,
        end_index: startIndex + displayText.length,
        at_contact: atContact,
      });
    } else if (match[2]) {
      // Mention all @all
      displayText = "@all";
      cleanText += displayText;
      atItems.push({
        at_type: 2,
        start_index: startIndex,
        end_index: startIndex + displayText.length,
      });
    }

    lastIndex = mentionRegex.lastIndex;
  }

  // Append remaining text
  cleanText += text.slice(lastIndex);

  return { cleanText, atItems };
}

/**
 * Send a text message to a Zoom Team Chat conversation.
 */
export async function sendZoomTextMessage(
  params: SendZoomMessageParams,
): Promise<SendZoomMessageResult> {
  const { cfg, isChannel, replyToMessageId, speakerName } = params;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  // Plain-text channels (opt-in via ZoomChannelConfig.plainText) get a full markdown->plaintext
  // pass; all others keep the original behavior (only URL-bold cleanup).
  const text = shouldPlainText(zoomCfg, params.to)
    ? toPlainTextForZoom(cleanMarkdownUrls(params.text))
    : cleanMarkdownUrls(params.text);
  const creds = resolveZoomCredentials(zoomCfg);

  if (!creds) {
    throw new Error("Zoom credentials not configured");
  }

  const core = getZoomRuntime();
  const log = core.logging.getChildLogger({ name: "zoom" });

  // Get conversation reference for account_id if needed
  const conversationStore = createZoomConversationStoreFs();
  let to = params.to;
  if (!isChannel) {
    const resolved = resolveDmRecipientFromKnownConversations(
      to,
      await conversationStore.list(),
    );
    if (resolved) {
      to = resolved;
    } else {
      const resolvedFromDirectory = await resolveZoomUserJid(to);
      if (resolvedFromDirectory) to = resolvedFromDirectory;
    }
  }
  const storedRef = await conversationStore.get(to);
  if (!isChannel && params.enforceRecipientSafety) {
    const safetyViolation = resolveZoomDmRecipientSafetyViolation({
      recipient: to,
      message: text,
      reference: storedRef
        ? {
            userJid: storedRef.userJid,
            userName: storedRef.userName,
            userEmail: storedRef.userEmail,
          }
        : null,
    });
    if (safetyViolation) {
      throw new Error(`zoom send blocked: ${safetyViolation}`);
    }
  }
  const accountId = storedRef?.accountId ?? creds.accountId;

  log.debug(
    `sending message to=${to} channel=${Boolean(isChannel)} textLength=${text.length} replyToMessageId=${replyToMessageId ?? "none"}`,
  );

  const { cleanText, atItems } = parseMentions(text);
  const resolvedSpeakerName = resolveSpeakerNameForSend({
    cfg,
    to,
    isChannel: Boolean(isChannel),
    speakerName,
  });

  // Build message content using Zoom's format
  // Zoom requires both head (title) and body (message content)
  const content = {
    head: {
      text: formatZoomSpeakerHeading(resolvedSpeakerName),
    },
    body: [
      {
        type: "message" as const,
        text: cleanText.slice(0, ZOOM_TEXT_CHUNK_LIMIT),
        at_items: atItems.length > 0 ? atItems : undefined,
      },
    ],
  };

  try {
    const result = await sendZoomMessage(creds, {
      robotJid: creds.botJid,
      toJid: to,
      accountId,
      content,
      isChannel,
      replyMainMessageId: replyToMessageId,
    });

    if (!result.ok) {
      const err = { statusCode: result.status, message: result.error };
      const classification = classifyZoomSendError(err);
      const hint = formatZoomSendErrorHint(classification);
      const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
      throw new Error(
        `zoom send failed${status}: ${result.error ?? "unknown error"}${hint ? ` (${hint})` : ""}`,
      );
    }

    const messageId = result.data?.message_id ?? "unknown";
    const outboundText = cleanText.slice(0, ZOOM_TEXT_CHUNK_LIMIT);
    rememberZoomSentMessageId(messageId);
    rememberZoomSentMessageText(messageId, outboundText);

    log.info("sent message", { to, messageId });
    await mirrorZoomReplyToWebhook({
      log,
      to,
      message: outboundText,
      messageId,
      isChannel: Boolean(isChannel),
      speakerName: resolvedSpeakerName,
    });

    return {
      messageId,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("zoom send failed")) {
      throw err;
    }
    const classification = classifyZoomSendError(err);
    const hint = formatZoomSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `zoom send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
    );
  }
}

/**
 * Send an interactive message with action buttons to a Zoom Team Chat conversation.
 */
export async function sendZoomActionMessage(params: {
  cfg: OpenClawConfig;
  to: string;
  headText?: string;
  speakerName?: string;
  body: ZoomBodyItem[];
  isChannel?: boolean;
  enforceRecipientSafety?: boolean;
}): Promise<SendZoomMessageResult> {
  const { cfg, headText, body, isChannel } = params;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  const creds = resolveZoomCredentials(zoomCfg);

  if (!creds) {
    throw new Error("Zoom credentials not configured");
  }

  const core = getZoomRuntime();
  const log = core.logging.getChildLogger({ name: "zoom" });

  const conversationStore = createZoomConversationStoreFs();
  let to = params.to;
  if (!isChannel) {
    const resolved = resolveDmRecipientFromKnownConversations(
      to,
      await conversationStore.list(),
    );
    if (resolved) {
      to = resolved;
    } else {
      const resolvedFromDirectory = await resolveZoomUserJid(to);
      if (resolvedFromDirectory) to = resolvedFromDirectory;
    }
  }
  const storedRef = await conversationStore.get(to);
  if (!isChannel && params.enforceRecipientSafety) {
    const firstMessage = body.find((item) => item.type === "message");
    const safetyViolation = resolveZoomDmRecipientSafetyViolation({
      recipient: to,
      message: firstMessage?.text ?? "",
      reference: storedRef
        ? {
            userJid: storedRef.userJid,
            userName: storedRef.userName,
            userEmail: storedRef.userEmail,
          }
        : null,
    });
    if (safetyViolation) {
      throw new Error(`zoom send blocked: ${safetyViolation}`);
    }
  }
  const accountId = storedRef?.accountId ?? creds.accountId;
  const resolvedSpeakerName = resolveSpeakerNameForSend({
    cfg,
    to,
    isChannel: Boolean(isChannel),
    speakerName: params.speakerName,
  });

  log.debug("sending action message", { to, isChannel, bodyItems: body.length });

  const content = {
    head: { text: headText ?? resolvedSpeakerName ?? "cwbot" },
    body: body.map((item) => {
      if (item.type === "actions") {
        return {
          type: "actions" as const,
          items: item.items.map((btn) => ({
            text: btn.text,
            value: btn.value,
            style: btn.style ?? "Default",
          })),
        };
      }
      
      const { cleanText, atItems } = parseMentions(item.text);
      return { 
        type: "message" as const, 
        text: cleanText,
        at_items: atItems.length > 0 ? atItems : undefined,
      };
    }),
  };

  try {
    const result = await sendZoomMessage(creds, {
      robotJid: creds.botJid,
      toJid: to,
      accountId,
      content,
      isChannel,
    });

    if (!result.ok) {
      const err = { statusCode: result.status, message: result.error };
      const classification = classifyZoomSendError(err);
      const hint = formatZoomSendErrorHint(classification);
      const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
      throw new Error(
        `zoom send failed${status}: ${result.error ?? "unknown error"}${hint ? ` (${hint})` : ""}`,
      );
    }

    const messageId = result.data?.message_id ?? "unknown";
    rememberZoomSentMessageId(messageId);
    const mirroredText = buildZoomActionMirrorText({
      headText: content.head.text,
      body,
    });
    if (mirroredText) {
      await mirrorZoomReplyToWebhook({
        log,
        to,
        message: mirroredText,
        messageId,
        isChannel: Boolean(isChannel),
        speakerName: resolvedSpeakerName,
      });
    }
    log.info("sent action message", { to, messageId });
    return { messageId, conversationId: to };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("zoom send failed")) {
      throw err;
    }
    const classification = classifyZoomSendError(err);
    const hint = formatZoomSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `zoom send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
    );
  }
}

/**
 * List all known conversation references (for debugging/CLI).
 */
export async function listZoomConversations(): Promise<
  Array<{
    conversationId: string;
    userName?: string;
    conversationType?: string;
  }>
> {
  const store = createZoomConversationStoreFs();
  const all = await store.list();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    userName: reference.userName,
    conversationType: reference.conversationType,
  }));
}
