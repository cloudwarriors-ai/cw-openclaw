import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { registerBhTools } from "./src/bh-tools.js";
import { rememberChannelThreadAnchor, sendComfortMessage } from "./src/comfort.js";
import { tryExecuteConfirm } from "./src/confirm.js";
import { registerCorrelationTools } from "./src/correlation-tools.js";
import { registerDevtoolsTools } from "./src/devtools-tools.js";
import { registerGhTools } from "./src/gh-tools.js";

type PluginConfig = { bhRepos?: string[] };

// A human confirm reply. Mirrors the matcher in tryExecuteConfirm() so the
// before_dispatch gate and the comfort-skip use one shape.
const CONFIRM_RE = /^CONFIRM\s+\d{4}\b/i;

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

    // Register every tool as `optional: true` so per-agent allowlists actually
    // scope them: non-optional plugin tools bypass allowlists and become visible
    // to EVERY agent. With this wrapper, only agents whose `tools.allow` includes
    // a tool name, the plugin id ("bigheadbot"), or "group:plugins" see them.
    const optionalApi: OpenClawPluginApi = {
      ...api,
      registerTool: (tool, opts) => api.registerTool(tool, { ...opts, optional: true }),
    };

    registerBhTools(optionalApi, logger);
    registerGhTools(optionalApi, logger, pluginConfig);
    registerCorrelationTools(optionalApi, logger, pluginConfig);
    registerDevtoolsTools(optionalApi, logger);

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

    console.log("[bigheadbot] Registered 25 tools (11 BH + 6 GH + 1 correlation + 7 devtools)");
  },
};

export default plugin;
