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

    // Register every tool as `optional: true` so per-agent allowlists actually
    // scope them: non-optional plugin tools bypass allowlists and become visible
    // to EVERY agent. With this wrapper, only agents whose `tools.allow` includes
    // a tool name, the plugin id ("cloudflow-support"), or "group:plugins" see them.
    // The wrapper also counts registrations so the startup banner can never drift
    // from the real tool count.
    let toolCount = 0;
    const optionalApi: OpenClawPluginApi = {
      ...api,
      registerTool: (tool, opts) => {
        toolCount += 1;
        return api.registerTool(tool, { ...opts, optional: true });
      },
    };

    registerCfOpsTools(optionalApi, logger);
    registerGhTools(optionalApi, logger, pluginConfig);

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
      // Claim only CONFIRMs from this bot's own sessions (session key prefix set by
      // the agent binding). Six gated bots register this same first-claim-wins hook;
      // without this guard, whichever bot registered FIRST steals every zoom CONFIRM
      // and answers "expired" from its own empty pending store (2026-07-20 incident:
      // pulsebot consumed a scopelybot confirm code that was 13 seconds old).
      if (ctx.sessionKey?.startsWith("agent:cloudflow-support:") !== true) return undefined;
      const text = typeof event.content === "string" ? event.content : "";
      if (!CONFIRM_RE.test(text.trim())) return undefined;
      const result = await tryExecuteConfirm({
        text,
        actor: ctx.senderId ?? "",
        conversationId: ctx.conversationId ?? "",
        logger,
      });
      return { handled: true, text: result ?? undefined };
    });

    console.log(`[cloudflow-support] Registered ${toolCount} tools (ops + GH)`);
  },
};

export default plugin;
