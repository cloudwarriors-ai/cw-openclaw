import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { getRememberedZoomSessionReplyRoot } from "./thread-state.js";

// Deliver subagent (spoke) completion results back into the originating Zoom thread.
//
// Core's subagent announce-back re-triggers the requester (coordinator) turn to relay the spoke's
// result, but that re-triggered turn no longer carries the original inbound thread context — so
// without this hook the result posts to the channel ROOT (replyToMessageId=none) while only the
// coordinator's first ack stayed in-thread. We resolve the requester session's remembered
// reply-root (the message id to thread replies under, stored by rememberZoomSessionReplyRoot on
// every inbound turn) and return it as the delivery origin's `threadId`. The Zoom outbound adapter
// maps `threadId` -> `replyToMessageId`, so the result lands in the same thread as the request.
//
// Mirrors the discord/feishu `subagent_delivery_target` hooks; Zoom's threading is reply-anchored
// (reply-to a message id) rather than a separate thread channel, so we carry the reply-root id.
export function registerZoomSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_delivery_target", (event) => {
    if (!event.expectsCompletionMessage) {
      return;
    }
    const requesterChannel = event.requesterOrigin?.channel?.trim().toLowerCase();
    if (requesterChannel !== "zoom") {
      return;
    }
    const to = event.requesterOrigin?.to?.trim();
    if (!to) {
      return;
    }
    // If the requester origin already carries a thread target, leave it untouched.
    if (event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== "") {
      return;
    }
    const replyRoot = getRememberedZoomSessionReplyRoot(event.requesterSessionKey);
    if (!replyRoot) {
      // No known thread root for this session -> leave default (root) delivery.
      return;
    }
    return {
      origin: {
        channel: "zoom",
        accountId: event.requesterOrigin?.accountId,
        to,
        threadId: replyRoot,
      },
    };
  });
}
