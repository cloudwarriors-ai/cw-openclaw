import type { OpenClawConfig, RuntimeEnv, GroupPolicy } from "openclaw/plugin-sdk";

import { resolveZoomAgentRoute } from "./agent-route.js";
import { scrubCrossChannelAnswer } from "./answer-scrub.js";
import { persistApprovedQA, appendCustomerDetail, resolveWorkspaceDirForAgent } from "./channel-memory.js";
import type { ZoomConversationStore } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import type { ZoomMonitorLogger } from "./monitor-types.js";
import { getDynamicObservePolicy, enableObserveChannel, toggleObserveChannel, toggleSilentChannel, setReviewChannel, setChannelMode, getObservedChannelsList, setCrossChannelTraining, getCrossChannelTraining } from "./observe-config.js";
import type { ChannelMode, RedactionPolicy } from "./observe-config.js";
import { getBlockedCallSet, getSessionBlockedTools, markToolsApproved, markSessionObserve, clearSessionObserve, formatToolParams } from "./observe-tool-gate.js";
import { getPendingApproval, peekPendingApproval, storePendingApproval } from "./pending-approvals.js";
import { getPendingShare } from "./pending-shares.js";
import { consumeTrainingSession, storeTrainingSession } from "./pending-training.js";
import { isLikelyClarifyingQuestion, selectTrainedAnswerCandidate } from "./trained-answer.js";
import type { MemorySearchResultLike, TrainedAnswerCandidate } from "./trained-answer.js";
import { createUploadToken } from "./upload-tokens.js";
import { isZoomGroupAllowed, resolveZoomAllowlistMatch, resolveZoomObservePolicy, resolveZoomReplyPolicy, resolveZoomRouteConfig } from "./policy.js";
import { shouldRespond, savePrefilterExample, isPrefilterEnabled } from "./prefilter.js";
import type { ZoomConfig, ZoomCredentials, ZoomWebhookEvent } from "./types.js";
import {
  parseZoomInboundThreadContext,
  resolveZoomOutboundReplyMessageId,
  resolveZoomReplyMainMessageId,
  resolveZoomThreadingConfig,
} from "./threading.js";
import type { ZoomInboundThreadContext } from "./threading.js";
import { rememberZoomSessionReplyRoot } from "./thread-state.js";
import { getZoomRuntime } from "./runtime.js";
import { getRecentlySentZoomMessageText, isRecentlySentZoomMessageId } from "./sent-message-ids.js";

/** In-memory roleplay personas for observe mode testing. Key: `${channelJid}::${userJid}` */
const roleplayPersonas = new Map<string, string>();

/** Channels the bot has been explicitly added to (via app_invited/conversation_opened events).
 *  Persisted to disk so state survives container restarts. */
const KNOWN_CHANNELS_FILE = (() => {
  const dir = process.env.OPENCLAW_STATE_DIR
    || (process.env.HOME ? `${process.env.HOME}/.openclaw` : "/home/node/.openclaw");
  return `${dir}/known-bot-channels.json`;
})();

const knownBotChannels: Set<string> = (() => {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const data = JSON.parse(fs.readFileSync(KNOWN_CHANNELS_FILE, "utf-8"));
    return new Set<string>(Array.isArray(data) ? data : []);
  } catch {
    return new Set<string>();
  }
})();

function persistKnownBotChannels(): void {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(KNOWN_CHANNELS_FILE, JSON.stringify([...knownBotChannels]), "utf-8");
  } catch {
    // Best-effort persistence
  }
}

/** In-memory store for prefilter-blocked messages awaiting reviewer "Allow". */
type PendingPrefilter = {
  conversationId: string;
  senderId: string;
  senderName?: string;
  text: string;
  channelJid: string;
  channelName?: string;
  reviewChannelJid: string;
  threadContext?: ZoomInboundThreadContext;
  threadStarterBody?: string;
  replyMainMessageId?: string;
  isThreadReply?: boolean;
  silent?: boolean;
  mode?: string;
  roleplay?: boolean;
  expiresAt: number;
};
const pendingPrefilterStore = new Map<string, PendingPrefilter>();
let prefilterNextId = 1;
function storePrefilterBlock(data: Omit<PendingPrefilter, "expiresAt">): string {
  const id = `pf_${Date.now()}_${prefilterNextId++}`;
  // Prune expired
  const now = Date.now();
  for (const [k, v] of pendingPrefilterStore) {
    if (v.expiresAt <= now) pendingPrefilterStore.delete(k);
  }
  pendingPrefilterStore.set(id, { ...data, expiresAt: now + 2 * 60 * 60 * 1000 });
  return id;
}
function consumePrefilterBlock(id: string): PendingPrefilter | undefined {
  const entry = pendingPrefilterStore.get(id);
  if (!entry || entry.expiresAt <= Date.now()) {
    pendingPrefilterStore.delete(id);
    return undefined;
  }
  pendingPrefilterStore.delete(id);
  return entry;
}

export type ZoomMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  creds: ZoomCredentials;
  textLimit: number;
  conversationStore: ZoomConversationStore;
  log: ZoomMonitorLogger;
};

/**
 * Extract mention of the bot from message text.
 * Zoom mentions format: @<display_name> or uses robot_jid in payload
 */
function extractBotMention(params: {
  text: string;
  botJid: string;
  robotJidInPayload?: string;
}): { mentioned: boolean; cleanText: string } {
  const { text, botJid, robotJidInPayload } = params;

  // Check if robot_jid in payload matches our bot
  if (robotJidInPayload && robotJidInPayload === botJid) {
    return { mentioned: true, cleanText: text.trim() };
  }

  // Clean up any @mention patterns (Zoom uses @DisplayName format)
  // The bot might be mentioned as @BotName - we'll preserve the text as-is
  // since the mention check already passed via robot_jid
  return { mentioned: false, cleanText: text.trim() };
}

/** Strip @mentions and extract a bare command name (e.g. "/observe" or "set-review-channel"). */
type ObserveCommandName = "observe" | "set-review-channel" | "silent" | "roleplay" | "cross-training";

function parseObserveCommand(text: string): ObserveCommandName | null {
  const cleaned = text.replace(/@\S+/g, "").trim().toLowerCase();
  if (cleaned === "/observe" || cleaned === "observe") return "observe";
  if (cleaned === "/set-review-channel" || cleaned === "set-review-channel") return "set-review-channel";
  if (cleaned === "/silent" || cleaned === "silent") return "silent";
  if (cleaned.startsWith("/roleplay") || cleaned.startsWith("roleplay")) return "roleplay";
  if (/^\/cross-training\s+(on|off)$/.test(cleaned) || /^cross-training\s+(on|off)$/.test(cleaned)) return "cross-training";
  return null;
}

/** Parse the on/off argument from a cross-training command. */
function parseCrossTrainingArg(text: string): boolean | null {
  const match = text.replace(/@\S+/g, "").trim().toLowerCase().match(/cross-training\s+(on|off)/);
  if (!match) return null;
  return match[1] === "on";
}

const ADMIN_DOMAIN = process.env.ADMIN_DOMAIN?.toLowerCase().trim();

/** Check if a sender (email or identifier) is from the admin domain. */
function isAdminSender(...identifiers: (string | undefined)[]): boolean {
  if (!ADMIN_DOMAIN) return true; // no domain configured = no restriction
  return identifiers.some((id) => id?.toLowerCase().includes(`@${ADMIN_DOMAIN}`));
}

