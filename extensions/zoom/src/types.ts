import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

export type ZoomChannelConfig = {
  requireMention?: boolean;
  observeMode?: boolean;
  reviewChannelJid?: string;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  toolsBySender?: Record<
    string,
    {
      allow?: string[];
      deny?: string[];
    }
  >;
};

export type ZoomConfig = {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string;
  accountId?: string;
  botJid?: string;
  webhookSecretToken?: string;
  webhook?: {
    port?: number;
    path?: string;
  };
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  requireMention?: boolean;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  historyLimit?: number;
  dmHistoryLimit?: number;
  channels?: Record<string, ZoomChannelConfig | undefined>;
  dms?: Record<string, unknown>;
  /** Public base URL for upload links, e.g. "https://molty-dev.cloudwarriors.ai" */
  publicUrl?: string;
};

export type ZoomCredentials = {
  clientId: string;
  clientSecret: string;
  accountId: string;
  botJid: string;
  webhookSecretToken?: string;
};

export type ZoomChatMessage = {
  id?: string;
  message?: string;
  timestamp?: number;
  sender?: string;
  sender_member_id?: string;
  sender_display_name?: string;
  sender_email?: string;
  robot_jid?: string;
};

export type ZoomWebhookEvent = {
  event: string;
  event_ts: number;
  payload: {
    accountId?: string;
    operator?: string;
    operator_id?: string;
    operator_member_id?: string;
    operator_email?: string;
    operatorEmail?: string;
    user_email?: string;
    userEmail?: string;
    object?: {
      type?: string;
      channel_jid?: string;
      channel_name?: string;
      operator?: string;
      operator_id?: string;
      operator_member_id?: string;
      /** For channel messages, this is the message object */
      message?: ZoomChatMessage;
      user_jid?: string;
      userJid?: string;
      user_id?: string;
      userId?: string;
      user_name?: string;
      user_email?: string;
      userEmail?: string;
      user_member_id?: string;
      userMemberId?: string;
      robot_jid?: string;
      /** For bot notifications, this is the message text */
      text?: string;
      cmd?: string;
      timestamp?: number;
      /** Button/action click payloads */
      actionItem?: { text?: string; value?: string };
      fieldEditItem?: { key?: string; value?: string; newValue?: string };
      selectedItem?: { value?: string; text?: string };
      to_jid?: string;
      toJid?: string;
      messageId?: string;
      original?: { body?: Array<Record<string, unknown>> };
      userName?: string;
      channelName?: string;
    };
  };
};

export type ZoomActionButton = {
  text: string;
  value: string;
  style?: "Primary" | "Danger" | "Default" | "Disabled";
};

export type ZoomAtItem = {
  at_type: number;
  start_index: number;
  end_index: number;
  at_contact?: string;
};

export type ZoomBodyItem =
  | { type: "message"; text: string; at_items?: ZoomAtItem[] }
  | { type: "actions"; items: ZoomActionButton[] };

export type ZoomAccessToken = {
  accessToken: string;
  expiresAt: number;
};
