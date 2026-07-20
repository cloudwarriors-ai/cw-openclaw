import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerAdminTools } from "./src/admin-tools.js";
import { createApproverStore } from "./src/approver-store.js";
import { registerApproverTools } from "./src/approver-tools.js";
import { createAuditLogger } from "./src/audit.js";
import { rememberChannelThreadAnchor, sendComfortMessage } from "./src/comfort.js";
import type { ScopelyBotConfig } from "./src/config.js";
import { configuredWriteApprovers, resolveScopelyBotConfig } from "./src/config.js";
import { tryExecuteConfirm } from "./src/confirm.js";
import { registerCorrelationTools } from "./src/correlation-tools.js";
import { registerDeploymentConfigTools } from "./src/deployment-config-tools.js";
import { registerGhTools } from "./src/gh-tools.js";
import { registerMonitoringTools } from "./src/monitoring-tools.js";
import { registerOrgTools } from "./src/org-tools.js";
import { runPassthroughCycle } from "./src/passthrough-runner-cycle.js";
import { registerPassthroughTools } from "./src/passthrough-tools.js";
import { registerPricingTools } from "./src/pricing-tools.js";
import { registerScopelyTools } from "./src/scopely-tools.js";
import { registerScopingCardTools } from "./src/scoping-card-tools.js";
import { registerSupportTools } from "./src/support-tools.js";
import { registerUserMaintenanceTools } from "./src/user-maintenance-tools.js";
import { registerVendorConfigTools } from "./src/vendor-config-tools.js";
import { isScopelyBotZoomMessage, rewriteScopelyBotZoomMessage } from "./src/zoom-format.js";

// A human confirm reply. Mirrors the matcher in tryExecuteConfirm() so the
// before_dispatch gate and the comfort-skip use one shape.
const CONFIRM_RE = /^CONFIRM\s+\d{4}\b/i;

// Default 5 minutes; override with PASSTHROUGH_INTERVAL_MS
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
// Hard floor — never poll faster than 1 minute
const MIN_INTERVAL_MS = 60 * 1000;

let intervalHandle: NodeJS.Timeout | null = null;

