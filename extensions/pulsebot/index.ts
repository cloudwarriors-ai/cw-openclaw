import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerPpTools } from "./src/pp-tools.js";
import { registerGhTools } from "./src/gh-tools.js";
import { registerCorrelationTools } from "./src/correlation-tools.js";
import { sendComfortMessage } from "./src/comfort.js";

type PluginConfig = { ppRepos?: string[] };

const plugin = {
  id: "pulsebot",
  name: "PulseBot",
  description: "Project Pulse break/fix research agent tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      ppRepos: {
        type: "array",
        items: { type: "string" },
        default: ["cloudwarriors-ai/project-pulse"],
        description: "GitHub repos scoped for PP issue management",
      },
    },
  },

  register(api: OpenClawPluginApi, config?: PluginConfig) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);
    const pluginConfig: PluginConfig = config ?? { ppRepos: ["cloudwarriors-ai/project-pulse"] };

    registerPpTools(api, logger);
    registerGhTools(api, logger, pluginConfig);
    registerCorrelationTools(api, logger, pluginConfig);

    // Send comfort message when a message arrives in the pulsebot channel
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId === "zoom" && ctx.conversationId) {
        const messageId =
          typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined;
        void sendComfortMessage(ctx.conversationId, messageId);
      }
    });

    console.log("[pulsebot] Registered 18 tools (11 PP + 6 GH + 1 correlation)");
  },
};

export default plugin;