/** Comma-separated list of admin user names or JIDs (for DM commands where email is unavailable). */
const ADMIN_USERS = (process.env.ADMIN_USERS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Check if a sender matches the ADMIN_USERS env var (case-insensitive). */
function isAdminUser(...identifiers: (string | undefined)[]): boolean {
  if (ADMIN_USERS.length === 0) return false;
  return identifiers.some((id) => id && ADMIN_USERS.includes(id.toLowerCase()));
}

function resolveAgentSpeakerName(cfg: OpenClawConfig, agentId?: string): string | undefined {
  const normalizedId = agentId?.trim();
  if (!normalizedId) return undefined;
  const agents = cfg.agents?.list;
  if (!Array.isArray(agents)) return normalizedId;
  const match = agents.find((agent) => agent.id?.trim() === normalizedId);
  return match?.name?.trim() || normalizedId;
}

async function resolveHighConfidenceTrainedAnswer(params: {
  core: ReturnType<typeof getZoomRuntime>;
  cfg: OpenClawConfig;
  sessionKey: string;
  query: string;
  channelSlug: string;
  allowAllCustomers: boolean;
  excludeSlugs?: string[];
  log: ZoomMonitorLogger;
}): Promise<TrainedAnswerCandidate | undefined> {
  const tool = params.core.tools.createMemorySearchTool({
    config: params.cfg,
    agentSessionKey: params.sessionKey,
    channelSlug: params.channelSlug,
    isSupport: true,
    defaultScope: "channel",
    allowAllCustomers: params.allowAllCustomers,
    excludeSlugs: params.excludeSlugs,
  });
  if (!tool) {
    return undefined;
  }
  try {
    const result = await tool.execute("zoom-observe-trained-answer-prefetch", {
      query: params.query,
      scope: "channel",
      maxResults: 4,
    });
    const details = (result as { details?: unknown }).details;
    if (!details || typeof details !== "object") {
      return undefined;
    }
    const rows = (details as { results?: unknown }).results;
    if (!Array.isArray(rows)) {
      return undefined;
    }
    const parsed: MemorySearchResultLike[] = rows.flatMap((row) => {
      if (!row || typeof row !== "object") {
        return [];
      }
      const raw = row as Record<string, unknown>;
      return [
        {
          path: typeof raw.path === "string" ? raw.path : undefined,
          score: typeof raw.score === "number" ? raw.score : undefined,
          snippet: typeof raw.snippet === "string" ? raw.snippet : undefined,
        },
      ];
    });
    return selectTrainedAnswerCandidate({ query: params.query, results: parsed });
  } catch (err) {
    params.log.debug("observe mode: trained-answer prefetch failed", { error: String(err) });
    return undefined;
  }
}

function resolveParentSessionKeyForThread(params: {
  runtime: ReturnType<typeof getZoomRuntime>;
  cfg: OpenClawConfig;
  senderId: string;
  conversationId: string;
  channelJid?: string;
  isDirect: boolean;
  threading: ReturnType<typeof resolveZoomThreadingConfig>;
  threadContext?: ZoomInboundThreadContext;
  log: ZoomMonitorLogger;
  currentSessionKey?: string;
}): string | undefined {
  if (
    params.isDirect ||
    !params.threading.enabled ||
    params.threading.sessionScope !== "thread" ||
    params.threading.inheritParent === false ||
    !params.threadContext?.threadId
  ) {
    return undefined;
  }

  const parentRoute = resolveZoomAgentRoute({
    runtime: params.runtime,
    cfg: params.cfg,
    senderId: params.senderId,
    conversationId: params.conversationId,
    channelJid: params.channelJid,
    isDirect: params.isDirect,
    threading: { ...params.threading, sessionScope: "parent" },
    threadContext: params.threadContext,
    log: params.log,
  });

  const parentSessionKey = parentRoute.sessionKey?.trim();
  if (!parentSessionKey || parentSessionKey === params.currentSessionKey?.trim()) {
    return undefined;
  }
  return parentSessionKey;
}

export function createZoomMessageHandler(deps: ZoomMessageHandlerDeps) {
  const { cfg, runtime, creds, textLimit, conversationStore, log } = deps;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  const core = getZoomRuntime();
  const resolveMemoryWorkspaceDir = (agentId?: string) => resolveWorkspaceDirForAgent(cfg, agentId);

  return async (event: ZoomWebhookEvent) => {
    const eventType = event.event;

    log.info(`webhook event received: ${eventType}`, { event: eventType, payload: JSON.stringify(event.payload).slice(0, 500) });

    // Handle bot notification (slash commands / direct messages to bot)
    if (eventType === "bot_notification") {
      await handleBotNotification(event);
      return;
    }

    // Handle interactive message actions (button clicks on action cards)
    if (eventType === "interactive_message_actions" || eventType === "interactive_message_select") {
      await handleBotNotification(event);
      return;
    }

    // Handle channel mentions (when bot is @mentioned in a channel)
    if (eventType === "chat_message.posted" || eventType === "team_chat.app_mention" || eventType === "team_chat.channel_message_posted") {
      if (eventType === "team_chat.channel_message_posted") {
        log.info(`team_chat payload: ${JSON.stringify(event.payload)}`);
      }
      await handleChannelMessage(event);
      return;
    }

    // Handle bot added to a channel — auto-enable observe mode
    if (eventType === "team_chat.app_conversation_opened" || eventType === "team_chat.app_invited" || eventType === "team_chat.channel_app_added") {
      await handleAppConversationOpened(event);
      return;
    }

    log.info(`ignoring unhandled event type: ${eventType}`);
  };

  async function handleBotNotification(event: ZoomWebhookEvent) {
    // Debug: log full event structure
    log.info(`bot_notification event: ${JSON.stringify(event)}`);

    const payload = event.payload?.object ?? event.payload;
    if (!payload) {
      log.debug("bot_notification missing payload object");
      return;
    }

    // Handle button/action click events before text processing
    const actionItem = payload.actionItem;
    if (actionItem) {
      await handleButtonAction(payload, actionItem);
      return;
    }

    const userJid = payload.userJid ?? payload.operator;
    const userName = payload.userName ?? payload.user_name ?? payload.operator;
    const userEmail = payload.user_email;
    const toJid = payload.toJid;
    const channelName = payload.channelName;
    // For bot notifications, text comes from payload.text or payload.cmd
    const messageText = payload.text ?? payload.cmd ?? "";

    if (!userJid || !messageText) {
      log.debug("bot_notification missing required fields", { userJid, hasMessage: Boolean(messageText) });
      return;
    }

    // Detect if this is a channel message (toJid contains @conference.)
    const isChannelMessage = toJid?.includes("@conference.") ?? false;
    const conversationId = isChannelMessage ? toJid : userJid;

    log.debug("processing bot notification", {
      userJid,
      userName,
      toJid,
      isChannelMessage,
      textLength: messageText.length,
    });

    if (isChannelMessage) {
      // Channel message - check group policy
      const groupPolicy: GroupPolicy = zoomCfg?.groupPolicy ?? "open";

      if (groupPolicy === "disabled") {
        log.debug("group policy disabled, ignoring channel message");
        return;
      }

      // Handle observe mode slash commands (admin-only)
      const botNotifCmd = parseObserveCommand(messageText);
      if (botNotifCmd && !isAdminSender(userName, userEmail, userJid)) {
        const { sendZoomTextMessage } = await import("./send.js");
        await sendZoomTextMessage({ cfg, to: toJid ?? userJid, text: "Sorry, this command is restricted to admins.", isChannel: isChannelMessage });
        return;
      }
      if (botNotifCmd === "observe") {
        const result = await toggleObserveChannel(toJid, channelName);
        const { sendZoomTextMessage } = await import("./send.js");
        await sendZoomTextMessage({
          cfg,
          to: toJid,
          text: result.enabled
            ? `Observe mode **enabled** for this channel. I'll silently watch for questions and route proposed answers through the review channel for approval.`
            : `Observe mode **disabled** for this channel. Returning to normal behavior.`,
          isChannel: true,
        });
        return;
      }

      if (botNotifCmd === "set-review-channel") {
        await setReviewChannel(toJid, channelName);
        const { sendZoomTextMessage } = await import("./send.js");
        await sendZoomTextMessage({
          cfg,
          to: toJid,
          text: `This channel is now set as the **review channel**. Proposed answers from observed channels will appear here with Approve/Reject buttons.`,
          isChannel: true,
        });
        return;
      }

      if (botNotifCmd === "silent") {
        const result = await toggleSilentChannel(toJid);
        const { sendZoomTextMessage } = await import("./send.js");
        if (!result.found) {
          await sendZoomTextMessage({
            cfg,
            to: toJid,
            text: `This channel is not in observe mode. Enable observe mode first with \`/observe\`.`,
            isChannel: true,
          });
        } else {
          await sendZoomTextMessage({
            cfg,
            to: toJid,
            text: result.silent
              ? `Silent mode **enabled**. I'll observe and process questions, but won't post any messages to this channel. Approval cards still go to the review channel.`
              : `Silent mode **disabled**. I'll now respond directly in this channel after approval.`,
            isChannel: true,
          });
        }
        return;
      }

      if (botNotifCmd === "roleplay") {
        const { sendZoomTextMessage } = await import("./send.js");
        const rpArg = messageText.replace(/@\S+/g, "").trim().replace(/^\/?roleplay\s*/i, "").trim();
        const rpKey = `${toJid}::${userJid}`;
        if (!rpArg || rpArg.toLowerCase() === "off") {
          roleplayPersonas.delete(rpKey);
          await sendZoomTextMessage({ cfg, to: toJid, text: `Roleplay cleared for ${userName ?? userJid}. Back to normal.`, isChannel: true });
        } else {
          roleplayPersonas.set(rpKey, rpArg);
          await sendZoomTextMessage({ cfg, to: toJid, text: `Roleplay active — ${userName ?? userJid} is now **${rpArg}** (external customer). Messages will bypass prefilter.`, isChannel: true });
        }
        return;
      }

      if (botNotifCmd === "cross-training") {
        const { sendZoomTextMessage } = await import("./send.js");
        const enabled = parseCrossTrainingArg(messageText);
        if (enabled === null) {
          await sendZoomTextMessage({ cfg, to: toJid, text: `Usage: \`/cross-training on\` or \`/cross-training off\``, isChannel: true });
          return;
        }
        const result = await setCrossChannelTraining(toJid, enabled, userName ?? userJid);
        if (!result.found) {
          await sendZoomTextMessage({ cfg, to: toJid, text: `This channel is not in observe mode. Enable observe mode first with \`/observe\`.`, isChannel: true });
        } else {
          const redactionNote = enabled ? " Reply redaction (LLM) is enabled by default." : "";
          await sendZoomTextMessage({
            cfg,
            to: toJid,
            text: enabled
              ? `Cross-channel training **enabled**. Memory search can now retrieve data from other customer channels.${redactionNote}`
              : `Cross-channel training **disabled**. Memory search is restricted to this channel only.`,
            isChannel: true,
          });
          log.info(`cross-training toggled: channel=${toJid} enabled=${enabled} actor=${userName ?? userJid}`);
        }
        return;
      }

      // Store channel conversation reference
      await conversationStore.upsert(toJid, {
        channelJid: toJid,
        channelName,
        robotJid: creds.botJid,
        accountId: creds.accountId,
        conversationType: "channel",
      });

      // Check observe mode — if enabled, route through the observe pipeline (with prefilter)
      const botNotifRouteConfig = resolveZoomRouteConfig({ cfg: zoomCfg, channelJid: toJid, channelName });
      const botNotifStaticObserve = resolveZoomObservePolicy({ channelConfig: botNotifRouteConfig.channelConfig });
      const botNotifDynamicObserve = await getDynamicObservePolicy(toJid);
      const botNotifObserveMode = botNotifStaticObserve.observeMode || botNotifDynamicObserve.observeMode;
      const botNotifReviewJid = botNotifStaticObserve.reviewChannelJid ?? botNotifDynamicObserve.reviewChannelJid;

      if (botNotifObserveMode && botNotifReviewJid) {
        const botNotifMode = botNotifDynamicObserve.mode ?? (botNotifDynamicObserve.silent ? "silent" : "active");
        const rpPersona = roleplayPersonas.get(`${toJid}::${userJid}`);
        await routeToAgentWithObserve({
          conversationId: toJid,
          senderId: userJid,
          senderName: rpPersona ?? userName,
          text: messageText,
          channelJid: toJid,
          channelName,
          reviewChannelJid: botNotifReviewJid,
          silent: botNotifMode === "silent",
          mode: botNotifMode,
          roleplay: Boolean(rpPersona),
        });
        return;
      }

      // Route to agent with channel context (non-observe)
      await routeToAgent({
        conversationId: toJid,
        senderId: userJid,
        senderName: userName,
        senderEmail: userEmail,
        text: messageText,
        isDirect: false,
        channelJid: toJid,
        channelName,
      });
    } else {
      // Handle /channel-mode DM command (admin-only)
      const channelModeMatch = messageText.trim().match(/^\/channel-mode\s+(.+?)\s+(active|silent|training)$/i);
      if (channelModeMatch) {
        const { sendZoomTextMessage } = await import("./send.js");
        if (!isAdminSender(userName, userEmail, userJid) && !isAdminUser(userName, userJid)) {
          await sendZoomTextMessage({ cfg, to: userJid, text: "Sorry, this command is restricted to admins.", isChannel: false });
          return;
        }

        const searchName = channelModeMatch[1].toLowerCase();
        const newMode = channelModeMatch[2].toLowerCase() as ChannelMode;
        const channels = await getObservedChannelsList();

        // Fuzzy match: case-insensitive partial match on channelName
        const match = channels.find((ch) =>
          ch.channelName?.toLowerCase().includes(searchName),
        );

        if (!match) {
          const available = channels.map((ch) => ch.channelName ?? ch.channelJid).join(", ");
          await sendZoomTextMessage({
            cfg,
            to: userJid,
            text: `No observed channel matching "${channelModeMatch[1]}". Observed channels: ${available || "(none)"}`,
            isChannel: false,
          });
          return;
        }

        const result = await setChannelMode(match.channelJid, newMode);
        if (!result.found) {
          await sendZoomTextMessage({ cfg, to: userJid, text: `Channel "${match.channelName}" is no longer observed.`, isChannel: false });
          return;
        }

        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: `Mode for **${match.channelName}** set to **${newMode}**.`,
          isChannel: false,
        });
        return;
      }

      // Check training session FIRST — training feedback bypasses DM allowlist
      // (the user already proved authorization by clicking Train in the review channel)
      const training = consumeTrainingSession(userJid);
      if (training) {
        await handleTrainingFeedback({ userJid, userName, feedback: messageText, training });
        return;
      }

      // Direct message - check DM policy
      const dmPolicy = zoomCfg?.dmPolicy ?? "pairing";
      const allowFrom = zoomCfg?.allowFrom ?? [];

      if (dmPolicy === "disabled") {
        log.debug("dm policy disabled, ignoring message");
        return;
      }

      if (dmPolicy !== "open") {
        const match = resolveZoomAllowlistMatch({
          allowFrom,
          senderId: userJid,
          senderName: userName,
          senderEmail: userEmail,
        });

        if (!match.allowed) {
          log.debug("sender not in allowlist", { userJid, userName });
          return;
        }
      }

      // Store DM conversation reference
      await conversationStore.upsert(userJid, {
        userJid,
        userName,
        userEmail,
        robotJid: creds.botJid,
        accountId: creds.accountId,
        conversationType: "direct",
      });

      // Route to agent
      await routeToAgent({
        conversationId: userJid,
        senderId: userJid,
        senderName: userName,
        senderEmail: userEmail,
        text: messageText,
        isDirect: true,
      });
    }
  }

  async function handleButtonAction(
    payload: NonNullable<ZoomWebhookEvent["payload"]["object"]>,
    actionItem: { text?: string; value?: string },
  ) {
    const userJid = payload.userJid ?? payload.operator;
    const userName = payload.userName ?? payload.user_name ?? payload.operator;
    const userEmail = payload.user_email;
    const reviewChannelJid = payload.toJid; // channel where the button was clicked (review channel)
    const value = actionItem.value ?? "";

    if (!userJid) {
      log.debug("button action missing userJid");
      return;
    }

    log.info("handling button action", { userJid, value: value.slice(0, 80) });

    // Handle prefilter allow — re-process the blocked message through observe pipeline
    if (value.startsWith("prefilter_allow:")) {
      const refId = value.slice("prefilter_allow:".length);
      const pending = consumePrefilterBlock(refId);
      const { sendZoomTextMessage } = await import("./send.js");
      if (!pending) {
        await sendZoomTextMessage({ cfg, to: userJid, text: "This filtered message has expired.", isChannel: false });
        return;
      }
      log.info("prefilter override: allowing blocked message", { channelJid: pending.channelJid, text: pending.text.slice(0, 80) });
      // Train: save as RESPOND example so future similar messages are allowed
      savePrefilterExample(pending.text, "RESPOND", pending.channelName);
      // Re-route with skipFilter=true to bypass both prefilter and NO_RESPONSE drop
      await routeToAgentWithObserve({
        ...pending,
        skipFilter: true,
      });
      return;
    }

    // Handle prefilter dismiss — train as SKIP and acknowledge
    if (value.startsWith("prefilter_dismiss:")) {
      const refId = value.slice("prefilter_dismiss:".length);
      const pending = pendingPrefilterStore.get(refId);
      if (pending) {
        savePrefilterExample(pending.text, "SKIP", pending.channelName);
      }
      pendingPrefilterStore.delete(refId);
      return;
    }

    // Handle share-to-channel directly (no LLM round-trip)
    if (value.startsWith("share_to_channel:")) {
      const refId = value.slice("share_to_channel:".length);
      const pending = getPendingShare(refId);
      if (!pending) {
        log.debug("pending share not found or expired", { refId });
        // Notify user the share expired
        const { sendZoomTextMessage } = await import("./send.js");
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "This share link has expired. Please ask the agent to generate a new summary.",
          isChannel: false,
        });
        return;
      }

      const { sendZoomTextMessage } = await import("./send.js");
      // Post summary to the channel
      await sendZoomTextMessage({
        cfg,
        to: pending.channelJid,
        text: pending.summary,
        isChannel: true,
      });
      // Confirm to user in DM
      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: "Summary shared to channel.",
        isChannel: false,
      });
      return;
    }

    // Handle approve answer from observe mode
    if (value.startsWith("approve_answer:")) {
      const refId = value.slice("approve_answer:".length);
      const pending = getPendingApproval(refId);
      const { sendZoomTextMessage } = await import("./send.js");
      const sendReviewStatus = async (text: string) => {
        if (!reviewChannelJid) return;
        try {
          await sendZoomTextMessage({
            cfg,
            to: reviewChannelJid,
            text,
            isChannel: true,
          });
        } catch (err) {
          log.warn("failed to send review-channel approval status", {
            reviewChannelJid,
            error: formatUnknownError(err),
          });
        }
      };
      if (!pending) {
        log.debug("pending approval not found or expired", { refId });
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "This approval has expired. The original question will need to be asked again.",
          isChannel: false,
        });
        return;
      }

      // Post the approved answer to the original channel (skip in silent mode)
      if (!pending.silent) {
        const firstName = pending.originalSenderName.split(/[@\s.]/)[0];
        const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
        const speakerName = resolveAgentSpeakerName(cfg, pending.agentId);
        try {
          await sendZoomTextMessage({
            cfg,
            to: pending.originalChannelJid,
            text: `@${displayName} ${pending.proposedAnswer}`,
            isChannel: true,
            replyToMessageId: pending.replyMainMessageId,
            speakerName,
          });
          await sendReviewStatus(`Approved — posted answer to ${pending.originalChannelName}.`);
        } catch (err) {
          const reason = formatUnknownError(err);
          log.error("failed to post approved answer to original channel", {
            refId,
            channel: pending.originalChannelName,
            channelJid: pending.originalChannelJid,
            error: reason,
          });
          await sendReviewStatus(`Approved, but failed to post to ${pending.originalChannelName}: ${reason}`);
          await sendZoomTextMessage({
            cfg,
            to: userJid,
            text: `Approval received, but posting to ${pending.originalChannelName} failed: ${reason}`,
            isChannel: false,
          });
          return;
        }
      } else {
        await sendReviewStatus(`Approved — silent mode enabled for ${pending.originalChannelName} (not posted to channel).`);
      }

      // Persist Q&A + customer context to channel memory
      try {
        await persistApprovedQA({
          channelName: pending.originalChannelName,
          channelJid: pending.originalChannelJid,
          senderName: pending.originalSenderName,
          question: pending.originalQuestion,
          answer: pending.proposedAnswer,
          workspaceDir: resolveMemoryWorkspaceDir(pending.agentId),
        });
        // Extract customer environment details and add to profile
        const details = extractCustomerDetails(pending.originalQuestion, pending.proposedAnswer);
        for (const detail of details) {
          await appendCustomerDetail({
            channelName: pending.originalChannelName,
            channelJid: pending.originalChannelJid,
            detail,
            workspaceDir: resolveMemoryWorkspaceDir(pending.agentId),
          });
        }
      } catch (err) {
        log.error("failed to persist approved Q&A to memory", { err });
      }

      // Confirm to reviewer via DM
      const postedNote = pending.silent ? " (silent mode — not posted to channel)" : "";
      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: `Answer approved${postedNote}. Saved to ${pending.originalChannelName} training.`,
        isChannel: false,
      });
      return;
    }

    // Handle approve tool from observe mode — re-run agent with all blocked tools whitelisted
    if (value.startsWith("approve_tool:")) {
      const refId = value.slice("approve_tool:".length);
      const blockedSet = getBlockedCallSet(refId);
      const { sendZoomTextMessage } = await import("./send.js");
      if (!blockedSet) {
        log.debug("blocked tool set not found or expired", { refId });
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "This tool approval has expired. The original request will need to be submitted again.",
          isChannel: false,
        });
        return;
      }

      const toolNames = blockedSet.tools.map((t) => t.toolName);

      // Immediate feedback in review channel
      if (reviewChannelJid) {
        await sendZoomTextMessage({
          cfg,
          to: reviewChannelJid,
          text: `Approved — executing ${toolNames.join(", ")} for ${blockedSet.channelName} now...`,
          isChannel: true,
        });
      }

      try {
        const core = getZoomRuntime();
        const threading = resolveZoomThreadingConfig(zoomCfg, log);
        const route = resolveZoomAgentRoute({
          runtime: core,
          cfg,
          senderId: blockedSet.senderJid || blockedSet.senderName,
          conversationId: blockedSet.channelJid,
          channelJid: blockedSet.channelJid,
          isDirect: false,
          threading,
          threadContext: blockedSet.threadContext,
          log,
        });

        // Pre-approve ALL tools so the hook lets them through
        markToolsApproved(route.sessionKey, toolNames);

        // Register as observe mode again (for the re-dispatch)
        markSessionObserve(route.sessionKey, {
          channelJid: blockedSet.channelJid,
          channelName: blockedSet.channelName,
          reviewChannelJid: blockedSet.reviewChannelJid,
          senderName: blockedSet.senderName,
          senderJid: blockedSet.senderJid,
          agentId: blockedSet.agentId ?? route.agentId,
          question: blockedSet.question,
          threadContext: blockedSet.threadContext,
          replyMainMessageId: blockedSet.replyMainMessageId,
          sessionScopeAtCapture: blockedSet.sessionScopeAtCapture ?? threading.sessionScope,
        });

        const toolDescriptions = blockedSet.tools.map((t) => {
          const paramStr = formatToolParams(t.params);
          return `- ${t.toolName}${paramStr ? `: ${paramStr}` : ""}`;
        });

        const execBody = [
          "[APPROVED ACTION — EXECUTE NOW]",
          `A reviewer approved the following action. Execute it immediately.`,
          "",
          `Original request from ${blockedSet.senderName}: ${blockedSet.question}`,
          "",
          `Approved tools:`,
          ...toolDescriptions,
          "",
          "Execute the request using these tools. After execution, report the result concisely (2-3 sentences).",
          "Include the key data that changed (e.g., new totals, updated counts, confirmation IDs).",
        ].join("\n");

        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: execBody,
          RawBody: blockedSet.question,
          CommandBody: execBody,
          From: `zoom:channel:${blockedSet.channelJid}`,
          To: blockedSet.channelJid,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "channel",
          ConversationLabel: blockedSet.senderName,
          SenderName: blockedSet.senderName,
          SenderId: blockedSet.senderName,
          GroupSubject: blockedSet.channelName,
          GroupChannel: blockedSet.channelJid,
          Provider: "zoom" as const,
          Surface: "zoom" as const,
          CommandAuthorized: true,
          CommandSource: "text" as const,
          OriginatingChannel: "zoom" as const,
          OriginatingTo: blockedSet.channelJid,
        });

        const collectedParts: string[] = [];
        const { dispatcher, replyOptions, markDispatchIdle } =
          core.channel.reply.createReplyDispatcherWithTyping({
            humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            deliver: async (payload) => {
              if (payload.text) collectedParts.push(payload.text);
            },
            onError: (err, info) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              log.error(`zoom tool execute ${info.kind} reply failed: ${errMsg}`);
            },
          });

        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });

        // Reply delivery is queued; wait until all payloads are delivered
        // before reading collectedParts.
        await dispatcher.waitForIdle();
        markDispatchIdle();
        clearSessionObserve(route.sessionKey);

        const execResult = collectedParts.join("\n").replace(/\[NO_RESPONSE\]/gi, "").trim();

        if (execResult) {
          if (!blockedSet.silent) {
            const toolFirstName = blockedSet.senderName.split(/[@\s.]/)[0];
            const toolDisplayName = toolFirstName.charAt(0).toUpperCase() + toolFirstName.slice(1).toLowerCase();
            await sendZoomTextMessage({
              cfg,
              to: blockedSet.channelJid,
              text: `@${toolDisplayName} ${execResult}`,
              isChannel: true,
              replyToMessageId: blockedSet.replyMainMessageId,
              speakerName: resolveAgentSpeakerName(cfg, blockedSet.agentId ?? route.agentId),
            });
          }

          try {
            await persistApprovedQA({
              channelName: blockedSet.channelName,
              channelJid: blockedSet.channelJid,
              senderName: blockedSet.senderName,
              question: blockedSet.question,
              answer: execResult,
              workspaceDir: resolveMemoryWorkspaceDir(blockedSet.agentId ?? route.agentId),
            });
          } catch (err) {
            log.error("failed to persist tool action Q&A to memory", { err });
          }

          const toolPostedNote = blockedSet.silent ? " (silent — not posted)" : "";
          await sendZoomTextMessage({
            cfg,
            to: userJid,
            text: `Action executed${toolPostedNote}. Result saved to ${blockedSet.channelName} training.`,
            isChannel: false,
          });
        } else {
          await sendZoomTextMessage({
            cfg,
            to: userJid,
            text: `Action executed but no result returned. Check ${blockedSet.channelName} for status.`,
            isChannel: false,
          });
        }
      } catch (err) {
        log.error("failed to execute approved tools", { error: formatUnknownError(err) });
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: `Tool execution failed: ${formatUnknownError(err)}`,
          isChannel: false,
        });
      }
      return;
    }

    // Handle reject tool from observe mode
    if (value.startsWith("reject_tool:")) {
      const refId = value.slice("reject_tool:".length);
      const blockedSet = getBlockedCallSet(refId);
      const { sendZoomTextMessage } = await import("./send.js");
      if (!blockedSet) {
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "This tool approval has already expired or been handled.",
          isChannel: false,
        });
        return;
      }

      const toolNames = blockedSet.tools.map((t) => t.toolName).join(", ");
      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: `Action rejected (${toolNames}).`,
        isChannel: false,
      });
      return;
    }

    // Handle approve action from observe mode — execute the proposed write/mutation
    if (value.startsWith("approve_action:")) {
      const refId = value.slice("approve_action:".length);
      const pending = getPendingApproval(refId);
      const { sendZoomTextMessage } = await import("./send.js");
      if (!pending) {
        log.debug("pending action approval not found or expired", { refId });
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "This action approval has expired. The original request will need to be submitted again.",
          isChannel: false,
        });
        return;
      }

      // Immediate feedback in review channel
      if (reviewChannelJid) {
        await sendZoomTextMessage({
          cfg,
          to: reviewChannelJid,
          text: `Approved — executing action for ${pending.originalChannelName} now...`,
          isChannel: true,
        });
      }

      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: `Executing approved action for ${pending.originalChannelName}...`,
        isChannel: false,
      });

      try {
        const core = getZoomRuntime();
        const threading = resolveZoomThreadingConfig(zoomCfg, log);

        // Resolve agent route for the original channel
        const route = resolveZoomAgentRoute({
          runtime: core,
          cfg,
          senderId: pending.originalSenderName,
          conversationId: pending.originalChannelJid,
          channelJid: pending.originalChannelJid,
          isDirect: false,
          threading,
          threadContext: pending.threadContext,
          log,
        });

        // Build execution prompt — agent now has full tool access
        const execBody = [
          "[APPROVED ACTION — EXECUTE NOW]",
          `The following action was approved by a reviewer. Execute it immediately using the appropriate tools.`,
          "",
          `Original request from ${pending.originalSenderName}: ${pending.originalQuestion}`,
          "",
          `Approved action: ${pending.proposedAnswer}`,
          "",
          "Execute the action now. After execution, report the result concisely (2-3 sentences).",
          "Include the key data that changed (e.g., new totals, updated counts, confirmation IDs).",
          "Do NOT use [PROPOSED_ACTION] — execute directly.",
        ].join("\n");

        const ctxPayload = core.channel.reply.finalizeInboundContext({
          Body: execBody,
          RawBody: pending.originalQuestion,
          CommandBody: execBody,
          From: `zoom:channel:${pending.originalChannelJid}`,
          To: pending.originalChannelJid,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "channel",
          ConversationLabel: pending.originalSenderName,
          SenderName: pending.originalSenderName,
          SenderId: pending.originalSenderName,
          GroupSubject: pending.originalChannelName,
          GroupChannel: pending.originalChannelJid,
          Provider: "zoom" as const,
          Surface: "zoom" as const,
          CommandAuthorized: true,
          CommandSource: "text" as const,
          OriginatingChannel: "zoom" as const,
          OriginatingTo: pending.originalChannelJid,
        });

        // Collect the execution result
        const collectedParts: string[] = [];

        const { dispatcher, replyOptions, markDispatchIdle } =
          core.channel.reply.createReplyDispatcherWithTyping({
            humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
            deliver: async (payload) => {
              if (payload.text) {
                collectedParts.push(payload.text);
              }
            },
            onError: (err, info) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              log.error(`zoom action execute ${info.kind} reply failed: ${errMsg}`);
            },
          });

        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });

        // Reply delivery is queued; wait until all payloads are delivered
        // before reading collectedParts.
        await dispatcher.waitForIdle();
        markDispatchIdle();

        const execResult = collectedParts.join("\n").replace(/\[NO_RESPONSE\]/gi, "").trim();

        if (execResult) {
          // Post the execution result to the original channel (skip in silent mode)
          if (!pending.silent) {
            const actionFirstName = pending.originalSenderName.split(/[@\s.]/)[0];
            const actionDisplayName = actionFirstName.charAt(0).toUpperCase() + actionFirstName.slice(1).toLowerCase();
            await sendZoomTextMessage({
              cfg,
              to: pending.originalChannelJid,
              text: `@${actionDisplayName} ${execResult}`,
              isChannel: true,
              replyToMessageId: pending.replyMainMessageId,
              speakerName: resolveAgentSpeakerName(cfg, pending.agentId ?? route.agentId),
            });
          }

          // Persist the Q&A for training
          try {
            await persistApprovedQA({
              channelName: pending.originalChannelName,
              channelJid: pending.originalChannelJid,
              senderName: pending.originalSenderName,
              question: pending.originalQuestion,
              answer: execResult,
              workspaceDir: resolveMemoryWorkspaceDir(pending.agentId ?? route.agentId),
            });
          } catch (err) {
            log.error("failed to persist action Q&A to memory", { err });
          }

          // Confirm to reviewer
          const actionPostedNote = pending.silent ? " (silent — not posted)" : "";
          await sendZoomTextMessage({
            cfg,
            to: userJid,
            text: `Action executed${actionPostedNote}. Result saved to ${pending.originalChannelName} training.`,
            isChannel: false,
          });
        } else {
          await sendZoomTextMessage({
            cfg,
            to: userJid,
            text: `Action executed but no result was returned. Check ${pending.originalChannelName} for status.`,
            isChannel: false,
          });
        }
      } catch (err) {
        log.error("failed to execute approved action", { error: formatUnknownError(err) });
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: `Action execution failed: ${formatUnknownError(err)}`,
          isChannel: false,
        });
      }
      return;
    }

    // Handle reject answer from observe mode
    if (value.startsWith("reject_answer:")) {
      const refId = value.slice("reject_answer:".length);
      const pending = getPendingApproval(refId);
      const { sendZoomTextMessage } = await import("./send.js");
      if (!pending) {
        log.debug("pending approval not found or expired", { refId });
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "This approval has already expired or been handled.",
          isChannel: false,
        });
        return;
      }

      // Confirm rejection via DM
      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: "Answer rejected and discarded.",
        isChannel: false,
      });
      return;
    }

    // Handle train answer from observe mode — ask reviewer for feedback
    if (value.startsWith("train_answer:")) {
      const refId = value.slice("train_answer:".length);
      const pending = peekPendingApproval(refId);
      const { sendZoomTextMessage } = await import("./send.js");
      if (!pending) {
        log.debug("pending approval not found or expired for training", { refId });
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "This approval has expired. The original question will need to be asked again.",
          isChannel: false,
        });
        return;
      }

      // Look up the review channel for this observed channel
      const routeConfig = resolveZoomRouteConfig({ cfg: zoomCfg, channelJid: pending.originalChannelJid, channelName: pending.originalChannelName });
      const staticObserve = resolveZoomObservePolicy({ channelConfig: routeConfig.channelConfig });
      const dynamicObserve = await getDynamicObservePolicy(pending.originalChannelJid);
      const reviewChannelJid = staticObserve.reviewChannelJid ?? dynamicObserve.reviewChannelJid ?? "";

      storeTrainingSession(userJid, {
        approvalRefId: refId,
        originalChannelJid: pending.originalChannelJid,
        originalChannelName: pending.originalChannelName,
        originalSenderName: pending.originalSenderName,
        originalQuestion: pending.originalQuestion,
        previousAnswer: pending.proposedAnswer,
        agentId: pending.agentId,
        threadContext: pending.threadContext,
        replyMainMessageId: pending.replyMainMessageId,
        sessionScopeAtCapture: pending.sessionScopeAtCapture,
        reviewChannelJid,
      });

      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: `**Training mode** — What should change about this answer?\n\n**Question:** ${pending.originalQuestion}\n**Current answer:** ${pending.proposedAnswer}\n\nReply with your feedback and I'll regenerate the answer.`,
        isChannel: false,
      });
      log.info("training session started", { refId, userJid });
      return;
    }

    // Handle file-upload button clicks — generate token and send URL directly
    if (/upload|file/i.test(value)) {
      const token = createUploadToken({
        conversationId: userJid,
        userJid,
        userName,
        userEmail,
        isDirect: true,
      });
      const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
      const baseUrl = zoomCfg?.publicUrl ?? "https://molty-dev.cloudwarriors.ai";
      const uploadUrl = `${baseUrl}/zoom/file?token=${token}`;
      const { sendZoomTextMessage } = await import("./send.js");
      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: `Here's your upload link:\n${uploadUrl}`,
        isChannel: false,
      });
      return;
    }

    // Route other button clicks to agent as synthetic message
    await routeToAgent({
      conversationId: userJid,
      senderId: userJid,
      senderName: userName,
      senderEmail: userEmail,
      text: `[BUTTON_CLICK] ${value}`,
      isDirect: true,
    });
  }

  async function handleChannelMessage(event: ZoomWebhookEvent) {
    const payload = event.payload?.object ?? event.payload;
    if (!payload) {
      log.debug("channel message missing payload object");
      return;
    }

    // Support both chat_message.posted and team_chat.channel_message_posted formats
    const isTeamChatEvent = event.event === "team_chat.channel_message_posted";
    const rawChannelId = payload.channel_jid ?? (payload as Record<string, unknown>).channel_id;
    const channelJid = rawChannelId
      ? String(rawChannelId).includes("@") ? String(rawChannelId) : `${rawChannelId}@conference.xmpp.zoom.us`
      : undefined;
    const channelName = payload.channel_name;

    // team_chat format: message is a string directly on object, sender is in event.payload
    const eventPayload = event.payload as Record<string, unknown>;
    const message = isTeamChatEvent ? undefined : payload.message;
    const senderId = isTeamChatEvent
      ? ((eventPayload.operator_id as string) || (eventPayload.operator_member_id as string) || (eventPayload.operator as string) || undefined)
      : (message?.sender ?? message?.sender_member_id);
    const senderName = isTeamChatEvent
      ? ((eventPayload.operator as string) || undefined)
      : message?.sender_display_name;
    const robotJidInPayload = isTeamChatEvent ? undefined : (message?.robot_jid ?? payload.robot_jid);
    const messageText = isTeamChatEvent
      ? String((payload as Record<string, unknown>).message ?? "")
      : (message?.message ?? "");
    const messageId = isTeamChatEvent
      ? (payload as Record<string, unknown>).message_id as string | undefined
      : message?.id;
    const replyMainMessageId = isTeamChatEvent
      ? (payload as Record<string, unknown>).reply_main_message_id as string | undefined
      : message?.reply_main_message_id;
    const threadContext = parseZoomInboundThreadContext({
      messageId,
      replyMainMessageId,
    });
    const threadStarterBody = threadContext.parentMessageId
      ? getRecentlySentZoomMessageText(threadContext.parentMessageId)
      : undefined;

    if (!channelJid || !senderId || !messageText) {
      log.debug("channel message missing required fields", {
        hasChannel: Boolean(channelJid),
        hasSender: Boolean(senderId),
        hasMessage: Boolean(messageText),
      });
      return;
    }

    if (isRecentlySentZoomMessageId(messageId)) {
      log.debug("ignoring echoed outbound message", { channelJid, messageId });
      return;
    }

    // Only process messages from channels the bot was added to or that have
    // explicit bindings. This prevents account-level team_chat events from
    // triggering responses in unrelated channels.
    // Read fresh config from disk (not stale closure) so runtime binding
    // changes (ETL activation/deactivation) are reflected immediately.
    let hasBinding = false;
    try {
      const fs = await import("node:fs");
      const configDir = process.env.OPENCLAW_STATE_DIR
        || (process.env.HOME ? `${process.env.HOME}/.openclaw` : "/home/node/.openclaw");
      const freshCfg = JSON.parse(fs.readFileSync(`${configDir}/openclaw.json`, "utf-8"));
      const freshBindings = Array.isArray(freshCfg.bindings) ? freshCfg.bindings : [];
      hasBinding = freshBindings.some((b: Record<string, unknown>) => {
        const match = b?.match as Record<string, unknown> | undefined;
        const peer = match?.peer as Record<string, unknown> | undefined;
        return match?.channel === "zoom" && peer?.kind === "channel" && peer?.id === channelJid;
      });
    } catch {
      // Fall back to stale closure config
      const cfgBindings = (cfg as Record<string, unknown>).bindings;
      const bindings = Array.isArray(cfgBindings) ? cfgBindings : [];
      hasBinding = bindings.some((b: Record<string, unknown>) => {
        const match = b?.match as Record<string, unknown> | undefined;
        const peer = match?.peer as Record<string, unknown> | undefined;
        return match?.channel === "zoom" && peer?.kind === "channel" && peer?.id === channelJid;
      });
    }
    if (!knownBotChannels.has(channelJid) && !hasBinding) {
      log.debug("channel not known and no binding, skipping", { channelJid });
      return;
    }

    log.debug("processing channel message", {
      channelJid,
      channelName,
      senderId,
      textLength: messageText.length,
    });

    // Handle observe mode slash commands (admin-only, before group policy)
    const channelCmd = parseObserveCommand(messageText);
    if (channelCmd && !isAdminSender(senderName, senderId)) {
      const { sendZoomTextMessage } = await import("./send.js");
      await sendZoomTextMessage({ cfg, to: channelJid, text: "Sorry, this command is restricted to admins.", isChannel: true });
      return;
    }
    if (channelCmd === "observe") {
      const result = await toggleObserveChannel(channelJid, channelName);
      const { sendZoomTextMessage } = await import("./send.js");
      await sendZoomTextMessage({
        cfg,
        to: channelJid,
        text: result.enabled
          ? `Observe mode **enabled** for this channel. I'll silently watch for questions and route proposed answers through the review channel for approval.`
          : `Observe mode **disabled** for this channel. Returning to normal behavior.`,
        isChannel: true,
      });
      return;
    }

    if (channelCmd === "set-review-channel") {
      await setReviewChannel(channelJid, channelName);
      const { sendZoomTextMessage } = await import("./send.js");
      await sendZoomTextMessage({
        cfg,
        to: channelJid,
        text: `This channel is now set as the **review channel**. Proposed answers from observed channels will appear here with Approve/Reject buttons.`,
        isChannel: true,
      });
      return;
    }

    if (channelCmd === "silent") {
      const result = await toggleSilentChannel(channelJid);
      const { sendZoomTextMessage } = await import("./send.js");
      if (!result.found) {
        await sendZoomTextMessage({
          cfg,
          to: channelJid,
          text: `This channel is not in observe mode. Enable observe mode first with \`/observe\`.`,
          isChannel: true,
        });
      } else {
        await sendZoomTextMessage({
          cfg,
          to: channelJid,
          text: result.silent
            ? `Silent mode **enabled**. I'll observe and process questions, but won't post any messages to this channel. Approval cards still go to the review channel.`
            : `Silent mode **disabled**. I'll now respond directly in this channel after approval.`,
          isChannel: true,
        });
      }
      return;
    }

    if (channelCmd === "roleplay") {
      const { sendZoomTextMessage } = await import("./send.js");
      const rpArg = messageText.replace(/@\S+/g, "").trim().replace(/^\/?roleplay\s*/i, "").trim();
      const rpKey = `${channelJid}::${senderId}`;
      if (!rpArg || rpArg.toLowerCase() === "off") {
        roleplayPersonas.delete(rpKey);
        await sendZoomTextMessage({ cfg, to: channelJid, text: `Roleplay cleared for ${senderName ?? senderId}. Back to normal.`, isChannel: true });
      } else {
        roleplayPersonas.set(rpKey, rpArg);
        await sendZoomTextMessage({ cfg, to: channelJid, text: `Roleplay active — ${senderName ?? senderId} is now **${rpArg}** (external customer). Messages will bypass prefilter.`, isChannel: true });
      }
      return;
    }

    // Resolve per-channel config and check observe mode before group policy
    // (observe mode allows all senders — it watches the whole channel)
    const routeConfig = resolveZoomRouteConfig({ cfg: zoomCfg, channelJid, channelName });
    const { channelConfig } = routeConfig;

    // Check observe mode — static config first, then dynamic config
    const staticObservePolicy = resolveZoomObservePolicy({ channelConfig });
    const dynamicObservePolicy = await getDynamicObservePolicy(channelJid);
    const observeMode = staticObservePolicy.observeMode || dynamicObservePolicy.observeMode;
    const reviewChannelJid = staticObservePolicy.reviewChannelJid ?? dynamicObservePolicy.reviewChannelJid;
    const observeChannelMode = dynamicObservePolicy.mode ?? (dynamicObservePolicy.silent ? "silent" : "active");

    if (observeMode && reviewChannelJid) {
      // Store conversation reference
      await conversationStore.upsert(channelJid, {
        channelJid,
        channelName,
        robotJid: creds.botJid,
        accountId: creds.accountId,
        conversationType: "channel",
        lastMessageId: messageId,
      });

      const rpPersona = roleplayPersonas.get(`${channelJid}::${senderId}`);
      await routeToAgentWithObserve({
        conversationId: channelJid,
        senderId,
        senderName: rpPersona ?? senderName,
        text: messageText.trim(),
        channelJid,
        channelName,
        reviewChannelJid,
        threadContext,
        threadStarterBody,
        isThreadReply: threadContext.isThreadReply,
        silent: observeChannelMode === "silent",
        mode: observeChannelMode,
        roleplay: Boolean(rpPersona),
      });
      return;
    }

    // Check group policy (only for non-observed channels)
    const groupPolicy: GroupPolicy = zoomCfg?.groupPolicy ?? "allowlist";
    const groupAllowFrom = zoomCfg?.groupAllowFrom ?? [];

    if (!isZoomGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId,
      senderName,
    })) {
      log.debug("sender not allowed in group", { senderId, senderName, groupPolicy });
      return;
    }

    // Check mention requirement
    const replyPolicy = resolveZoomReplyPolicy({
      isDirectMessage: false,
      globalConfig: zoomCfg,
      channelConfig,
    });

    const { mentioned, cleanText } = extractBotMention({
      text: messageText,
      botJid: creds.botJid,
      robotJidInPayload,
    });

    if (replyPolicy.requireMention && !mentioned) {
      log.debug("message does not mention bot, ignoring", { channelJid });
      return;
    }

    // Store conversation reference
    await conversationStore.upsert(channelJid, {
      channelJid,
      channelName,
      robotJid: creds.botJid,
      accountId: creds.accountId,
      conversationType: "channel",
      lastMessageId: messageId,
    });

    // Route to OpenClaw agent
    await routeToAgent({
      conversationId: channelJid,
      senderId,
      senderName,
      text: cleanText,
      isDirect: false,
      channelJid,
      channelName,
      threadContext,
      threadStarterBody,
    });
  }

  async function handleAppConversationOpened(event: ZoomWebhookEvent) {
    const payload = event.payload?.object ?? event.payload;
    log.info(`app_invited/conversation_opened payload: ${JSON.stringify(event.payload)}`);

    if (!payload) return;

    const p = payload as Record<string, unknown>;
    // Extract channel info — try multiple field names across event types
    const rawChannelId = p.channel_id ?? p.toJid ?? p.to_jid;
    const channelName = (p.channel_name ?? p.name) as string | undefined;

    if (!rawChannelId) {
      log.debug("app_conversation_opened: no channel_id in payload, skipping");
      return;
    }

    const channelJid = String(rawChannelId).includes("@")
      ? String(rawChannelId)
      : `${rawChannelId}@conference.xmpp.zoom.us`;

    // Only enable observe mode for group channels, NOT DMs.
    // Channel JIDs: ...@conference.xmpp.zoom.us  |  DM JIDs: ...@xmpp.zoom.us
    if (!channelJid.includes("@conference.")) {
      log.debug(`app_conversation_opened: skipping DM JID ${channelJid} (not a channel)`);
      return;
    }

    // Track that the bot has been added to this channel (persisted to disk)
    knownBotChannels.add(channelJid);
    persistKnownBotChannels();

    // Auto-enable observe mode for this channel
    await enableObserveChannel(channelJid, channelName);
    log.info(`auto-enabled observe mode for channel: ${channelName ?? channelJid}`);

    // Fire-and-forget: pull history and build training prompt
    const { fetchAndTrainFromHistory } = await import("./history.js");
    const historyRoute = resolveZoomAgentRoute({
      runtime: core,
      cfg,
      senderId: "system",
      conversationId: channelJid,
      channelJid,
      isDirect: false,
      log,
    });
    fetchAndTrainFromHistory(channelJid, channelName, creds, log, {
      workspaceDir: resolveMemoryWorkspaceDir(historyRoute.agentId),
    }).catch((err) =>
      log.error(`history ingest failed for ${channelName ?? channelJid}: ${err}`),
    );
  }

  async function routeToAgent(params: {
    conversationId: string;
    senderId: string;
    senderName?: string;
    senderEmail?: string;
    text: string;
    isDirect: boolean;
    channelJid?: string;
    channelName?: string;
    threadContext?: ZoomInboundThreadContext;
    threadStarterBody?: string;
  }) {
    // For DMs, add context prefix so the agent knows this is NOT a customer support conversation
    if (params.isDirect) {
      params.text = [
        "[ADMIN DM] This is a direct message from an authorized team member, NOT a customer support conversation.",
        "Do NOT use memory_search for customer training data. Respond as a general-purpose assistant.",
        `Message: ${params.text}`,
      ].join("\n");
    }
    await routeMessageToAgent({ deps, ...params });
  }

  async function handleTrainingFeedback(params: {
    userJid: string;
    userName?: string;
    feedback: string;
    training: import("./pending-training.js").TrainingSession;
  }) {
    const { userJid, feedback, training } = params;
    const { sendZoomTextMessage } = await import("./send.js");

    try {
      log.info("processing training feedback", { userJid, approvalRefId: training.approvalRefId });

      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: "Got it — regenerating the answer with your feedback...",
        isChannel: false,
      });

      // Build a prompt that includes the original question, previous answer, and reviewer feedback
      const trainingPrompt = [
        "[CHANNEL OBSERVE — TRAINING] A reviewer wants you to improve your previous answer.",
        "",
        `**Original question:** ${training.originalQuestion}`,
        `**Your previous answer:** ${training.previousAnswer}`,
        `**Reviewer's correction:** ${feedback}`,
        "",
        "IMPORTANT: The reviewer's correction IS the correct answer. Use their exact wording as-is.",
        "Only adjust for grammar or add minor formatting. Do NOT rewrite, add disclaimers, or change the meaning.",
        "Keep it to 1-3 sentences, conversational tone, no markdown formatting.",
      ].join("\n");

      const threading = resolveZoomThreadingConfig(zoomCfg, log);
      const route = resolveZoomAgentRoute({
        runtime: core,
        cfg,
        senderId: training.originalSenderName,
        conversationId: training.originalChannelJid,
        channelJid: training.originalChannelJid,
        isDirect: false,
        threading,
        threadContext: training.threadContext,
        log,
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: trainingPrompt,
        RawBody: feedback,
        CommandBody: trainingPrompt,
        From: `zoom:channel:${training.originalChannelJid}`,
        To: training.originalChannelJid,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "channel",
        ConversationLabel: training.originalSenderName,
        SenderName: training.originalSenderName,
        SenderId: training.originalSenderName,
        GroupSubject: training.originalChannelName,
        GroupChannel: training.originalChannelJid,
        Provider: "zoom" as const,
        Surface: "zoom" as const,
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "zoom" as const,
        OriginatingTo: training.originalChannelJid,
      });

      const collectedParts: string[] = [];
      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            if (payload.text) collectedParts.push(payload.text);
          },
          onError: (err, info) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`zoom training ${info.kind} reply failed: ${errMsg}`);
          },
        });

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });

      // Reply delivery is queued; wait until all payloads are delivered
      // before reading collectedParts.
      await dispatcher.waitForIdle();
      markDispatchIdle();

      const newAnswer = collectedParts.join("\n").trim();
      if (!newAnswer) {
        await sendZoomTextMessage({
          cfg,
          to: userJid,
          text: "Could not generate a new answer. Please try again or reject the original.",
          isChannel: false,
        });
        return;
      }

      // Store new pending approval and send updated review card
      const newRefId = storePendingApproval({
        originalChannelJid: training.originalChannelJid,
        originalChannelName: training.originalChannelName,
        originalSenderName: training.originalSenderName,
        originalQuestion: training.originalQuestion,
        proposedAnswer: newAnswer,
        agentId: training.agentId ?? route.agentId,
        threadContext: training.threadContext,
        replyMainMessageId: training.replyMainMessageId,
        sessionScopeAtCapture: training.sessionScopeAtCapture ?? threading.sessionScope,
      });

      const { sendZoomActionMessage } = await import("./send.js");
      await sendZoomActionMessage({
        cfg,
        to: training.reviewChannelJid,
        headText: "Revised Answer Review",
        body: [
          {
            type: "message",
            text: `**Channel:** ${training.originalChannelName}\n**From:** ${training.originalSenderName}\n**Question:** ${training.originalQuestion}\n\n**Previous Answer:**\n${training.previousAnswer}\n\n**Feedback:** ${feedback}\n\n**Revised Answer:**\n${newAnswer}`,
          },
          {
            type: "actions",
            items: [
              { text: "Approve", value: `approve_answer:${newRefId}`, style: "Primary" },
              { text: "Train", value: `train_answer:${newRefId}`, style: "Default" },
              { text: "Reject", value: `reject_answer:${newRefId}`, style: "Danger" },
            ],
          },
        ],
        isChannel: true,
      });

      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: "Revised answer sent to review channel for approval.",
        isChannel: false,
      });

      log.info("training feedback processed, new review card sent", { newRefId, reviewChannelJid: training.reviewChannelJid });
    } catch (err) {
      log.error("failed to process training feedback", { error: formatUnknownError(err) });
      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: "Something went wrong while regenerating the answer. Please try again.",
        isChannel: false,
      }).catch(() => {});
    }
  }

  async function routeToAgentWithObserve(params: {
    conversationId: string;
    senderId: string;
    senderName?: string;
    text: string;
    channelJid: string;
    channelName?: string;
    reviewChannelJid: string;
    threadContext?: ZoomInboundThreadContext;
    threadStarterBody?: string;
    replyMainMessageId?: string;
    isThreadReply?: boolean;
    silent?: boolean;
    mode?: ChannelMode;
    roleplay?: boolean;
    skipFilter?: boolean;
  }) {
    const {
      conversationId,
      senderId,
      senderName,
      text,
      channelJid,
      channelName,
      reviewChannelJid,
      threadContext,
      threadStarterBody,
      replyMainMessageId: explicitReplyMainMessageId,
      isThreadReply,
      silent,
      mode = "active",
      roleplay,
      skipFilter,
    } = params;
    const prefilterEnabled = isPrefilterEnabled();

    try {
      log.debug("routing to agent with observe mode", {
        conversationId,
        channelJid,
        isThreadReply,
        mode,
        roleplay,
        prefilterEnabled,
        threadId: threadContext?.threadId,
      });
      const threading = resolveZoomThreadingConfig(zoomCfg, log);
      const replyMainMessageId = resolveZoomReplyMainMessageId({
        threading,
        threadContext,
        explicitReplyMainMessageId,
      });

      // Pre-filter: classify message before sending ack.
      // Thread replies, silent/training modes, roleplay, and reviewer-allowed messages bypass the filter.
      if (prefilterEnabled && !isThreadReply && mode === "active" && !roleplay && !skipFilter) {
        const actionable = await shouldRespond(text);
        if (!actionable) {
          log.debug("prefilter blocked message, sending to review channel", { channelJid, text: text.slice(0, 80) });
          // Store and send to review channel for manual override
          const refId = storePrefilterBlock({
            conversationId, senderId, senderName, text,
            channelJid, channelName, reviewChannelJid,
            threadContext,
            threadStarterBody,
            replyMainMessageId,
            isThreadReply, silent, mode, roleplay,
          });
          const { sendZoomActionMessage } = await import("./send.js");
          await sendZoomActionMessage({
            cfg,
            to: reviewChannelJid,
            headText: "Filtered Message",
            body: [
              {
                type: "message",
                text: `**${channelName ?? channelJid}** — ${senderName ?? senderId}:\n> ${text}\n\n_Pre-filter classified this as casual/non-actionable._`,
              },
              {
                type: "actions",
                items: [
                  { text: "Allow", value: `prefilter_allow:${refId}`, style: "Primary" },
                  { text: "Dismiss", value: `prefilter_dismiss:${refId}`, style: "Default" },
                ],
              },
            ],
            isChannel: true,
          });
          return;
        }
      }

      // Immediate ack — skip in silent/training modes and roleplay (don't tip off channel)
      if (mode === "active" && !roleplay) {
        const { sendZoomTextMessage } = await import("./send.js");
        const displayName = senderName?.split("@")[0]?.split(" ")[0] ?? "there";
        await sendZoomTextMessage({
          cfg,
          to: channelJid,
          text: `Hey ${displayName}, I'm working on that for you. My response will need to be reviewed first, so hang tight!`,
          isChannel: true,
        }).catch((err) => log.warn("observe ack failed", { err: String(err) }));
      }

      const route = resolveZoomAgentRoute({
        runtime: core,
        cfg,
        senderId,
        conversationId,
        channelJid,
        isDirect: false,
        threading,
        threadContext,
        log,
      });
      const parentSessionKey = resolveParentSessionKeyForThread({
        runtime: core,
        cfg,
        senderId,
        conversationId,
        channelJid,
        isDirect: false,
        threading,
        threadContext,
        log,
        currentSessionKey: route.sessionKey,
      });
      rememberZoomSessionReplyRoot({
        sessionKey: route.sessionKey,
        threadContext,
        explicitReplyMainMessageId: replyMainMessageId,
      });

      // Register this session as observe-mode so the tool gate hook can block writes
      markSessionObserve(route.sessionKey, {
        channelJid,
        channelName: channelName ?? channelJid,
        reviewChannelJid,
        senderName: senderName ?? senderId,
        senderJid: senderId,
        agentId: route.agentId,
        question: text,
        threadContext,
        replyMainMessageId,
        sessionScopeAtCapture: threading.sessionScope,
        silent: mode === "silent",
      });

      // Channel context hint for memory_search — tells agent which customer dir to search
      const customerSlug = (channelName ?? channelJid.split("@")[0])
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      // Scope context for deterministic memory_search scoping
      const crossTraining = await getCrossChannelTraining(channelJid);
      const allowAllCustomers = crossTraining.enabled;
      // When cross-customer is enabled, exclude self + internal/test channels from results
      const excludeSlugs = allowAllCustomers
        ? [customerSlug, "test-customer", "zoomwarriors-support-channel"].filter(Boolean)
        : undefined;
      log.debug("observe scope context", { customerSlug, allowAllCustomers, excludeSlugs, redactionPolicy: crossTraining.redactionPolicy });
      const trainedAnswerCandidate = await resolveHighConfidenceTrainedAnswer({
        core,
        cfg,
        sessionKey: route.sessionKey,
        query: text,
        channelSlug: customerSlug,
        allowAllCustomers,
        excludeSlugs,
        log,
      });
      if (trainedAnswerCandidate) {
        log.info("observe mode: high-confidence trained answer candidate", {
          channelJid,
          path: trainedAnswerCandidate.path,
          score: trainedAnswerCandidate.score,
          similarity: trainedAnswerCandidate.similarity,
        });
      }
      const memoryHintLines = [
        `IMPORTANT: BEFORE answering, call memory_search with the user's question to find trained answers and customer context in memory/customers/${customerSlug}/. Trained answers from reviewers are highest priority — use them over your own knowledge.`,
        "When calling memory_search, use the user's exact message text verbatim as the query. Do NOT paraphrase into keywords.",
        "If memory_search returns a trained Q/A match, use the trained answer text instead of a generic clarifying question.",
      ];
      if (trainedAnswerCandidate) {
        memoryHintLines.push(
          "High-confidence trained Q/A match (prefetched from exact user text):",
          `Matched Q: ${trainedAnswerCandidate.question}`,
          `Required A: ${trainedAnswerCandidate.answer}`,
          "Unless the user adds contradictory details, use Required A verbatim.",
        );
      }
      const memoryHint = memoryHintLines.join("\n");

      // Thread replies are follow-ups to the bot's clarifying question — don't filter them.
      // New top-level messages get the observe wrapper to triage questions vs casual chat.
      // Roleplay messages use a customer-oriented prompt (no [NO_RESPONSE] filtering).
      const body = roleplay
        ? [
            "[CHANNEL OBSERVE — CUSTOMER MESSAGE] This is a message from an external customer.",
            "STEP 1 (MANDATORY): You MUST call memory_search with the customer's message BEFORE doing anything else. Do NOT skip this step. Do NOT output any text before calling memory_search.",
            memoryHint,
            "Also call the relevant ZW2 tools to fetch fresh data when the question involves orders, pricing, or SOW.",
            "If a write tool is blocked, do NOT retry it. Just say you cannot complete that action right now.",
            "ALWAYS respond to the customer — even if the message is vague, conversational, or not a direct question. This is a real customer; never ignore them. NEVER output [NO_RESPONSE] or NO_REPLY.",
            "Give a short, direct answer with the actual data. No filler, no preamble. Just the facts in 2-4 sentences, conversational tone.",
            `Customer (${senderName}): ${text}`,
          ].join("\n")
        : isThreadReply
        ? [
            "[CHANNEL OBSERVE — FOLLOW-UP] The user replied to your clarifying question.",
            threadStarterBody
              ? `Previous bot message in this thread: ${threadStarterBody}`
              : "Previous bot message text was unavailable.",
            memoryHint,
            "Also call the relevant ZW2 tools to fetch fresh data when the question involves orders, pricing, or SOW.",
            "If a write tool is blocked, briefly say you cannot complete that action right now.",
            "ALWAYS respond to this follow-up and interpret it in context of the previous bot message. NEVER output [NO_RESPONSE] or NO_REPLY.",
            "Give a short, direct answer with the actual data. No filler, no preamble like 'let me look that up'. Just the facts in 2-4 sentences, conversational tone.",
            `User reply: ${text}`,
          ].join("\n")
        : [
            "[CHANNEL OBSERVE MODE] A user posted a message in a channel you are monitoring.",
            "STEP 1 (MANDATORY): You MUST call memory_search with the user's message BEFORE doing anything else. Do NOT skip this step. Do NOT output ANY text before calling memory_search — not even [NO_RESPONSE].",
            memoryHint,
            "Also call the relevant ZW2 tools to fetch fresh data when the question involves orders, pricing, or SOW.",
            "Give the actual data in your response. No filler, no preamble like 'let me look that up' or 'I have data from earlier'. Just the facts.",
            "IMPORTANT: If the message contains a REQUEST or ACTION (e.g. 'looking to get an estimate', 'can you check', 'I need help with'), treat it as a question — answer it or ask a clarifying question. Do NOT classify requests as customer context.",
            "ONLY if the message is PURELY informational with no request (e.g. 'we have 500 users on Microsoft Teams'), respond with [CUSTOMER_CONTEXT] followed by each fact on its own line. Example:",
            "  [CUSTOMER_CONTEXT]",
            "  500 users",
            "  Using Microsoft Teams currently",
            prefilterEnabled
              ? "If a write tool is blocked, do NOT retry it and do NOT mention 'pending approval' in your response. Just respond with [NO_RESPONSE]."
              : "If a write tool is blocked, explain briefly that you cannot complete that action right now.",
            prefilterEnabled
              ? "ONLY after calling memory_search: if the message is NOT a question, NOT a request, AND NOT customer context (casual chat, greeting, acknowledgment, small talk), respond with exactly [NO_RESPONSE] and nothing else."
              : "ALWAYS respond to the user, including greetings and acknowledgments. For casual small talk, send one short friendly acknowledgment. NEVER output [NO_RESPONSE] or NO_REPLY.",
            "If it IS a new question or request with no matching memory_search results, respond with ONE short clarifying question (1 sentence) to narrow down what they need.",
            `User message: ${text}`,
          ].join("\n");

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: text,
        CommandBody: body,
        From: `zoom:channel:${channelJid}`,
        To: conversationId,
        SessionKey: route.sessionKey,
        ParentSessionKey: parentSessionKey,
        AccountId: route.accountId,
        ChatType: "channel",
        ConversationLabel: senderName ?? senderId,
        SenderName: senderName,
        SenderId: senderId,
        GroupSubject: channelName,
        GroupChannel: channelJid,
        Provider: "zoom" as const,
        Surface: "zoom" as const,
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "zoom" as const,
        OriginatingTo: conversationId,
        ThreadStarterBody: threadStarterBody,
        // Scoped memory search context
        ChannelSlug: customerSlug,
        IsSupport: true,
        DefaultMemoryScope: "channel",
        AllowAllCustomersMemoryScope: allowAllCustomers,
        ExcludeMemorySlugs: excludeSlugs,
      });

      // Collect reply text instead of sending it directly
      const collectedParts: string[] = [];

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            if (payload.text) {
              collectedParts.push(payload.text);
            }
          },
          onError: (err, info) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error(`zoom observe ${info.kind} reply failed: ${errMsg}`);
          },
        });

      await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });

      // Reply delivery is queued; wait until all payloads are delivered
      // before reading collectedParts.
      await dispatcher.waitForIdle();
      markDispatchIdle();

      // Check if any write tools were blocked during this dispatch
      const blockedTools = getSessionBlockedTools(route.sessionKey);
      clearSessionObserve(route.sessionKey);

      // If tools were blocked, send ONE consolidated approval card (not per-tool)
      if (blockedTools) {
        const toolLines = blockedTools.tools.map((t) => {
          const paramStr = formatToolParams(t.params);
          return `• \`${t.toolName}\`${paramStr ? ` — ${paramStr}` : ""}`;
        });

        const { sendZoomActionMessage } = await import("./send.js");
        await sendZoomActionMessage({
          cfg,
          to: reviewChannelJid,
          headText: "Action Approval Required",
          body: [
            {
              type: "message",
              text: [
                `**Channel:** ${channelName ?? channelJid}`,
                `**From:** ${senderName ?? senderId}`,
                `**Request:** ${text}`,
                "",
                `**Tools to execute:**`,
                ...toolLines,
              ].join("\n"),
            },
            {
              type: "actions",
              items: [
                { text: "Approve & Execute", value: `approve_tool:${blockedTools.refId}`, style: "Primary" },
                { text: "Reject", value: `reject_tool:${blockedTools.refId}`, style: "Danger" },
              ],
            },
          ],
          isChannel: true,
        });

        log.info("observe mode: sent consolidated tool approval card", { refId: blockedTools.refId, toolCount: blockedTools.tools.length });
        return;
      }

      // Combine all delivered text, then strip [NO_RESPONSE] tags the agent may have
      // emitted before calling tools.  Only treat as no-response if nothing meaningful
      // remains after stripping.
      const rawReply = collectedParts.join("\n").trim();
      let fullReply = rawReply.replace(/\[NO_RESPONSE\]/gi, "").trim();
      log.info("observe mode: collectedParts", { count: collectedParts.length, rawLen: rawReply.length, cleanLen: fullReply.length, snippet: fullReply.slice(0, 120) });

      // If no reply or only [NO_RESPONSE] tags remain, send to review channel for visibility
      // skipFilter=true means a reviewer already allowed this message — post it directly
      if (!skipFilter && !fullReply) {
        if (!prefilterEnabled) {
          // Classifier is disabled; keep the workflow moving with a deterministic fallback.
          fullReply = "Happy to help. What would you like me to check?";
          log.warn("observe mode: empty reply while prefilter disabled, using fallback", { channelJid });
        } else {
        log.debug("observe mode: not a question, routing to review channel", { channelJid });
        const skippedAgent = resolveAgentSpeakerName(cfg, route.agentId) ?? "Agent";
        const refId = storePrefilterBlock({
          conversationId, senderId, senderName, text,
          channelJid, channelName, reviewChannelJid,
          threadContext,
          threadStarterBody,
          replyMainMessageId,
          isThreadReply, silent, mode, roleplay,
        });
        const { sendZoomActionMessage } = await import("./send.js");
        await sendZoomActionMessage({
          cfg,
          to: reviewChannelJid,
          headText: "Agent Skipped",
          body: [
            {
              type: "message",
              text: `**${channelName ?? channelJid}** — ${senderName ?? senderId}:\n> ${text}\n\n_${skippedAgent} returned NO\\_RESPONSE (decided message was not actionable after running)._`,
            },
            {
              type: "actions",
              items: [
                { text: "Allow", value: `prefilter_allow:${refId}`, style: "Primary" },
                { text: "Dismiss", value: `prefilter_dismiss:${refId}`, style: "Default" },
              ],
            },
          ],
          isChannel: true,
        });
        return;
        }
      }

      // If the agent detected customer context/environment details, persist them
      if (fullReply.includes("[CUSTOMER_CONTEXT]")) {
        const lines = fullReply
          .split("[CUSTOMER_CONTEXT]")[1]
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        const persisted: string[] = [];
        for (const detail of lines) {
          try {
            await appendCustomerDetail({
              channelName,
              channelJid,
              detail,
              workspaceDir: resolveMemoryWorkspaceDir(route.agentId),
            });
            persisted.push(detail);
          } catch (err) {
            log.error("failed to persist customer detail", { err, detail });
          }
        }

        if (persisted.length > 0) {
          const { sendZoomTextMessage } = await import("./send.js");
          await sendZoomTextMessage({
            cfg,
            to: reviewChannelJid,
            text: `**Customer Context Captured** — ${channelName ?? channelJid}\nFrom: ${senderName ?? senderId}\n\n${persisted.map((d) => `• ${d}`).join("\n")}`,
            isChannel: true,
          });
          log.info("observe mode: persisted customer context", { channelJid, count: persisted.length });
        }
        return;
      }

      // Strip any stale tags the agent might emit (NO_RESPONSE already removed above)
      let cleanReply = fullReply
        .replace(/\[TOOLS_USED\]\s*.*/i, "")
        .replace(/\[PROPOSED_ACTION\][\s\S]*/i, "")
        .trim();

      // Deterministic guardrail: if we have a high-confidence trained answer match
      // and the model produced a generic clarification question, prefer the trained answer.
      if (trainedAnswerCandidate && isLikelyClarifyingQuestion(cleanReply)) {
        log.info("observe mode: replacing clarifying reply with trained answer", {
          channelJid,
          path: trainedAnswerCandidate.path,
          score: trainedAnswerCandidate.score,
          similarity: trainedAnswerCandidate.similarity,
        });
        cleanReply = trainedAnswerCandidate.answer;
      }

      // Optional cross-channel answer redaction
      if (cleanReply && allowAllCustomers && crossTraining.redactionPolicy === "llm") {
        try {
          const scrubResult = await scrubCrossChannelAnswer({
            answer: cleanReply,
            sourceChannelSlug: customerSlug,
            redactionPolicy: crossTraining.redactionPolicy,
            crossChannelEnabled: allowAllCustomers,
          });
          if (scrubResult.scrubbed) {
            cleanReply = scrubResult.text;
            log.info("observe mode: answer scrubbed for cross-channel redaction", { channelJid });
          }
          if (scrubResult.error) {
            log.warn("observe mode: scrub warning", { error: scrubResult.error });
          }
        } catch (scrubErr) {
          log.warn("observe mode: scrub failed (fail-open)", { error: String(scrubErr) });
        }
      }

      // If the LLM couldn't generate an answer (even after reviewer Allow), offer Train
      if (!cleanReply) {
        if (skipFilter) {
          const agentName = resolveAgentSpeakerName(cfg, route.agentId) ?? "Bot";
          const trainRefId = storePendingApproval({
            originalChannelJid: channelJid,
            originalChannelName: channelName ?? channelJid,
            originalSenderName: senderName ?? senderId,
            originalSenderJid: senderId,
            agentId: route.agentId,
            originalQuestion: text,
            proposedAnswer: "(no answer generated)",
            threadContext,
            replyMainMessageId,
            sessionScopeAtCapture: threading.sessionScope,
            silent: mode === "silent",
          });
          const { sendZoomActionMessage } = await import("./send.js");
          await sendZoomActionMessage({
            cfg,
            to: reviewChannelJid,
            headText: "Training Needed",
            body: [
              {
                type: "message",
                text: `**${channelName ?? channelJid}** — ${senderName ?? senderId}:\n> ${text}\n\n_${agentName} couldn't generate an answer. Click Train to provide the correct response._`,
              },
              {
                type: "actions",
                items: [
                  { text: "Train", value: `train_answer:${trainRefId}`, style: "Primary" },
                  { text: "Dismiss", value: `reject_answer:${trainRefId}`, style: "Default" },
                ],
              },
            ],
            isChannel: true,
          });
        }
        return;
      }

      // Store pending approval and send review card (text-only responses)
      // silent=true only for actual silent mode; training mode posts on approve
      const refId = storePendingApproval({
        originalChannelJid: channelJid,
        originalChannelName: channelName ?? channelJid,
        originalSenderName: senderName ?? senderId,
        originalSenderJid: senderId,
        agentId: route.agentId,
        originalQuestion: text,
        proposedAnswer: cleanReply,
        threadContext,
        replyMainMessageId,
        sessionScopeAtCapture: threading.sessionScope,
        silent: mode === "silent",
      });

      const { sendZoomActionMessage } = await import("./send.js");
      await sendZoomActionMessage({
        cfg,
        to: reviewChannelJid,
        headText: "Pending Answer Review",
        body: [
          {
            type: "message",
            text: `**Channel:** ${channelName ?? channelJid}\n**From:** ${senderName ?? senderId}\n**Question:** ${text}\n\n**Proposed Answer:**\n${cleanReply}`,
          },
          {
            type: "actions",
            items: [
              { text: "Approve", value: `approve_answer:${refId}`, style: "Primary" },
              { text: "Train", value: `train_answer:${refId}`, style: "Default" },
              { text: "Reject", value: `reject_answer:${refId}`, style: "Danger" },
            ],
          },
        ],
        isChannel: true,
      });

      log.info("observe mode: sent approval card to review channel", { refId, reviewChannelJid });
    } catch (err) {
      log.error("failed to route with observe mode", { error: formatUnknownError(err) });
    }
  }
}

