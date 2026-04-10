import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerGhTools } from "./src/gh-tools.js";
import { registerCfOpsTools } from "./src/cf-ops-tools.js";
import { sendComfortMessage } from "./src/comfort.js";

type PluginConfig = { cfRepos?: string[] };

const plugin = {
  id: "cloudflow-support",
  name: "CloudFlowSupport",
  description: "CloudFlow platform support, operations API, and issue management tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      cfRepos: {
        type: "array",
        items: { type: "string" },
        default: ["cloudwarriors-ai/cloudflow"],
        description: "GitHub repos scoped for CloudFlow issue management",
      },
    },
  },

  register(api: OpenClawPluginApi, config?: PluginConfig) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);
    const pluginConfig: PluginConfig = config ?? { cfRepos: ["cloudwarriors-ai/cloudflow"] };

    registerCfOpsTools(api, logger);
    registerGhTools(api, logger, pluginConfig);

    // Send comfort message when a message arrives in the CloudFlow channel
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId === "zoom" && ctx.conversationId) {
        const messageId =
          typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined;
        void sendComfortMessage(ctx.conversationId, messageId);
      }
    });

    console.log("[cloudflow-support] Registered 15 tools (9 ops + 6 GH)");
  },
};

export default plugin;
