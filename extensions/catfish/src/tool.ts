import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "openclaw/plugin-sdk/core";
import type { CatfishClient, CatfishSendTargetType } from "./client.js";
import { isCatfishError, toErrorMessage } from "./errors.js";

const TARGET_TYPES = ["auto", "dm", "channel"] as const;

export function createCatfishSendTool(client: CatfishClient) {
  return {
    name: "catfish_send",
    description:
      "Send a Zoom Team Chat message on behalf of a user JID (privileged admin scope required). JID format is usually lowercase(Zoom user id) + @xmpp.zoom.us.",
    parameters: Type.Object({
      jid: Type.String({
        description:
          "Sender user JID. Usually lowercase(Zoom user id) + @xmpp.zoom.us, for example user-123@xmpp.zoom.us.",
      }),
      target: Type.String({
        description:
          "Recipient target (user JID/email/id or channel JID/id). For DM JID, use lowercase(Zoom user id) + @xmpp.zoom.us.",
      }),
      message: Type.String({ description: "Message text to send" }),
      target_type: Type.Optional(
        stringEnum(TARGET_TYPES, {
          description: "Routing mode: auto (default), dm, or channel",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const result = await client.send(
          String(params.jid),
          String(params.target),
          String(params.message),
          {
            targetType: (params.target_type as CatfishSendTargetType | undefined) ?? "auto",
          },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        if (isCatfishError(err)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  code: err.code,
                  message: err.message,
                  status: err.statusCode,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                code: "CATFISH_API_ERROR",
                message: toErrorMessage(err),
              }),
            },
          ],
        };
      }
    },
  };
}

export function registerCatfishTool(api: OpenClawPluginApi, client: CatfishClient): void {
  api.registerTool(() => createCatfishSendTool(client));
}