/**
 * Route a message to the agent. Extracted so upload-handler can reuse it.
 */
export async function routeMessageToAgent(params: {
  deps: ZoomMessageHandlerDeps;
  conversationId: string;
  senderId: string;
  senderName?: string;
  senderEmail?: string;
  text: string;
  isDirect: boolean;
  channelJid?: string;
  channelName?: string;
  threadContext?: ZoomInboundThreadContext;
  threadStarterBody?: string;
  replyToMessageId?: string;
  sessionKeyOverride?: string;
  agentIdOverride?: string;
  accountIdOverride?: string;
}): Promise<void> {
  const {
    deps,
    conversationId,
    senderId,
    senderName,
    text,
    isDirect,
    channelJid,
    channelName,
    threadContext,
    threadStarterBody,
    replyToMessageId,
    sessionKeyOverride,
    agentIdOverride,
    accountIdOverride,
  } = params;
  const { cfg, log } = deps;
  const core = getZoomRuntime();
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;

  try {
    log.debug("routing to agent", {
      conversationId,
      senderId,
      isDirect,
      textLength: text.length,
    });

    const threading = resolveZoomThreadingConfig(zoomCfg, log);
    const route = resolveZoomAgentRoute({
      runtime: core,
      cfg,
      senderId,
      conversationId,
      channelJid,
      isDirect,
      threading,
      threadContext,
      log,
    });

    // For channels, read fresh config from disk to resolve speaker name.
    // The closure-captured `cfg` may be stale (e.g., after ETL mode activation).
    // We read fresh bindings to determine the correct speaker name ("ETL Bot says:"
    // vs "cwbot says:"). The session stays on the main agent — no routing change.
    let speakerName: string | undefined;
    if (!isDirect) {
      try {
        const fs = await import("node:fs");
        const configDir = process.env.OPENCLAW_STATE_DIR
          || (process.env.HOME ? `${process.env.HOME}/.openclaw` : "/home/node/.openclaw");
        const freshCfg = JSON.parse(fs.readFileSync(`${configDir}/openclaw.json`, "utf-8"));
        const freshBindings = Array.isArray(freshCfg.bindings) ? freshCfg.bindings : [];
        const binding = freshBindings.find((b: Record<string, unknown>) => {
          const m = b?.match as Record<string, unknown> | undefined;
          const p = m?.peer as Record<string, unknown> | undefined;
          return m?.channel === "zoom" && p?.kind === "channel" && p?.id === conversationId;
        });
        if (binding && typeof binding.agentId === "string") {
          const agents = Array.isArray(freshCfg.agents?.list) ? freshCfg.agents.list : [];
          const agent = agents.find((a: Record<string, unknown>) =>
            typeof a?.id === "string" && a.id.trim() === (binding.agentId as string).trim()
          );
          speakerName = typeof agent?.name === "string" ? agent.name.trim() : undefined;
        }
      } catch {
        // Fall back to stale closure config on any error
      }
    }

    const resolvedAgentId = agentIdOverride?.trim() || route.agentId;
    if (isDirect || !speakerName) {
      speakerName = resolveAgentSpeakerName(cfg, resolvedAgentId);
    }

    const resolvedAccountId = accountIdOverride?.trim() || route.accountId;
    const resolvedSessionKey = sessionKeyOverride?.trim() || route.sessionKey;
    const parentSessionKey = resolveParentSessionKeyForThread({
      runtime: core,
      cfg,
      senderId,
      conversationId,
      channelJid,
      isDirect,
      threading,
      threadContext,
      log,
      currentSessionKey: resolvedSessionKey,
    });
    const resolvedReplyToMessageId = resolveZoomReplyMainMessageId({
      threading,
      threadContext,
      explicitReplyMainMessageId: replyToMessageId,
    });
    rememberZoomSessionReplyRoot({
      sessionKey: resolvedSessionKey,
      threadContext,
      explicitReplyMainMessageId: resolvedReplyToMessageId,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: text,
      RawBody: text,
      CommandBody: text,
      From: isDirect ? `zoom:${senderId}` : `zoom:channel:${channelJid}`,
      To: conversationId,
      SessionKey: resolvedSessionKey,
      ParentSessionKey: parentSessionKey,
      AccountId: resolvedAccountId,
      ChatType: isDirect ? "direct" : "channel",
      ConversationLabel: senderName ?? senderId,
      SenderName: senderName,
      SenderId: senderId,
      GroupSubject: isDirect ? undefined : channelName,
      GroupChannel: isDirect ? undefined : channelJid,
      Provider: "zoom" as const,
      Surface: "zoom" as const,
      CommandAuthorized: true,
      CommandSource: "text" as const,
      OriginatingChannel: "zoom" as const,
      OriginatingTo: conversationId,
      ThreadStarterBody: threadStarterBody,
      // Preserve the provider message id so plugin hooks (e.g. pulsebot comfort replies)
      // can reliably thread follow-up messages to the triggering inbound message.
      MessageSid: threadContext?.incomingMessageId,
      MessageSidFull: threadContext?.incomingMessageId,
      MessageThreadId: threadContext?.threadId,
    });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, resolvedAgentId),
        deliver: async (payload) => {
          const { sendZoomTextMessage } = await import("./send.js");
          if (payload.text) {
            const payloadReplyToId =
              typeof payload.replyToId === "string" && payload.replyToId.trim().length > 0
                ? payload.replyToId.trim()
                : undefined;
            const finalReplyToMessageId = resolveZoomOutboundReplyMessageId({
              threadContext,
              resolvedReplyMainMessageId: resolvedReplyToMessageId,
              payloadReplyToId,
              payloadReplyToCurrent: payload.replyToCurrent === true,
            });
            log.debug(
              `zoom outbound reply target resolved conversationId=${conversationId} payloadReplyToId=${payloadReplyToId ?? "none"} payloadReplyToCurrent=${payload.replyToCurrent === true} threadIncomingMessageId=${threadContext?.incomingMessageId ?? "none"} resolvedReplyToMessageId=${resolvedReplyToMessageId ?? "none"} finalReplyToMessageId=${finalReplyToMessageId ?? "none"}`,
            );
            await sendZoomTextMessage({
              cfg,
              to: conversationId,
              text: payload.text,
              isChannel: !isDirect,
              replyToMessageId: finalReplyToMessageId,
              speakerName,
            });
          }
        },
        onError: (err, info) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`zoom ${info.kind} reply failed: ${errMsg}`);
        },
      });

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    // Ensure queued deliveries are flushed before marking idle/logging counts.
    await dispatcher.waitForIdle();
    markDispatchIdle();

    if (queuedFinal) {
      const finalCount = counts.final;
      log.info(`delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${conversationId}`);
    }
  } catch (err) {
    log.error("failed to route to agent", { error: formatUnknownError(err) });
  }
}