const plugin = {
  id: "scopelybot",
  name: "ScopelyBot",
  description: "Scopely VIP observability and break/fix research agent tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      scopelyRepos: {
        type: "array",
        items: { type: "string" },
        default: ["cloudwarriors-ai/scopely"],
        description: "GitHub repos scoped for Scopely issue management",
      },
      serviceContainers: {
        type: "array",
        items: { type: "string" },
        description: "Exact Docker container names Scopely support tools may inspect",
      },
      writeApproverIds: {
        type: "array",
        items: { type: "string" },
        description: "Exact Zoom sender ids allowed to execute staged Scopely writes",
      },
    },
  },

  register(api: OpenClawPluginApi, config?: ScopelyBotConfig) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);
    const pluginConfig = resolveScopelyBotConfig(api.config, config);
    // Config-seeded approvers are permanent; the store layers chat-granted approvers
    // (scopely_grant_approver, confirm-gated) and the observed-identity ledger on top,
    // persisted in the workspace so restarts keep both.
    const approverStore = createApproverStore({
      workspaceDir,
      configuredIds: configuredWriteApprovers(pluginConfig),
    });

    // Register every scopelybot tool as `optional: true` so per-agent allowlists
    // actually scope them: non-optional plugin tools bypass allowlists entirely and
    // become visible to EVERY agent. With this wrapper, only agents whose
    // `tools.allow` includes a tool name, the plugin id ("scopelybot"), or
    // "group:plugins" can see these tools. The scopelybot agent's allow list
    // carries the "scopelybot" entry; other bots get nothing.
    const optionalApi: OpenClawPluginApi = {
      ...api,
      registerTool: (tool, opts) => api.registerTool(tool, { ...opts, optional: true }),
    };

    registerScopelyTools(optionalApi, logger);
    registerAdminTools(optionalApi, logger);
    registerMonitoringTools(optionalApi, logger);
    registerGhTools(optionalApi, logger, pluginConfig);
    registerCorrelationTools(optionalApi, logger, pluginConfig);
    registerPassthroughTools(optionalApi, logger, workspaceDir);
    registerUserMaintenanceTools(optionalApi, logger);
    registerOrgTools(optionalApi, logger);
    registerPricingTools(optionalApi, logger);
    registerVendorConfigTools(optionalApi, logger);
    registerDeploymentConfigTools(optionalApi, logger);
    registerScopingCardTools(optionalApi, logger);
    registerSupportTools(optionalApi, logger, pluginConfig);
    registerApproverTools(optionalApi, logger, approverStore);

    // Zoom card bodies do not render Markdown. Keep this rewrite at the Scopely
    // plugin boundary so other agents and channels retain their existing output.
    api.on("message_sending", (event, ctx) => rewriteScopelyBotZoomMessage(event.content, ctx));

    // Comfort message + thread-anchor capture on inbound. CONFIRM execution is
    // NOT handled here: message_received is a fire-and-forget OBSERVE hook (it
    // cannot suppress the coordinator), and it runs before before_dispatch — if
    // it consumed the pending action the before_dispatch handler would find
    // nothing. So here we only (a) skip comfort for a CONFIRM reply and (b) stash
    // the inbound message id so the confirm gate can thread its prompt.
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== "zoom" || !ctx.conversationId) return;
      // Identity ledger: zoom webhooks carry (operator_id, operator email) per sender.
      // Recording them lets scopely_grant_approver resolve an email to the Zoom id the
      // confirm gate matches on. Scoped to scopelybot's own sessions so other bots'
      // channels don't populate this bot's ledger.
      if (isScopelyBotZoomMessage({ channelId: ctx.channelId, sessionKey: ctx.sessionKey })) {
        const senderEmail =
          typeof event.metadata?.senderName === "string" ? event.metadata.senderName : undefined;
        approverStore.recordSeenIdentity(event.senderId, senderEmail);
      }
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
    // re-stage), and `text` is delivered by core threaded into the conversation. The
    // LLM is never in the execution path: it cannot fabricate the inbound CONFIRM.
    api.on("before_dispatch", async (event, ctx) => {
      // Claim only CONFIRMs arriving through ScopelyBot's own Zoom surface (its
      // bound channel or a thread inside it), proven by the agent-scoped session
      // key. Six gated bots register this same first-claim-wins hook; an unscoped
      // `channelId === "zoom"` claim lets whichever bot registered FIRST steal
      // every zoom CONFIRM and answer "expired" from its own empty pending store
      // (2026-07-20 incident: pulsebot consumed a scopelybot confirm).
      if (
        !isScopelyBotZoomMessage({ channelId: ctx.channelId ?? "", sessionKey: ctx.sessionKey })
      ) {
        return;
      }
      const text = typeof event.content === "string" ? event.content : "";
      if (!CONFIRM_RE.test(text.trim())) return;
      const result = await tryExecuteConfirm({
        text,
        actor: ctx.senderId ?? "",
        conversationId: ctx.conversationId ?? "",
        channelId: ctx.channelId,
        sessionKey: ctx.sessionKey,
        // Read at confirm time (not register time) so chat-granted approvers take
        // effect immediately, without a container restart.
        approverIds: approverStore.approverIds(),
        logger,
      });
      // `handled: true` suppresses the coordinator so the CONFIRM cannot re-stage; the
      // result string (executed / "no pending action") is delivered threaded by core.
      console.log("[scopelybot] before_dispatch claimed CONFIRM (coordinator suppressed)");
      return { handled: true, text: result ?? undefined };
    });

    // Schedule recurring passthrough test runs.
    // Disabled if PASSTHROUGH_RUNNER_ENABLED is not "1" or SCOPELY_REPO_PATH is unset.
    const runnerEnabled = process.env.PASSTHROUGH_RUNNER_ENABLED === "1";
    const repoPath = process.env.SCOPELY_REPO_PATH;
    if (runnerEnabled && repoPath) {
      const interval = Math.max(
        MIN_INTERVAL_MS,
        Number(process.env.PASSTHROUGH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
      );
      api.registerHook("gateway:startup", () => {
        // Run once at startup, then on the configured interval
        void runPassthroughCycle(workspaceDir, { source: "scheduled" }).catch((err) => {
          console.error("[scopelybot-passthrough] startup cycle failed:", err);
        });
        intervalHandle = setInterval(() => {
          void runPassthroughCycle(workspaceDir, { source: "scheduled" }).catch((err) => {
            console.error("[scopelybot-passthrough] scheduled cycle failed:", err);
          });
        }, interval);
        // Don't keep the process alive solely for this timer
        intervalHandle.unref?.();
        console.log(`[scopelybot-passthrough] runner enabled, interval=${interval}ms`);
      });
      api.registerHook("gateway:shutdown", () => {
        if (intervalHandle) {
          clearInterval(intervalHandle);
          intervalHandle = null;
        }
      });
    } else {
      console.log(
        "[scopelybot-passthrough] runner disabled (set PASSTHROUGH_RUNNER_ENABLED=1 and SCOPELY_REPO_PATH to enable)",
      );
    }

    console.log(
      "[scopelybot] Registered 97 tools (10 observability + 5 admin + 4 monitoring + 6 GH + 1 correlation + 2 passthrough + 9 user-maintenance + 8 org + 15 pricing + 13 vendor-config + 8 deployment-config + 5 scoping-card + 11 support)",
    );
  },
};

export default plugin;
