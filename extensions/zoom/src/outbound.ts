import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import { getZoomRuntime } from "./runtime.js";
import { sendZoomTextMessage } from "./send.js";

/** Channel JIDs use the @conference. subdomain in Zoom XMPP */
const isChannelJid = (jid: string) => jid.includes("@conference.");

export const zoomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getZoomRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  sendText: async ({ cfg, to, text, replyToId, threadId, identity }) => {
    const isChannel = isChannelJid(to);
    // Zoom threads via replyToMessageId. Honor an explicit replyToId, else fall back to a
    // delivery-origin threadId (a reply-root message id) so subagent announce-back results
    // land in the originating thread rather than the channel root.
    //
    // Send directly via sendZoomTextMessage. Do NOT route through an injected `deps` channel
    // sender: the CLI deps Proxy auto-synthesizes `deps.sendZoom` as a generic channel sender
    // that re-enters this adapter through channel-outbound-send with a freshly-built context
    // (no replyToId/threadId), which silently drops threading and forces channel-root delivery.
    const replyTo = replyToId ?? (threadId != null ? String(threadId) : undefined);
    const result = await sendZoomTextMessage({
      cfg,
      to,
      text,
      isChannel,
      replyToMessageId: replyTo,
      speakerName: identity?.name,
    });
    return { channel: "zoom", ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl, replyToId, threadId, identity }) => {
    const isChannel = isChannelJid(to);
    const replyTo = replyToId ?? (threadId != null ? String(threadId) : undefined);
    const mediaText = mediaUrl ? `${text ? `${text}\n\n` : ""}${mediaUrl}` : text;
    const result = await sendZoomTextMessage({
      cfg,
      to,
      text: mediaText,
      isChannel,
      replyToMessageId: replyTo,
      speakerName: identity?.name,
    });
    return { channel: "zoom", ...result };
  },
};
