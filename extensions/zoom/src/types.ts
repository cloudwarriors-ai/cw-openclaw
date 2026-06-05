import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/config-contracts";

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

export type ZoomThreadReplyMode = "off" | "incoming" | "all";

export type ZoomThreadSessionScope = "parent" | "thread";

export type ZoomThreadingConfig = {
  enabled?: boolean;
  replyToMode?: ZoomThreadReplyMode;
  sessionScope?: ZoomThreadSessionScope;
  inheritParent?: boolean;
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
  threading?: ZoomThreadingConfig;
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
  reply_main_message_id?: string;
  message?: string;
  timestamp?: number;
  sender?: string;
  sender_member_id?: string;
  sender_display_name?: string;
  robot_jid?: string;
};

export type ZoomWebhookEvent = {
  event: string;
  event_ts: number;
  payload: {
    accountId?: string;
    object?: {
      type?: string;
      channel_jid?: string;
      channel_name?: string;
      operator?: string;
      operator_id?: string;
      operator_member_id?: string;
      /** For channel messages, this is the message object */
      message?: ZoomChatMessage;
      userJid?: string;
      user_id?: string;
      user_name?: string;
      user_email?: string;
      robot_jid?: string;
      /** For bot notifications, this is the message text */
      text?: string;
      cmd?: string;
      timestamp?: number;
      /** Button/action click payloads */
      actionItem?: { text?: string; value?: string };
      fieldEditItem?: { key?: string; value?: string; newValue?: string };
      selectedItem?: { value?: string; text?: string };
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
