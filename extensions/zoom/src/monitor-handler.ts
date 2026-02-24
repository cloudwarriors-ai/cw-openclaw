import type { OpenClawConfig, RuntimeEnv, GroupPolicy } from "openclaw/plugin-sdk";
import type { ZoomConversationStore } from "./conversation-store.js";
import type { ZoomMonitorLogger } from "./monitor-types.js";
import type { ZoomConfig, ZoomCredentials, ZoomWebhookEvent } from "./types.js";
import { persistApprovedQA, appendCustomerDetail, loadChannelTraining } from "./channel-memory.js";
import { formatUnknownError } from "./errors.js";
import {
  getDynamicObservePolicy,
  enableObserveChannel,
  toggleObserveChannel,
  setReviewChannel,
} from "./observe-config.js";
import {
  getPendingApproval,
  peekPendingApproval,
  storePendingApproval,
} from "./pending-approvals.js";
import { getPendingShare } from "./pending-shares.js";
import { consumeTrainingSession, storeTrainingSession } from "./pending-training.js";
import {
  isZoomGroupAllowed,
  resolveZoomAllowlistMatch,
  resolveZoomObservePolicy,
  resolveZoomReplyPolicy,
  resolveZoomRouteConfig,
} from "./policy.js";
import { getZoomRuntime } from "./runtime.js";
import { createUploadToken } from "./upload-tokens.js";
import { zoomApiFetch } from "./api.js";

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
function extractBotMention(params: { text: string; botJid: string; robotJidInPayload?: string }): {
  mentioned: boolean;
  cleanText: string;
} {
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
function parseObserveCommand(text: string): "observe" | "set-review-channel" | null {
  const cleaned = text.replace(/@\S+/g, "").trim().toLowerCase();
  if (cleaned === "/observe" || cleaned === "observe") {
    return "observe";
  }
  if (cleaned === "/set-review-channel" || cleaned === "set-review-channel") {
    return "set-review-channel";
  }
  return null;
}

function buildPairingMeta(params: {
  userName?: string;
  userEmail?: string;
}): Record<string, string> | undefined {
  const meta: Record<string, string> = {};
  if (params.userName) {
    meta.name = params.userName;
  }
  if (params.userEmail) {
    meta.email = params.userEmail;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEmailLike(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function extractZoomUserIdFromJid(value: string | undefined): string | undefined {
  const trimmed = asOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  const suffix = "@xmpp.zoom.us";
  if (!lower.endsWith(suffix)) {
    return undefined;
  }
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0) {
    return undefined;
  }
  return trimmed.slice(0, atIndex);
}

function normalizeZoomLookupId(value: unknown): string | undefined {
  const trimmed = asOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const fromJid = extractZoomUserIdFromJid(trimmed);
  if (fromJid) {
    return fromJid;
  }
  if (isEmailLike(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function toUniqueIds(values: Array<string | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

type ZoomUserRecord = {
  id?: string;
  email?: string;
};

type ZoomUsersListResponse = {
  users?: ZoomUserRecord[];
  next_page_token?: string;
};

const ZOOM_USER_EMAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const ZOOM_REPORT_TOKEN_EXPIRY_BUFFER_MS = 60_000;
const ZOOM_REPORT_TOKEN_DEFAULT_TTL_MS = 55 * 60_000;
const ZOOM_USERS_LIST_PAGE_SIZE = 300;
const ZOOM_USERS_LIST_MAX_PAGES = 10;

type ZoomReportCredentials = {
  clientId: string;
  clientSecret: string;
  accountId: string;
};

function resolveZoomReportCredentials(defaultAccountId: string): ZoomReportCredentials | undefined {
  const clientId = asOptionalString(process.env.ZOOM_REPORT_CLIENT_ID);
  const clientSecret = asOptionalString(process.env.ZOOM_REPORT_CLIENT_SECRET);
  const accountId =
    asOptionalString(process.env.ZOOM_REPORT_ACCOUNT_ID) ?? asOptionalString(defaultAccountId);
  if (!clientId || !clientSecret || !accountId) {
    return undefined;
  }
  return { clientId, clientSecret, accountId };
}

function logEmailResolution(params: {
  log: ZoomMonitorLogger;
  eventType: string;
  route: "bot_notification" | "channel_message" | "dm_message";
  selectedEmail?: string;
  candidates: Record<string, string | undefined>;
  senderId?: string;
  senderName?: string;
}): void {
  const presentCandidates = Object.entries(params.candidates)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`);
  const candidatesSummary = presentCandidates.length > 0 ? presentCandidates.join("|") : "-";
  const senderId = params.senderId ?? "-";
  const senderName = params.senderName ?? "-";
  const selectedEmail = params.selectedEmail ?? "-";

  params.log.info(
    `zoom sender email resolution route=${params.route} event=${params.eventType} senderId=${senderId} senderName=${senderName} selectedEmail=${selectedEmail} candidates=${candidatesSummary}`,
  );

  if (!params.selectedEmail) {
    params.log.warn(
      `zoom sender email missing after payload extraction route=${params.route} event=${params.eventType} senderId=${senderId} senderName=${senderName} candidates=${candidatesSummary}`,
    );
  }
}

export function createZoomMessageHandler(deps: ZoomMessageHandlerDeps) {
  const { cfg, creds, conversationStore, log } = deps;
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  const core = getZoomRuntime();
  const emailLookupCache = new Map<string, { email?: string; expiresAt: number }>();
  const reportCredentials = resolveZoomReportCredentials(creds.accountId);
  let reportAccessTokenCache: { token: string; expiresAt: number } | undefined;
  let warnedClientCredentialsUsersApiUnsupported = false;
  let warnedMissingReportCredentials = false;

  function getCacheLookupKeys(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    const lower = trimmed.toLowerCase();
    if (lower === trimmed) {
      return [trimmed];
    }
    return [trimmed, lower];
  }

  function hasCachedLookupId(lookupId: string): boolean {
    const keys = getCacheLookupKeys(lookupId);
    return keys.some((key) => emailLookupCache.has(key));
  }

  function readCachedEmail(lookupId: string): string | undefined {
    for (const key of getCacheLookupKeys(lookupId)) {
      const cached = emailLookupCache.get(key);
      if (!cached) {
        continue;
      }
      if (cached.expiresAt <= Date.now()) {
        emailLookupCache.delete(key);
        continue;
      }
      return cached.email;
    }
    return undefined;
  }

  function writeCachedEmail(lookupId: string, email?: string): void {
    const entry = {
      email,
      expiresAt: Date.now() + ZOOM_USER_EMAIL_CACHE_TTL_MS,
    };
    for (const key of getCacheLookupKeys(lookupId)) {
      emailLookupCache.set(key, entry);
    }
  }

  async function getZoomReportAccessToken(forceRefresh = false): Promise<string | undefined> {
    if (!reportCredentials) {
      if (!warnedMissingReportCredentials) {
        warnedMissingReportCredentials = true;
        log.warn(
          "zoom sender email lookup requires report app credentials when webhook payload omits email",
          {
            missingEnv: ["ZOOM_REPORT_CLIENT_ID", "ZOOM_REPORT_CLIENT_SECRET"],
          },
        );
      }
      return undefined;
    }

    if (!forceRefresh && reportAccessTokenCache && reportAccessTokenCache.expiresAt > Date.now()) {
      return reportAccessTokenCache.token;
    }

    try {
      const basic = Buffer.from(
        `${reportCredentials.clientId}:${reportCredentials.clientSecret}`,
      ).toString("base64");
      const tokenUrl =
        `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=` +
        `${encodeURIComponent(reportCredentials.accountId)}`;
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}` },
      });
      const bodyText = await response.text();
      if (!response.ok) {
        log.warn("zoom report token fetch failed", {
          status: response.status,
          body: bodyText.slice(0, 240),
        });
        return undefined;
      }
      const parsed = JSON.parse(bodyText) as { access_token?: string; expires_in?: number };
      const token = asOptionalString(parsed.access_token);
      if (!token) {
        log.warn("zoom report token response missing access_token");
        return undefined;
      }
      const expiresInMs = Math.max(
        0,
        (Number(parsed.expires_in) > 0 ? Number(parsed.expires_in) * 1000 : ZOOM_REPORT_TOKEN_DEFAULT_TTL_MS) -
          ZOOM_REPORT_TOKEN_EXPIRY_BUFFER_MS,
      );
      reportAccessTokenCache = {
        token,
        expiresAt: Date.now() + expiresInMs,
      };
      return token;
    } catch (err) {
      log.warn("zoom report token fetch failed", {
        error: formatUnknownError(err),
      });
      return undefined;
    }
  }

  async function resolveSenderEmailFromZoomReportApi(params: {
    lookupIds: string[];
    eventType: string;
    route: "bot_notification" | "channel_message" | "dm_message";
    senderId?: string;
    senderName?: string;
  }): Promise<string | undefined> {
    if (params.lookupIds.length === 0) {
      return undefined;
    }
    let token = await getZoomReportAccessToken(false);
    if (!token) {
      return undefined;
    }
    for (const lookupId of params.lookupIds) {
      let attemptedRefresh = false;
      // Retry once with a refreshed token on 401.
      for (;;) {
        try {
          const response = await fetch(
            `https://api.zoom.us/v2/users/${encodeURIComponent(lookupId)}`,
            {
              headers: { Authorization: `Bearer ${token}` },
            },
          );
          const bodyText = await response.text();
          if (response.status === 401 && !attemptedRefresh) {
            attemptedRefresh = true;
            reportAccessTokenCache = undefined;
            token = await getZoomReportAccessToken(true);
            if (!token) {
              break;
            }
            continue;
          }
          if (!response.ok) {
            log.debug("zoom sender email report users API lookup returned non-ok", {
              eventType: params.eventType,
              route: params.route,
              senderId: params.senderId,
              senderName: params.senderName,
              lookupId,
              status: response.status,
              error: bodyText.slice(0, 220),
            });
            break;
          }
          const parsed = JSON.parse(bodyText) as ZoomUserRecord;
          const resolvedEmail = asOptionalString(parsed.email);
          if (resolvedEmail) {
            log.info("zoom sender email resolved via report users API", {
              eventType: params.eventType,
              route: params.route,
              senderId: params.senderId,
              senderName: params.senderName,
              lookupId,
              resolvedEmail,
            });
            return resolvedEmail;
          }
          break;
        } catch (err) {
          log.debug("zoom sender email report users API lookup failed", {
            eventType: params.eventType,
            route: params.route,
            senderId: params.senderId,
            senderName: params.senderName,
            lookupId,
            error: formatUnknownError(err),
          });
          break;
        }
      }
    }
    return undefined;
  }

  async function resolveSenderEmailFromZoomApi(params: {
    lookupIds: string[];
    eventType: string;
    route: "bot_notification" | "channel_message" | "dm_message";
    senderId?: string;
    senderName?: string;
  }): Promise<string | undefined> {
    const pendingLookupIds: string[] = [];
    for (const lookupId of params.lookupIds) {
      const cached = readCachedEmail(lookupId);
      if (cached) {
        return cached;
      }
      if (cached === undefined && hasCachedLookupId(lookupId)) {
        continue;
      }
      pendingLookupIds.push(lookupId);
    }
    if (pendingLookupIds.length === 0) {
      return undefined;
    }

    const pendingLookupIdsLower = new Set(pendingLookupIds.map((value) => value.toLowerCase()));

    const resolveSenderEmailFromZoomUsersListApi = async (): Promise<string | undefined> => {
      let nextPageToken: string | undefined;
      for (let page = 0; page < ZOOM_USERS_LIST_MAX_PAGES; page++) {
        const query = new URLSearchParams({
          status: "active",
          page_size: String(ZOOM_USERS_LIST_PAGE_SIZE),
        });
        if (nextPageToken) {
          query.set("next_page_token", nextPageToken);
        }

        const response = await zoomApiFetch<ZoomUsersListResponse>(creds, `/users?${query}`);
        if (!response.ok) {
          const errorText = response.error ?? "";
          const unsupportedClientCredentials =
            response.status === 401 && /client credentials/i.test(errorText);
          if (unsupportedClientCredentials && !warnedClientCredentialsUsersApiUnsupported) {
            warnedClientCredentialsUsersApiUnsupported = true;
            log.warn("zoom users API lookup is not available for client_credentials tokens", {
              eventType: params.eventType,
              route: params.route,
              senderId: params.senderId,
              senderName: params.senderName,
              hint: "configure ZOOM_REPORT_CLIENT_ID/ZOOM_REPORT_CLIENT_SECRET for account_credentials lookup",
            });
          }
          if (!unsupportedClientCredentials) {
            log.debug("zoom sender email users list API lookup returned non-ok", {
              eventType: params.eventType,
              route: params.route,
              senderId: params.senderId,
              senderName: params.senderName,
              status: response.status,
              error: errorText.slice(0, 220),
            });
          }
          return undefined;
        }

        const users = Array.isArray(response.data?.users) ? response.data.users : [];
        for (const user of users) {
          const userId = asOptionalString(user.id);
          const userEmail = asOptionalString(user.email);
          if (userId) {
            writeCachedEmail(userId, userEmail);
          }
          if (!userId || !userEmail) {
            continue;
          }
          if (!pendingLookupIdsLower.has(userId.toLowerCase())) {
            continue;
          }
          log.info("zoom sender email resolved via users list API", {
            eventType: params.eventType,
            route: params.route,
            senderId: params.senderId,
            senderName: params.senderName,
            lookupId: userId,
            resolvedEmail: userEmail,
          });
          return userEmail;
        }

        nextPageToken = asOptionalString(response.data?.next_page_token);
        if (!nextPageToken) {
          break;
        }
      }

      return undefined;
    };

    let shouldAttemptReportLookup = false;
    for (const lookupId of pendingLookupIds) {
      try {
        const response = await zoomApiFetch<ZoomUserRecord>(
          creds,
          `/users/${encodeURIComponent(lookupId)}`,
        );
        if (!response.ok) {
          const errorText = response.error ?? "";
          const unsupportedClientCredentials =
            response.status === 401 && /client credentials/i.test(errorText);
          shouldAttemptReportLookup = true;
          if (unsupportedClientCredentials && !warnedClientCredentialsUsersApiUnsupported) {
            warnedClientCredentialsUsersApiUnsupported = true;
            log.warn("zoom users API lookup is not available for client_credentials tokens", {
              eventType: params.eventType,
              route: params.route,
              senderId: params.senderId,
              senderName: params.senderName,
              hint: "configure ZOOM_REPORT_CLIENT_ID/ZOOM_REPORT_CLIENT_SECRET for account_credentials lookup",
            });
          }
          if (unsupportedClientCredentials) {
          } else {
            log.debug("zoom sender email users API lookup returned non-ok", {
              eventType: params.eventType,
              route: params.route,
              senderId: params.senderId,
              senderName: params.senderName,
              lookupId,
              status: response.status,
              error: errorText.slice(0, 220),
            });
          }
          continue;
        }
        const resolvedEmail = asOptionalString(response.data?.email);
        if (resolvedEmail) {
          writeCachedEmail(lookupId, resolvedEmail);
          log.info("zoom sender email resolved via users API", {
            eventType: params.eventType,
            route: params.route,
            senderId: params.senderId,
            senderName: params.senderName,
            lookupId,
            resolvedEmail,
          });
          return resolvedEmail;
        }
      } catch (err) {
        log.debug("zoom sender email users API lookup failed", {
          eventType: params.eventType,
          route: params.route,
          senderId: params.senderId,
          senderName: params.senderName,
          lookupId,
          error: formatUnknownError(err),
        });
      }
    }

    const resolvedViaUsersList = await resolveSenderEmailFromZoomUsersListApi();
    if (resolvedViaUsersList) {
      for (const lookupId of pendingLookupIds) {
        writeCachedEmail(lookupId, resolvedViaUsersList);
      }
      return resolvedViaUsersList;
    }

    if (shouldAttemptReportLookup) {
      const resolvedViaReport = await resolveSenderEmailFromZoomReportApi({
        ...params,
        lookupIds: pendingLookupIds,
      });
      if (resolvedViaReport) {
        for (const lookupId of pendingLookupIds) {
          writeCachedEmail(lookupId, resolvedViaReport);
        }
        return resolvedViaReport;
      }
    }

    for (const lookupId of pendingLookupIds) {
      writeCachedEmail(lookupId);
    }
    return undefined;
  }

  async function resolveSenderEmail(params: {
    directEmail?: string;
    userJid?: string;
    senderId?: string;
    lookupIds: string[];
    eventType: string;
    route: "bot_notification" | "channel_message" | "dm_message";
    senderName?: string;
  }): Promise<{ email?: string; source: "direct" | "store" | "api" | "none"; usedLookupId?: string }> {
    if (isEmailLike(params.directEmail)) {
      return { email: params.directEmail, source: "direct" };
    }

    const storeKeys = toUniqueIds([
      asOptionalString(params.userJid),
      asOptionalString(params.senderId),
    ]);

    for (const storeKey of storeKeys) {
      try {
        const existing = await conversationStore.findByUserJid(storeKey);
        const storedEmail = asOptionalString(existing?.reference.userEmail);
        if (isEmailLike(storedEmail)) {
          return { email: storedEmail, source: "store" };
        }
      } catch {
        // Ignore store read errors and continue to API lookup.
      }
    }

    const normalizedLookupIds = toUniqueIds(
      params.lookupIds.map((value) => normalizeZoomLookupId(value)),
    );
    if (normalizedLookupIds.length === 0) {
      return { source: "none" };
    }

    const resolvedEmail = await resolveSenderEmailFromZoomApi({
      lookupIds: normalizedLookupIds,
      eventType: params.eventType,
      route: params.route,
      senderId: params.senderId,
      senderName: params.senderName,
    });

    if (resolvedEmail) {
      return { email: resolvedEmail, source: "api" };
    }

    return { source: "none" };
  }

  return async (event: ZoomWebhookEvent) => {
    const eventType = event.event;

    log.info(`webhook event received: ${eventType}`, {
      event: eventType,
      payload: JSON.stringify(event.payload).slice(0, 500),
    });

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
    if (
      eventType === "chat_message.posted" ||
      eventType === "team_chat.app_mention" ||
      eventType === "team_chat.channel_message_posted"
    ) {
      if (eventType === "team_chat.channel_message_posted") {
        log.info(`team_chat payload: ${JSON.stringify(event.payload)}`);
      }
      await handleChannelMessage(event);
      return;
    }

    if (eventType === "team_chat.dm_message_posted") {
      await handleTeamChatDirectMessage(event);
      return;
    }

    // Handle bot added to a channel — auto-enable observe mode
    if (
      eventType === "team_chat.app_conversation_opened" ||
      eventType === "team_chat.app_invited"
    ) {
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

    const eventPayload = event.payload as Record<string, unknown>;
    const payloadRecord = payload as Record<string, unknown>;
    const userJid = payload.userJid ?? payload.user_jid ?? payload.operator;
    const userName = payload.userName ?? payload.user_name ?? payload.operator;

    const directUserEmail = asOptionalString(payload.user_email ?? payload.userEmail);
    const resolvedUserEmail = await resolveSenderEmail({
      directEmail: directUserEmail,
      userJid: asOptionalString(userJid),
      senderId: asOptionalString(userJid),
      lookupIds: [
        asOptionalString(payloadRecord.user_id),
        asOptionalString(payloadRecord.userId),
        asOptionalString(payloadRecord.user_member_id),
        asOptionalString(payloadRecord.userMemberId),
        asOptionalString(eventPayload.user_id),
        asOptionalString(eventPayload.userId),
        asOptionalString(eventPayload.user_member_id),
        asOptionalString(eventPayload.userMemberId),
        asOptionalString(userJid),
      ],
      eventType: event.event,
      route: "bot_notification",
      senderName: asOptionalString(userName),
    });
    const userEmail = resolvedUserEmail.email;
    const lookupUserIdFromJid = extractZoomUserIdFromJid(asOptionalString(userJid));
    const userEmailCandidates = {
      payload_user_email: asOptionalString(payloadRecord.user_email),
      payload_userEmail: asOptionalString(payloadRecord.userEmail),
      payload_operator_email: asOptionalString(payloadRecord.operator_email),
      payload_operatorEmail: asOptionalString(payloadRecord.operatorEmail),
      event_user_email: asOptionalString(eventPayload.user_email),
      event_userEmail: asOptionalString(eventPayload.userEmail),
      event_operator_email: asOptionalString(eventPayload.operator_email),
      event_operatorEmail: asOptionalString(eventPayload.operatorEmail),
      lookup_user_id: asOptionalString(payloadRecord.user_id),
      lookup_userId: asOptionalString(payloadRecord.userId),
      lookup_user_member_id: asOptionalString(payloadRecord.user_member_id),
      lookup_userMemberId: asOptionalString(payloadRecord.userMemberId),
      event_user_id: asOptionalString(eventPayload.user_id),
      event_userId: asOptionalString(eventPayload.userId),
      event_user_member_id: asOptionalString(eventPayload.user_member_id),
      event_userMemberId: asOptionalString(eventPayload.userMemberId),
      lookup_from_jid: lookupUserIdFromJid,
      resolved_source: resolvedUserEmail.source,
    };

    logEmailResolution({
      log,
      eventType: event.event,
      route: "bot_notification",
      selectedEmail: userEmail,
      candidates: userEmailCandidates,
      senderId: userJid,
      senderName: userName,
    });

    const toJid = payload.toJid ?? payload.to_jid;
    const channelName = payload.channelName ?? payload.channel_name;
    // For bot notifications, text comes from payload.text or payload.cmd
    const messageText = payload.text ?? payload.cmd ?? "";

    if (!userJid || !messageText) {
      log.debug("bot_notification missing required fields", {
        userJid,
        hasMessage: Boolean(messageText),
      });
      return;
    }

    // Detect if this is a channel message (toJid contains @conference.)
    const isChannelMessage = toJid?.includes("@conference.") ?? false;

    log.debug("processing bot notification", {
      userJid,
      userName,
      toJid,
      isChannelMessage,
      textLength: messageText.length,
    });

    if (isChannelMessage) {
      // Channel message - check group policy
      const groupPolicy: GroupPolicy = zoomCfg?.groupPolicy ?? "allowlist";
      const groupAllowFrom = zoomCfg?.groupAllowFrom ?? [];

      if (groupPolicy === "disabled") {
        log.debug("group policy disabled, ignoring channel message");
        return;
      }

      if (
        !isZoomGroupAllowed({
          groupPolicy,
          allowFrom: groupAllowFrom,
          senderId: userJid,
          senderName: userName,
          senderEmail: userEmail,
        })
      ) {
        log.debug("sender not allowed in group", { userJid, userName, groupPolicy });
        return;
      }

      // Handle observe mode slash commands
      const botNotifCmd = parseObserveCommand(messageText);
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

      // Store channel conversation reference
      await conversationStore.upsert(toJid, {
        channelJid: toJid,
        channelName,
        robotJid: creds.botJid,
        accountId: creds.accountId,
        conversationType: "channel",
      });

      // Route to agent with channel context
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
      // Direct message - check DM policy
      const dmPolicy = zoomCfg?.dmPolicy ?? "pairing";
      const allowFrom = zoomCfg?.allowFrom ?? [];
      const storedAllowFrom =
        dmPolicy !== "open"
          ? await core.channel.pairing.readAllowFromStore("zoom").catch(() => [])
          : [];
      const effectiveAllowFrom = [...allowFrom.map((entry) => String(entry)), ...storedAllowFrom];

      if (dmPolicy === "disabled") {
        log.debug("dm policy disabled, ignoring message");
        return;
      }

      if (dmPolicy !== "open") {
        const match = resolveZoomAllowlistMatch({
          allowFrom: effectiveAllowFrom,
          senderId: userJid,
          senderName: userName,
          senderEmail: userEmail,
        });

        if (!match.allowed) {
          if (dmPolicy === "pairing") {
            const { code, created } = await core.channel.pairing.upsertPairingRequest({
              channel: "zoom",
              id: userJid,
              meta: buildPairingMeta({ userName, userEmail }),
            });
            if (created) {
              const pairingReply = core.channel.pairing.buildPairingReply({
                channel: "zoom",
                idLine: `Your Zoom user id: ${userJid}`,
                code,
              });
              try {
                const { sendZoomTextMessage } = await import("./send.js");
                await sendZoomTextMessage({
                  cfg,
                  to: userJid,
                  text: pairingReply,
                  isChannel: false,
                });
              } catch (err) {
                log.debug("failed to send pairing reply", {
                  userJid,
                  error: formatUnknownError(err),
                });
              }
            }
          }
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

      // Check if this DM is feedback for an active training session
      const training = consumeTrainingSession(userJid);
      if (training) {
        await handleTrainingFeedback({ userJid, userName, feedback: messageText, training });
        return;
      }

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

  async function handleTeamChatDirectMessage(event: ZoomWebhookEvent) {
    const payload = event.payload?.object ?? event.payload;
    if (!payload) {
      log.debug("team_chat dm message missing payload object");
      return;
    }

    const eventPayload = event.payload as Record<string, unknown>;
    const payloadRecord = payload as Record<string, unknown>;
    const operator = asOptionalString(eventPayload.operator);
    const operatorEmail =
      asOptionalString(eventPayload.operator_email) ?? asOptionalString(eventPayload.operatorEmail);
    const senderId =
      asOptionalString(eventPayload.operator_id) ??
      asOptionalString(eventPayload.operator_member_id) ??
      operator;
    const senderName = operator;
    const resolvedSenderEmail = await resolveSenderEmail({
      directEmail: operatorEmail ?? (isEmailLike(operator) ? operator : undefined),
      senderId,
      lookupIds: [
        asOptionalString(eventPayload.operator_id),
        asOptionalString(eventPayload.operator_member_id),
        operatorEmail,
        operator,
        senderId,
      ],
      eventType: event.event,
      route: "dm_message",
      senderName,
    });
    const senderEmail = resolvedSenderEmail.email;
    const lookupUserIdFromSender = extractZoomUserIdFromJid(asOptionalString(senderId));
    const senderEmailCandidates = {
      event_operator: operator,
      event_operator_email: operatorEmail,
      event_operator_id: asOptionalString(eventPayload.operator_id),
      event_operator_member_id: asOptionalString(eventPayload.operator_member_id),
      lookup_from_sender_id: lookupUserIdFromSender,
      resolved_source: resolvedSenderEmail.source,
    };
    logEmailResolution({
      log,
      eventType: event.event,
      route: "dm_message",
      selectedEmail: senderEmail,
      candidates: senderEmailCandidates,
      senderId,
      senderName,
    });
    const messageText = asOptionalString(payloadRecord.message) ?? "";
    const messageId = asOptionalString(payloadRecord.message_id);

    if (!senderId || !messageText) {
      log.debug("team_chat dm message missing required fields", {
        hasSender: Boolean(senderId),
        hasMessage: Boolean(messageText),
      });
      return;
    }

    log.debug("processing team_chat dm message", {
      senderId,
      senderName,
      textLength: messageText.length,
    });

    const dmPolicy = zoomCfg?.dmPolicy ?? "pairing";
    const allowFrom = zoomCfg?.allowFrom ?? [];
    const storedAllowFrom =
      dmPolicy !== "open" ? await core.channel.pairing.readAllowFromStore("zoom").catch(() => []) : [];
    const effectiveAllowFrom = [...allowFrom.map((entry) => String(entry)), ...storedAllowFrom];

    if (dmPolicy === "disabled") {
      log.debug("dm policy disabled, ignoring team_chat dm message");
      return;
    }

    if (dmPolicy !== "open") {
      const match = resolveZoomAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        senderId,
        senderName,
        senderEmail,
      });

      if (!match.allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "zoom",
            id: senderId,
            meta: buildPairingMeta({ userName: senderName, userEmail: senderEmail }),
          });
          if (created) {
            const pairingReply = core.channel.pairing.buildPairingReply({
              channel: "zoom",
              idLine: `Your Zoom user id: ${senderId}`,
              code,
            });
            try {
              const { sendZoomTextMessage } = await import("./send.js");
              await sendZoomTextMessage({
                cfg,
                to: senderId,
                text: pairingReply,
                isChannel: false,
              });
            } catch (err) {
              log.debug("failed to send pairing reply", {
                senderId,
                error: formatUnknownError(err),
              });
            }
          }
        }
        log.debug("sender not in allowlist for team_chat dm message", { senderId, senderName });
        return;
      }
    }

    await conversationStore.upsert(senderId, {
      userJid: senderId,
      userName: senderName,
      userEmail: senderEmail,
      robotJid: creds.botJid,
      accountId: creds.accountId,
      conversationType: "direct",
      lastMessageId: messageId,
    });

    const training = consumeTrainingSession(senderId);
    if (training) {
      await handleTrainingFeedback({
        userJid: senderId,
        userName: senderName,
        feedback: messageText,
        training,
      });
      return;
    }

    await routeToAgent({
      conversationId: senderId,
      senderId,
      senderName,
      senderEmail,
      text: messageText,
      isDirect: true,
    });
  }

  async function handleButtonAction(
    payload: NonNullable<ZoomWebhookEvent["payload"]["object"]>,
    actionItem: { text?: string; value?: string },
  ) {
    const userJid = payload.userJid ?? payload.user_jid ?? payload.operator;
    const userName = payload.userName ?? payload.user_name ?? payload.operator;
    const userEmail = payload.user_email ?? payload.userEmail;
    const value = actionItem.value ?? "";

    if (!userJid) {
      log.debug("button action missing userJid");
      return;
    }

    log.info("handling button action", { userJid, value: value.slice(0, 80) });

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

      // Post the approved answer to the original channel
      await sendZoomTextMessage({
        cfg,
        to: pending.originalChannelJid,
        text: pending.proposedAnswer,
        isChannel: true,
      });

      // Persist Q&A + customer context to channel memory
      try {
        await persistApprovedQA({
          channelName: pending.originalChannelName,
          channelJid: pending.originalChannelJid,
          senderName: pending.originalSenderName,
          question: pending.originalQuestion,
          answer: pending.proposedAnswer,
        });
        // Extract customer environment details and add to profile
        const details = extractCustomerDetails(pending.originalQuestion, pending.proposedAnswer);
        for (const detail of details) {
          await appendCustomerDetail({
            channelName: pending.originalChannelName,
            channelJid: pending.originalChannelJid,
            detail,
          });
        }
      } catch (err) {
        log.error("failed to persist approved Q&A to memory", { err });
      }

      // Confirm to reviewer via DM
      await sendZoomTextMessage({
        cfg,
        to: userJid,
        text: `Answer approved and posted to ${pending.originalChannelName}.`,
        isChannel: false,
      });
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
      const routeConfig = resolveZoomRouteConfig({
        cfg: zoomCfg,
        channelJid: pending.originalChannelJid,
        channelName: pending.originalChannelName,
      });
      const staticObserve = resolveZoomObservePolicy({ channelConfig: routeConfig.channelConfig });
      const dynamicObserve = await getDynamicObservePolicy(pending.originalChannelJid);
      const reviewChannelJid =
        staticObserve.reviewChannelJid ?? dynamicObserve.reviewChannelJid ?? "";

      storeTrainingSession(userJid, {
        approvalRefId: refId,
        originalChannelJid: pending.originalChannelJid,
        originalChannelName: pending.originalChannelName,
        originalSenderName: pending.originalSenderName,
        originalQuestion: pending.originalQuestion,
        previousAnswer: pending.proposedAnswer,
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

    // Support chat_message.posted, team_chat.channel_message_posted, and team_chat.app_mention formats.
    const isTeamChatEvent =
      event.event === "team_chat.channel_message_posted" || event.event === "team_chat.app_mention";
    const rawChannelId = payload.channel_jid ?? (payload as Record<string, unknown>).channel_id;
    const channelJid = rawChannelId
      ? String(rawChannelId).includes("@")
        ? String(rawChannelId)
        : `${rawChannelId}@conference.xmpp.zoom.us`
      : undefined;
    const channelName = payload.channel_name;

    // team_chat format: message is a string directly on object, sender is in event.payload
    const eventPayload = event.payload as Record<string, unknown>;
    const message = isTeamChatEvent ? undefined : payload.message;
    const senderId = isTeamChatEvent
      ? (eventPayload.operator_id as string) ||
        (eventPayload.operator_member_id as string) ||
        (eventPayload.operator as string) ||
        undefined
      : (message?.sender ?? message?.sender_member_id);
    const teamOperator = asOptionalString(eventPayload.operator);
    const senderName = isTeamChatEvent ? teamOperator : message?.sender_display_name;
    const messageSenderEmail = asOptionalString(message?.sender_email);
    const resolvedSenderEmail = await resolveSenderEmail({
      directEmail: isTeamChatEvent
        ? (isEmailLike(teamOperator) ? teamOperator : undefined)
        : messageSenderEmail,
      senderId: asOptionalString(senderId),
      lookupIds: isTeamChatEvent
        ? [
            asOptionalString(eventPayload.operator_id),
            asOptionalString(eventPayload.operator_member_id),
            teamOperator,
            asOptionalString(senderId),
          ]
        : [
            asOptionalString(message?.sender_member_id),
            asOptionalString(message?.sender),
            asOptionalString(senderId),
          ],
      eventType: event.event,
      route: "channel_message",
      senderName,
    });
    const senderEmail = resolvedSenderEmail.email;
    const lookupUserIdFromSender = extractZoomUserIdFromJid(asOptionalString(senderId));
    const senderEmailCandidates = isTeamChatEvent
      ? {
          event_operator: teamOperator,
          event_operator_id: asOptionalString(eventPayload.operator_id),
          event_operator_member_id: asOptionalString(eventPayload.operator_member_id),
          lookup_from_sender_id: lookupUserIdFromSender,
          resolved_source: resolvedSenderEmail.source,
        }
      : {
          message_sender_email: messageSenderEmail,
          message_sender: asOptionalString(message?.sender),
          message_sender_member_id: asOptionalString(message?.sender_member_id),
          lookup_from_sender_id: lookupUserIdFromSender,
          resolved_source: resolvedSenderEmail.source,
        };
    logEmailResolution({
      log,
      eventType: event.event,
      route: "channel_message",
      selectedEmail: senderEmail,
      candidates: senderEmailCandidates,
      senderId,
      senderName,
    });
    const robotJidInPayload = isTeamChatEvent
      ? undefined
      : (message?.robot_jid ?? payload.robot_jid);
    const messageText = isTeamChatEvent
      ? asOptionalString((payload as Record<string, unknown>).message) ?? ""
      : (message?.message ?? "");
    const messageId = isTeamChatEvent
      ? ((payload as Record<string, unknown>).message_id as string | undefined)
      : message?.id;
    const replyMainMessageId = isTeamChatEvent
      ? ((payload as Record<string, unknown>).reply_main_message_id as string | undefined)
      : message?.reply_main_message_id;

    if (!channelJid || !senderId || !messageText) {
      log.debug("channel message missing required fields", {
        hasChannel: Boolean(channelJid),
        hasSender: Boolean(senderId),
        hasMessage: Boolean(messageText),
      });
      return;
    }

    log.debug("processing channel message", {
      channelJid,
      channelName,
      senderId,
      textLength: messageText.length,
    });

    // Handle observe mode slash commands (before group policy — commands always work)
    const channelCmd = parseObserveCommand(messageText);
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

    // Resolve per-channel config and check observe mode before group policy
    // (observe mode allows all senders — it watches the whole channel)
    const routeConfig = resolveZoomRouteConfig({ cfg: zoomCfg, channelJid, channelName });
    const { channelConfig } = routeConfig;

    // Check observe mode — static config first, then dynamic config
    const staticObservePolicy = resolveZoomObservePolicy({ channelConfig });
    const dynamicObservePolicy = await getDynamicObservePolicy(channelJid);
    const observeMode = staticObservePolicy.observeMode || dynamicObservePolicy.observeMode;
    const reviewChannelJid =
      staticObservePolicy.reviewChannelJid ?? dynamicObservePolicy.reviewChannelJid;

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

      await routeToAgentWithObserve({
        conversationId: channelJid,
        senderId,
        senderName,
        senderEmail,
        text: messageText.trim(),
        channelJid,
        channelName,
        reviewChannelJid,
        isThreadReply: Boolean(replyMainMessageId),
      });
      return;
    }

    // Check group policy (only for non-observed channels)
    const groupPolicy: GroupPolicy = zoomCfg?.groupPolicy ?? "allowlist";
    const groupAllowFrom = zoomCfg?.groupAllowFrom ?? [];

    if (
      !isZoomGroupAllowed({
        groupPolicy,
        allowFrom: groupAllowFrom,
        senderId,
        senderName,
        senderEmail,
      })
    ) {
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
      senderEmail,
      text: cleanText,
      isDirect: false,
      channelJid,
      channelName,
      replyToMessageId: messageId,
    });
  }

  async function handleAppConversationOpened(event: ZoomWebhookEvent) {
    const payload = event.payload?.object ?? event.payload;
    log.info(`app_invited/conversation_opened payload: ${JSON.stringify(event.payload)}`);

    if (!payload) {
      return;
    }

    const p = payload as Record<string, unknown>;
    // Extract channel info — try multiple field names across event types
    const rawChannelId = p.channel_id ?? p.toJid ?? p.to_jid;
    const channelName = (p.channel_name ?? p.name) as string | undefined;
    const channelId = asOptionalString(rawChannelId);
    if (!channelId) {
      log.debug("app_conversation_opened: no channel_id in payload, skipping");
      return;
    }

    const channelJid = channelId.includes("@")
      ? channelId
      : `${channelId}@conference.xmpp.zoom.us`;

    // Auto-enable observe mode for this channel
    await enableObserveChannel(channelJid, channelName);
    log.info(`auto-enabled observe mode for channel: ${channelName ?? channelJid}`);

    // Fire-and-forget: pull history and build training prompt
    const { fetchAndTrainFromHistory } = await import("./history.js");
    fetchAndTrainFromHistory(channelJid, channelName, creds, log).catch((err) =>
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
    replyToMessageId?: string;
  }) {
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
        "Use memory_search to check for this customer's profile and relevant context.",
        "",
        `**Original question:** ${training.originalQuestion}`,
        `**Your previous answer:** ${training.previousAnswer}`,
        `**Reviewer feedback:** ${feedback}`,
        "",
        "Generate an improved answer based on the feedback. Keep it to 2-3 sentences, no bullet points, no headers, no markdown formatting. Write like a knowledgeable coworker in a chat.",
      ].join("\n");

      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zoom",
        chatType: "channel",
        from: training.originalSenderName,
        to: training.originalChannelJid,
        groupId: training.originalChannelJid,
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
            if (payload.text) {
              collectedParts.push(payload.text);
            }
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

      log.info("training feedback processed, new review card sent", {
        newRefId,
        reviewChannelJid: training.reviewChannelJid,
      });
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
    senderEmail?: string;
    text: string;
    channelJid: string;
    channelName?: string;
    reviewChannelJid: string;
    isThreadReply?: boolean;
  }) {
    const {
      conversationId,
      senderId,
      senderName,
      senderEmail,
      text,
      channelJid,
      channelName,
      reviewChannelJid,
      isThreadReply,
    } = params;

    try {
      log.debug("routing to agent with observe mode", {
        conversationId,
        channelJid,
        isThreadReply,
      });

      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "zoom",
        chatType: "channel",
        from: senderId,
        to: conversationId,
        groupId: channelJid,
      });

      // Load channel training data (if available) to inject into context
      const training = await loadChannelTraining(channelName, channelJid);
      const trainingBlock = training
        ? [
            "",
            "[CHANNEL TRAINING DATA]",
            "Use the following Q&A patterns and tool references from this channel's history to inform your responses.",
            "When a request matches a tool action pattern, invoke the appropriate tool.",
            "",
            training,
            "[END CHANNEL TRAINING DATA]",
            "",
          ].join("\n")
        : "";

      // Thread replies are follow-ups to the bot's clarifying question — don't filter them.
      // New top-level messages get the observe wrapper to triage questions vs casual chat.
      const body = isThreadReply
        ? [
            "[CHANNEL OBSERVE — FOLLOW-UP] The user replied to your clarifying question.",
            "Use the channel training data below (if present) plus any memory_search results to give a tailored answer.",
            "Give a short, direct answer in 2-3 sentences max. No bullet points, no headers, no markdown formatting. Write like a knowledgeable coworker in a chat — brief and conversational.",
            "When the request involves an order, SOW, or pricing change, invoke the appropriate rapture/tesseract gateway tool (rapture_gateway_request or rapture_submit_workflow).",
            trainingBlock,
            `User reply: ${text}`,
          ].join("\n")
        : [
            "[CHANNEL OBSERVE MODE] A user posted a message in a channel you are monitoring.",
            "Use the channel training data below (if present) to match questions to known Q&A patterns and tool actions.",
            "If you find a matching Q&A pattern, give a brief response based on it (2-3 sentences, no formatting).",
            "When the request involves an order, SOW, pricing, or configuration change, invoke the appropriate rapture/tesseract gateway tool (rapture_gateway_request or rapture_submit_workflow).",
            "If the message shares factual details about the customer's environment (user count, platform, features, licensing, setup, infrastructure, etc.), respond with [CUSTOMER_CONTEXT] followed by each fact on its own line. Example:",
            "  [CUSTOMER_CONTEXT]",
            "  500 users",
            "  Using Microsoft Teams currently",
            "If this is NOT a question AND NOT customer context (casual chat, greeting, acknowledgment, small talk), respond with exactly [NO_RESPONSE] and nothing else.",
            "If it IS a new question with no matching training data, respond with ONE short clarifying question (1 sentence) to narrow down what they need.",
            trainingBlock,
            `User message: ${text}`,
          ].join("\n");

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: text,
        CommandBody: body,
        From: `zoom:channel:${channelJid}`,
        To: conversationId,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "channel",
        ConversationLabel: senderName ?? senderId,
        SenderName: senderName,
        SenderId: senderId,
        SenderEmail: senderEmail,
        SenderUsername: senderEmail,
        GroupSubject: channelName,
        GroupChannel: channelJid,
        Provider: "zoom" as const,
        Surface: "zoom" as const,
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "zoom" as const,
        OriginatingTo: conversationId,
      });

      log.info(
        `zoom observe route context senderId=${senderId} senderEmail=${senderEmail ?? "-"} channelJid=${channelJid} sessionKey=${route.sessionKey}`,
      );

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

      markDispatchIdle();

      const fullReply = collectedParts.join("\n").trim();

      // If no reply or agent signals not a question, silently drop
      if (!fullReply || fullReply.includes("[NO_RESPONSE]")) {
        log.debug("observe mode: not a question, dropping silently", { channelJid });
        return;
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
          log.info("observe mode: persisted customer context", {
            channelJid,
            count: persisted.length,
          });
        }
        return;
      }

      // Store pending approval and send review card
      const refId = storePendingApproval({
        originalChannelJid: channelJid,
        originalChannelName: channelName ?? channelJid,
        originalSenderName: senderName ?? senderId,
        originalQuestion: text,
        proposedAnswer: fullReply,
      });

      const { sendZoomActionMessage } = await import("./send.js");
      await sendZoomActionMessage({
        cfg,
        to: reviewChannelJid,
        headText: "Pending Answer Review",
        body: [
          {
            type: "message",
            text: `**Channel:** ${channelName ?? channelJid}\n**From:** ${senderName ?? senderId}\n**Question:** ${text}\n\n**Proposed Answer:**\n${fullReply}`,
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
}): Promise<void> {
  const {
    deps,
    conversationId,
    senderId,
    senderName,
    senderEmail,
    text,
    isDirect,
    channelJid,
    channelName,
  } = params;
  const { cfg, log } = deps;
  const core = getZoomRuntime();

  try {
    log.debug("routing to agent", {
      conversationId,
      senderId,
      isDirect,
      textLength: text.length,
    });

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "zoom",
      chatType: isDirect ? "direct" : "channel",
      from: senderId,
      to: conversationId,
      groupId: channelJid,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: text,
      RawBody: text,
      CommandBody: text,
      From: isDirect ? `zoom:${senderId}` : `zoom:channel:${channelJid}`,
      To: conversationId,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isDirect ? "direct" : "channel",
      ConversationLabel: senderName ?? senderId,
      SenderName: senderName,
      SenderId: senderId,
      SenderEmail: senderEmail,
      SenderUsername: senderEmail,
      GroupSubject: isDirect ? undefined : channelName,
      GroupChannel: isDirect ? undefined : channelJid,
      Provider: "zoom" as const,
      Surface: "zoom" as const,
      CommandAuthorized: true,
      CommandSource: "text" as const,
      OriginatingChannel: "zoom" as const,
      OriginatingTo: conversationId,
    });

    log.info(
      `zoom route context senderId=${senderId} senderEmail=${senderEmail ?? "-"} isDirect=${isDirect} sessionKey=${route.sessionKey}`,
    );

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload) => {
          const { sendZoomTextMessage } = await import("./send.js");
          if (payload.text) {
            await sendZoomTextMessage({
              cfg,
              to: conversationId,
              text: payload.text,
              isChannel: !isDirect,
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

    markDispatchIdle();

    if (queuedFinal) {
      const finalCount = counts.final;
      log.info(
        `delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${conversationId}`,
      );
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
  const platformMatch = combined.match(
    /(?:using|running|on|from|migrating from|switching from)\s+(Microsoft Teams|Cisco|RingCentral|8x8|Avaya|Vonage|Mitel|Genesys|Five9|Dialpad)/i,
  );
  if (platformMatch) {
    details.push(`Current/previous platform: ${platformMatch[1]}`);
  }

  // User count
  const userCountMatch = combined.match(
    /(\d[\d,]*)\s*(?:users?|seats?|employees?|extensions?|agents?|lines?)/i,
  );
  if (userCountMatch) {
    details.push(
      `Approximate size: ${userCountMatch[1]} ${userCountMatch[0].replace(userCountMatch[1], "").trim()}`,
    );
  }

  // License type
  const licenseMatch = combined.match(
    /(?:on|have|using)\s+(?:the\s+)?(Pro|Business|Enterprise|Zoom\s+(?:One|Workplace|Phone)(?:\s+\w+)?)\s+(?:plan|license|tier)/i,
  );
  if (licenseMatch) {
    details.push(`License/plan: ${licenseMatch[1]}`);
  }

  // Key features they care about
  const featurePatterns: [RegExp, string][] = [
    [/executive[- ]?assistant|delegation/i, "Needs executive-assistant delegation"],
    [/call\s*queue|hunt\s*group/i, "Uses call queues / hunt groups"],
    [/auto[- ]?attendant|ivr/i, "Uses auto-attendant / IVR"],
    [/common\s*area\s*phone|lobby\s*phone/i, "Has common area phones"],
    [/contact\s*center|call\s*center/i, "Has contact center needs"],
    [
      /international|global|multi[- ]?country|multiple\s*countries/i,
      "Multi-country / international deployment",
    ],
    [/analog|ata\b|fax\s*machine/i, "Has analog/fax devices"],
    [/hot[- ]?desk/i, "Uses hot desking"],
    [/salesforce|hubspot|crm/i, "CRM integration required"],
    [/sso|saml|okta|azure\s*ad/i, "Uses SSO / identity provider"],
    [/recording|compliance/i, "Call recording / compliance needs"],
    [/e911|emergency\s*(?:calling|services)/i, "E911 requirements"],
  ];

  for (const [re, label] of featurePatterns) {
    if (re.test(combined)) {
      details.push(label);
    }
  }

  return details;
}
