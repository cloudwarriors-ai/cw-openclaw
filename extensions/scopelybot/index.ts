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
import { dailyDigestEnabled, runDigestTick } from "./src/daily-digest.js";
import { registerDeploymentConfigTools } from "./src/deployment-config-tools.js";
import { registerGhTools } from "./src/gh-tools.js";
import { guardInboundMessage } from "./src/inbound-guard.js";
import { registerMonitoringTools } from "./src/monitoring-tools.js";
import { registerOrgTools } from "./src/org-tools.js";
import { runPassthroughCycle } from "./src/passthrough-runner-cycle.js";
import { registerPassthroughTools } from "./src/passthrough-tools.js";
import { registerPricingTools } from "./src/pricing-tools.js";
import { registerScopelyTools } from "./src/scopely-tools.js";
import { registerScopingCardTools } from "./src/scoping-card-tools.js";
import { registerSessionLifecycleTools } from "./src/session-lifecycle-tools.js";
import { registerSowTools } from "./src/sow-tools.js";
import { superviseFinalize } from "./src/supervisor.js";
import { registerSupportTicketTools } from "./src/support-ticket-tools.js";
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
let digestHandle: NodeJS.Timeout | null = null;

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
    // Slice E: the end-user support surface's one ungated write (tickets
    // create work for us, not product mutations). Allowlisted only to the
    // scopely-support agent in openclaw.json — the admin bot doesn't get it.
    registerSupportTicketTools(optionalApi, logger, pluginConfig);
    registerSessionLifecycleTools(optionalApi, logger);
    registerSowTools(optionalApi, logger);
    registerApproverTools(optionalApi, logger, approverStore);

    // Zoom card bodies do not render Markdown. Keep this rewrite at the Scopely
    // plugin boundary so other agents and channels retain their existing output.
    api.on("message_sending", (event, ctx) => rewriteScopelyBotZoomMessage(event.content, ctx));

    // Runtime supervisor (Slice S): review the coordinator's draft final reply
    // before it is accepted — deterministic rules/grounding checks plus the
    // opt-in voice-judge lane, with bounded revision passes and a fuse that
    // escalates to a named human instead of retrying forever. Opt-in via
    // SCOPELYBOT_SUPERVISOR=1 (checked inside superviseFinalize, at call
    // time); scoped inside to agent:scopelybot: sessions so other bots' turns
    // are untouched. llmComplete powers only the voice lane
    // (SCOPELYBOT_SUPERVISOR_VOICE=1): api.runtime.llm.complete is
    // plugin-scoped by the host, and the judge's model override additionally
    // requires plugins.entries.scopelybot.llm.allowModelOverride in the host
    // config — absent that, the lane fails open. NOTE: this is a
    // conversation-typed hook — non-bundled deployments must also set
    // plugins.entries.scopelybot.hooks.allowConversationAccess=true or the
    // registry drops it with a warn diagnostic (src/plugins/registry.ts).
    api.on("before_agent_finalize", (event) =>
      superviseFinalize(event, {
        logger,
        llmComplete: async (params) => api.runtime.llm.complete(params),
      }),
    );

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
      // Slice 4: the inbound text drives deterministic domain classification
      // (context-aware comfort) and the trivial-greeting skip inside comfort.ts.
      void sendComfortMessage(ctx.conversationId, messageId, text);
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

    // Inbound guard (Slice S2-B): deterministic ingress screening, registered
    // AFTER the confirm gate — before_dispatch handlers run in registration
    // order within a plugin, so a real `CONFIRM <code>` is always claimed by
    // the gate first (and the guard structurally skips CONFIRM shapes too).
    // Scoped to scopelybot's own Zoom surface with the same session-key proof
    // the other hooks use. Opt-in via SCOPELYBOT_INBOUND_GUARD=1 (checked
    // inside guardInboundMessage, at call time) — unset means this handler is
    // a no-op. NOTE: like the confirm gate, a hard block's refusal text is
    // dropped if another hook already set suppressDelivery — acceptable,
    // mirrored behavior.
    api.on("before_dispatch", (event, ctx) => {
      if (
        !isScopelyBotZoomMessage({ channelId: ctx.channelId ?? "", sessionKey: ctx.sessionKey })
      ) {
        return;
      }
      const text = typeof event.content === "string" ? event.content : "";
      return guardInboundMessage(
        { text, senderId: ctx.senderId ?? "", sessionKey: ctx.sessionKey },
        { logger },
      );
    });

    // Interval scheduling pattern (2026-07-21 prod incident + follow-up):
    //   1. NEVER wire timers to `gateway:startup` — it is emitted exactly once
    //      ~250ms after boot to listeners that exist AT BOOT
    //      (src/gateway/server-startup-post-attach.ts), and scopelybot
    //      registers LAZILY on first inbound, so such a hook never fires here.
    //   2. `api.registerHook` also THROWS on missing opts.name (registry.ts
    //      "hook registration missing name"), and a throw in register() fails
    //      the ENTIRE plugin — the incident that killed every scopelybot tool.
    //   Instead: start the unref'd interval directly in register() and hand
    //   cleanup to api.lifecycle.registerRuntimeLifecycle (diagnostic-based
    //   surface — registration problems log, never throw; cleanup runs on
    //   plugin disable/reset/delete/restart via runPluginHostCleanup).

    // Schedule recurring passthrough test runs.
    // Disabled if PASSTHROUGH_RUNNER_ENABLED is not "1" or SCOPELY_REPO_PATH is unset.
    const runnerEnabled = process.env.PASSTHROUGH_RUNNER_ENABLED === "1";
    const repoPath = process.env.SCOPELY_REPO_PATH;
    if (runnerEnabled && repoPath) {
      const interval = Math.max(
        MIN_INTERVAL_MS,
        Number(process.env.PASSTHROUGH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS),
      );
      // Run once at registration, then on the configured interval.
      void runPassthroughCycle(workspaceDir, { source: "scheduled" }).catch((err) => {
        console.error("[scopelybot-passthrough] startup cycle failed:", err);
      });
      if (intervalHandle) clearInterval(intervalHandle); // re-register safety
      intervalHandle = setInterval(() => {
        void runPassthroughCycle(workspaceDir, { source: "scheduled" }).catch((err) => {
          console.error("[scopelybot-passthrough] scheduled cycle failed:", err);
        });
      }, interval);
      // Don't keep the process alive solely for this timer.
      intervalHandle.unref?.();
      api.lifecycle.registerRuntimeLifecycle({
        id: "scopelybot-passthrough-runner",
        description: "Clears the scheduled passthrough-cycle interval",
        cleanup: () => {
          if (intervalHandle) {
            clearInterval(intervalHandle);
            intervalHandle = null;
          }
        },
      });
      console.log(`[scopelybot-passthrough] runner enabled, interval=${interval}ms`);
    } else {
      console.log(
        "[scopelybot-passthrough] runner disabled (set PASSTHROUGH_RUNNER_ENABLED=1 and SCOPELY_REPO_PATH to enable)",
      );
    }

    // Daily digest (Slice 4, SCOPELYBOT_DAILY_DIGEST=1): a minute tick that
    // fires at most once per UTC day past SCOPELYBOT_DIGEST_HOUR_UTC, with the
    // last-posted date persisted in the workspace (restart-safe). Interval
    // starts here in register() per the scheduling pattern above.
    if (dailyDigestEnabled()) {
      if (digestHandle) clearInterval(digestHandle); // re-register safety
      digestHandle = setInterval(() => {
        void runDigestTick(workspaceDir).catch((err) => {
          console.error("[scopelybot-digest] tick failed:", err);
        });
      }, 60_000);
      digestHandle.unref?.();
      api.lifecycle.registerRuntimeLifecycle({
        id: "scopelybot-daily-digest",
        description: "Clears the daily-digest minute tick",
        cleanup: () => {
          if (digestHandle) {
            clearInterval(digestHandle);
            digestHandle = null;
          }
        },
      });
      console.log("[scopelybot-digest] daily digest enabled");
    }

    console.log(
      "[scopelybot] Registered 116 tools (11 observability + 6 admin + 4 monitoring + 6 GH + 1 correlation + 2 passthrough + 9 user-maintenance + 8 org + 15 pricing + 13 vendor-config + 8 deployment-config + 5 scoping-card + 11 support + 1 support-ticket + 11 session-lifecycle + 5 sow)",
    );
  },
};

export default plugin;
