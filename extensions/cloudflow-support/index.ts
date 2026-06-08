import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerCfOpsTools } from "./src/cf-ops-tools.js";
import { rememberChannelThreadAnchor, sendComfortMessage } from "./src/comfort.js";
import { tryExecuteConfirm } from "./src/confirm.js";
import { registerGhTools } from "./src/gh-tools.js";

type PluginConfig = { cfRepos?: string[] };

// A human confirm reply. Mirrors the matcher in tryExecuteConfirm() so the
// before_dispatch gate and the comfort-skip use one shape.
const CONFIRM_RE = /^CONFIRM\s+\d{4}\b/i;

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

    // Comfort message + thread-anchor capture on inbound. CONFIRM execution is
    // NOT handled here: message_received is a fire-and-forget OBSERVE hook (it
    // cannot suppress the coordinator) and runs before before_dispatch — if it
    // consumed the pending action the before_dispatch handler would find nothing.
    // So here we only (a) skip comfort for a CONFIRM reply and (b) stash the
    // inbound message id so the confirm gate can thread its prompt.
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "zoom" || !ctx.conversationId) return;
      const text = typeof event.content === "string" ? event.content : "";
      if (CONFIRM_RE.test(text.trim())) return;
      const messageId =
        typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined;
      rememberChannelThreadAnchor(ctx.conversationId, messageId);
      void sendComfortMessage(ctx.conversationId, messageId);
    });

    // Confirm gate execution: a human `CONFIRM <code>` reply runs the staged action.
    // before_dispatch is the awaited pre-dispatch seam that can suppress the agent —
    // `handled: true` stops the message from reaching the coordinator (no spurious
    // re-stage), and `text` is delivered threaded by core. The LLM is never in the
    // execution path: it cannot fabricate the inbound CONFIRM.
    api.on("before_dispatch", async (event, ctx) => {
      if (ctx.channelId !== "zoom") return undefined;
      const text = typeof event.content === "string" ? event.content : "";
      if (!CONFIRM_RE.test(text.trim())) return undefined;
      const result = await tryExecuteConfirm({ text, actor: ctx.senderId ?? "", logger });
      return { handled: true, text: result ?? undefined };
    });

    console.log("[cloudflow-support] Registered 15 tools (9 ops + 6 GH)");
  },
};

export default plugin;
