import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerAdminTools } from "./src/admin-tools.js";
import { createAuditLogger } from "./src/audit.js";
import { sendComfortMessage, sendScopelyText } from "./src/comfort.js";
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
import { registerUserMaintenanceTools, tryExecuteConfirm } from "./src/user-maintenance-tools.js";
import { registerVendorConfigTools } from "./src/vendor-config-tools.js";

type PluginConfig = { scopelyRepos?: string[] };

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
    },
  },

  register(api: OpenClawPluginApi, config?: PluginConfig) {
    const workspaceDir = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
    const logger = createAuditLogger(workspaceDir);
    const pluginConfig: PluginConfig = config ?? { scopelyRepos: ["cloudwarriors-ai/scopely"] };

    registerScopelyTools(api, logger);
    registerAdminTools(api, logger);
    registerMonitoringTools(api, logger);
    registerGhTools(api, logger, pluginConfig);
    registerCorrelationTools(api, logger, pluginConfig);
    registerPassthroughTools(api, logger, workspaceDir);
    registerUserMaintenanceTools(api, logger);
    registerOrgTools(api, logger);
    registerPricingTools(api, logger);
    registerVendorConfigTools(api, logger);
    registerDeploymentConfigTools(api, logger);
    registerScopingCardTools(api, logger);

    // Send comfort message when a message arrives in the scopelybot channel
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId === "zoom" && ctx.conversationId) {
        // User-maintenance confirm gate: a human `CONFIRM <code>` reply executes a staged action.
        const text = typeof event.content === "string" ? event.content : "";
        const confirmReply = await tryExecuteConfirm({ text, actor: event.from ?? "", logger });
        if (confirmReply) {
          await sendScopelyText(ctx.conversationId, confirmReply);
          return;
        }
        const messageId =
          typeof event.metadata?.messageId === "string" ? event.metadata.messageId : undefined;
        void sendComfortMessage(ctx.conversationId, messageId);
      }
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
      "[scopelybot] Registered 86 tools (10 observability + 5 admin + 4 monitoring + 6 GH + 1 correlation + 2 passthrough + 9 user-maintenance + 8 org + 15 pricing + 13 vendor-config + 8 deployment-config + 5 scoping-card)",
    );
  },
};

export default plugin;
