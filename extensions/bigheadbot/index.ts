import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerBhTools } from "./src/bh-tools.js";
import { registerGhTools } from "./src/gh-tools.js";
import { registerCorrelationTools } from "./src/correlation-tools.js";
import { registerDevtoolsTools } from "./src/devtools-tools.js";
import { sendComfortMessage } from "./src/comfort.js";

type PluginConfig = { bhRepos?: string[] };

const plugin = {
  id: "bigheadbot",
  name: "BigheadBot",
  description: "Bighead break/fix research agent tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      bhRepos: {
        type: "array",
        items: { type: "string" },
        default: ["cloudwarriors-ai/bighead"],
        description: "GitHub repos scoped for Bighead issue management",
      },
    },
  },

  register(api: OpenClawPluginApi, config?: PluginConfig) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);
    const pluginConfig: PluginConfig = config ?? { bhRepos: ["cloudwarriors-ai/bighead"] };

    registerBhTools(api, logger);
    registerGhTools(api, logger, pluginConfig);
    registerCorrelationTools(api, logger, pluginConfig);
    registerDevtoolsTools(api, logger);

    // Send comfort message when a message arrives in the bigheadbot channel
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId === "zoom" && ctx.conversationId) {
        const messageId =
          typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined;
        void sendComfortMessage(ctx.conversationId, messageId);
      }
    });

    console.log("[bigheadbot] Registered 25 tools (11 BH + 6 GH + 1 correlation + 7 devtools)");
  },
};

export default plugin;
