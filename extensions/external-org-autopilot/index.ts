import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerGhTools } from "./src/gh-tools.js";
import { registerEoaCliTools } from "./src/eoa-cli-tools.js";
import { registerEoaStateTools } from "./src/eoa-state-tools.js";
import { sendComfortMessage } from "./src/comfort.js";

type PluginConfig = { eoaRepos?: string[] };

const plugin = {
  id: "external-org-autopilot",
  name: "EOAutopilot",
  description: "External Org Autopilot onboarding, sync, execution, and reporting tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      eoaRepos: {
        type: "array",
        items: { type: "string" },
        default: ["cloudwarriors-ai/external-org-autopilot"],
        description: "GitHub repos scoped for EOA issue management",
      },
    },
  },

  register(api: OpenClawPluginApi, config?: PluginConfig) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);
    const pluginConfig: PluginConfig = config ?? { eoaRepos: ["cloudwarriors-ai/external-org-autopilot"] };

    registerEoaCliTools(api, logger);
    registerEoaStateTools(api, logger);
    registerGhTools(api, logger, pluginConfig);

    // Send comfort message when a message arrives in the EOA channel
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId === "zoom" && ctx.conversationId) {
        const messageId =
          typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined;
        void sendComfortMessage(ctx.conversationId, messageId);
      }
    });

    console.log("[external-org-autopilot] Registered 23 tools (11 CLI + 6 state + 6 GH)");
  },
};

export default plugin;
