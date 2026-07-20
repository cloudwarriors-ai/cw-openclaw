import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAuditLogger } from "./src/audit.js";
import { rememberChannelThreadAnchor, sendComfortMessage } from "./src/comfort.js";
import { tryExecuteConfirm } from "./src/confirm.js";
import { registerEoaCliTools } from "./src/eoa-cli-tools.js";
import { registerEoaStateTools } from "./src/eoa-state-tools.js";
import { registerGhTools } from "./src/gh-tools.js";

type PluginConfig = { eoaRepos?: string[] };

// A human confirm reply. Mirrors the matcher in tryExecuteConfirm() so the
// before_dispatch gate and the comfort-skip use one shape.
const CONFIRM_RE = /^CONFIRM\s+\d{4}\b/i;

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
    const pluginConfig: PluginConfig = config ?? {
      eoaRepos: ["cloudwarriors-ai/external-org-autopilot"],
    };

    registerEoaCliTools(api, logger);
    registerEoaStateTools(api, logger);
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
      // Claim only CONFIRMs from this bot's own sessions (session key prefix set by
      // the agent binding). Six gated bots register this same first-claim-wins hook;
      // without this guard, whichever bot registered FIRST steals every zoom CONFIRM
      // and answers "expired" from its own empty pending store (2026-07-20 incident:
      // pulsebot consumed a scopelybot confirm code that was 13 seconds old).
      if (ctx.sessionKey?.startsWith("agent:external-org-autopilot:") !== true) return undefined;
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

    console.log("[external-org-autopilot] Registered 23 tools (11 CLI + 6 state + 6 GH)");
  },
};

export default plugin;
