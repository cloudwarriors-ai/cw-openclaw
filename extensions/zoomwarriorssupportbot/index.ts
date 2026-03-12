import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerZwsTools } from "./src/zws-tools.js";
import { registerGhTools } from "./src/gh-tools.js";
import { registerCorrelationTools } from "./src/correlation-tools.js";
import { registerDevtoolsTools } from "./src/devtools-tools.js";
import { sendComfortMessage } from "./src/comfort.js";

type PluginConfig = { zwsRepos?: string[] };

const plugin = {
  id: "zoomwarriorssupportbot",
  name: "ZoomWarriorsSupportBot",
  description: "ZoomWarriors2 break/fix support agent tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      zwsRepos: {
        type: "array",
        items: { type: "string" },
        default: ["cloudwarriors-ai/zoomwarriors2"],
        description: "GitHub repos scoped for ZoomWarriors2 issue management",
      },
    },
  },

  register(api: OpenClawPluginApi, config?: PluginConfig) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);
    const pluginConfig: PluginConfig = config ?? { zwsRepos: ["cloudwarriors-ai/zoomwarriors2"] };

    registerZwsTools(api, logger);
    registerGhTools(api, logger, pluginConfig);
    registerCorrelationTools(api, logger, pluginConfig);
    registerDevtoolsTools(api, logger);

    // Send comfort message when a message arrives in the zws channel
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId === "zoom" && ctx.conversationId) {
        const messageId =
          typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined;
        void sendComfortMessage(ctx.conversationId, messageId);
      }
    });

    console.log("[zoomwarriorssupportbot] Registered 25 tools (11 ZWS + 6 GH + 1 correlation + 7 devtools)");
  },
};

export default plugin;