/**
 * Extract customer environment details from Q&A text.
 * Returns short factual statements suitable for a customer profile.
 */
function extractCustomerDetails(question: string, answer: string): string[] {
  const combined = `${question} ${answer}`;
  const details: string[] = [];

  // Platform / competitor mentions
  const platformMatch = combined.match(/(?:using|running|on|from|migrating from|switching from)\s+(Microsoft Teams|Cisco|RingCentral|8x8|Avaya|Vonage|Mitel|Genesys|Five9|Dialpad)/i);
  if (platformMatch) details.push(`Current/previous platform: ${platformMatch[1]}`);

  // User count
  const userCountMatch = combined.match(/(\d[\d,]*)\s*(?:users?|seats?|employees?|extensions?|agents?|lines?)/i);
  if (userCountMatch) details.push(`Approximate size: ${userCountMatch[1]} ${userCountMatch[0].replace(userCountMatch[1], "").trim()}`);

  // License type
  const licenseMatch = combined.match(/(?:on|have|using)\s+(?:the\s+)?(Pro|Business|Enterprise|Zoom\s+(?:One|Workplace|Phone)(?:\s+\w+)?)\s+(?:plan|license|tier)/i);
  if (licenseMatch) details.push(`License/plan: ${licenseMatch[1]}`);

  // Key features they care about
  const featurePatterns: [RegExp, string][] = [
    [/executive[- ]?assistant|delegation/i, "Needs executive-assistant delegation"],
    [/call\s*queue|hunt\s*group/i, "Uses call queues / hunt groups"],
    [/auto[- ]?attendant|ivr/i, "Uses auto-attendant / IVR"],
    [/common\s*area\s*phone|lobby\s*phone/i, "Has common area phones"],
    [/contact\s*center|call\s*center/i, "Has contact center needs"],
    [/international|global|multi[- ]?country|multiple\s*countries/i, "Multi-country / international deployment"],
    [/analog|ata\b|fax\s*machine/i, "Has analog/fax devices"],
    [/hot[- ]?desk/i, "Uses hot desking"],
    [/salesforce|hubspot|crm/i, "CRM integration required"],
    [/sso|saml|okta|azure\s*ad/i, "Uses SSO / identity provider"],
    [/recording|compliance/i, "Call recording / compliance needs"],
    [/e911|emergency\s*(?:calling|services)/i, "E911 requirements"],
  ];

  for (const [re, label] of featurePatterns) {
    if (re.test(combined)) details.push(label);
  }

  return details;
}
