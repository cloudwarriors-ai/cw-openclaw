/**
 * 2FA Hook Handler
 *
 * Unified trust model - all sessions work the same way:
 *
 * 1. First sensitive tool call → 2FA prompt
 * 2. After approval → session is trusted (persistent, no expiry)
 * 3. "disable trust" → clears trust, next sensitive call requires 2FA
 * 4. Protected operations (code modification) ALWAYS require fresh 2FA
 *
 * Auth Modes:
 * - "device": GitHub device flow (shows code, user enters manually)
 * - "browser": Playwright login (triggers GitHub Mobile push)
 * - "oauth": OAuth callback (tap link, instant if already logged in)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { triggerGitHub2FA } from "./browser-auth.js";
import { parseConfig, isProtectedPath, isAllowedReadPath, type AuthMode } from "./config.js";
import { requestDeviceCode, quickPollForAccessToken } from "./device-flow.js";
import { startNgrok, isNgrokRunning } from "./ngrok-manager.js";
import { createOAuthRoutes, generateApprovalUrl } from "./oauth-callback.js";
import {
  getPending,
  setPending,
  clearPending,
  isTrusted,
  enableTrust,
  revokeTrust,
  listTrustedSessions,
} from "./session-store.js";

const DEFAULT_SENSITIVE_TOOLS = ["exec", "Bash", "Write", "Edit", "NotebookEdit"];
const DEFAULT_PROTECTED_PATHS = ["src/", "extensions/", "dist/", ".openclaw/"];

/**
 * Check if a tool call is modifying a protected path.
 */
function isProtectedOperation(
  toolName: string,
  params: Record<string, unknown>,
  protectedPaths: string[],
): boolean {
  if (["Write", "Edit", "NotebookEdit", "write", "edit"].includes(toolName)) {
    const filePath =
      (params.file_path as string) ||
      (params.filePath as string) ||
      (params.path as string) ||
      (params.notebook_path as string) ||
      "";
    if (filePath && isProtectedPath(filePath, protectedPaths)) {
      return true;
    }
  }

  if (["Bash", "exec"].includes(toolName)) {
    const command = (params.command as string) || "";

    // Block commands that leak secrets
    const leakPatterns = [/^\s*env\s*$/, /\bprintenv\b/, /\bset\s*$/, /\/proc\/\S*\/environ/];
    if (leakPatterns.some((p) => p.test(command))) {
      return true;
    }

    for (const protectedPath of protectedPaths) {
      if (command.includes(protectedPath)) {
        const modifyPatterns = [
          /\b(rm|mv|cp|cat\s*>|echo\s*>|sed\s+-i|chmod|chown)\b/,
          />\s*\S/,
          />>/,
        ];
        if (modifyPatterns.some((p) => p.test(command))) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if a read operation should be gated based on allowedReadPaths.
 * Returns true if the read should be blocked (path not in whitelist).
 */
function isGatedRead(
  toolName: string,
  params: Record<string, unknown>,
  allowedReadPaths: string[] | undefined,
): boolean {
  // Only check read tool
  if (!["read", "Read"].includes(toolName)) {
    return false;
  }

  // If no allowedReadPaths configured, read is ungated (legacy behavior)
  if (!allowedReadPaths || allowedReadPaths.length === 0) {
    return false;
  }

  const filePath =
    (params.file_path as string) || (params.filePath as string) || (params.path as string) || "";

  if (!filePath) {
    return false;
  }

  // If path matches allowed list, don't gate
  if (isAllowedReadPath(filePath, allowedReadPaths)) {
    return false;
  }

  // Path not in whitelist, should be gated
  return true;
}

export function register2FAHook(api: OpenClawPluginApi): void {
  const cfg = parseConfig(api.pluginConfig);
  const authMode: AuthMode = cfg.authMode ?? "device";
  const clientId = cfg.clientId ?? process.env.GITHUB_2FA_CLIENT_ID;
  const clientSecret = cfg.clientSecret ?? process.env.GITHUB_2FA_CLIENT_SECRET;
  const baseUrl = cfg.baseUrl ?? process.env.GITHUB_2FA_BASE_URL;
  const ngrokAuthToken = cfg.ngrokAuthToken ?? process.env.NGROK_AUTH_TOKEN;
  const ngrokDomain = cfg.ngrokDomain ?? process.env.NGROK_DOMAIN;
  const gatewayPort = 18789; // Default gateway port
  const githubUsername = cfg.githubUsername ?? process.env.GITHUB_USERNAME;
  const githubPassword = cfg.githubPassword ?? process.env.GITHUB_PASSWORD;
  const headless = cfg.headless ?? true;
  const sensitiveTools = cfg.sensitiveTools ?? DEFAULT_SENSITIVE_TOOLS;
  const gateAllTools = cfg.gateAllTools ?? false;
  const protectedPaths = cfg.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const allowedReadPaths = cfg.allowedReadPaths;

  // Validate config based on mode
  if (authMode === "device" && !clientId) {
    api.logger.warn("2fa-github: No clientId configured for device mode, plugin disabled");
    return;
  }
  if (authMode === "browser" && (!githubUsername || !githubPassword)) {
    api.logger.warn(
      "2fa-github: No GitHub credentials configured for browser mode, plugin disabled",
    );
    return;
  }
  if (authMode === "oauth" && (!clientId || !clientSecret || !baseUrl)) {
    api.logger.warn(
      "2fa-github: Missing clientId, clientSecret, or baseUrl for oauth mode, plugin disabled",
    );
    return;
  }

  // Set up OAuth routes if in oauth mode
  const oauthCallbackUrl = authMode === "oauth" ? `${baseUrl}/webhook/2fa-github/callback` : "";
  const oauthStartUrl = authMode === "oauth" ? `${baseUrl}/webhook/2fa-github` : "";

  if (authMode === "oauth") {
    createOAuthRoutes(api, {
      clientId: clientId!,
      clientSecret: clientSecret!,
      callbackUrl: oauthCallbackUrl,
    });
  }

  // ============================================================================
  // AUTH HELPERS
  // ============================================================================

  async function doBrowserAuth(): Promise<
    { success: true; username: string } | { success: false; error: string }
  > {
    api.logger.info?.("2fa-github: Triggering browser auth, check GitHub Mobile...");
    return triggerGitHub2FA({
      username: githubUsername!,
      password: githubPassword!,
      headless,
      timeout: 120_000,
    });
  }

  async function doDeviceAuth(
    sessionKey: string,
  ): Promise<{ approved: true; username: string } | { approved: false; blockReason: string }> {
    const pending = getPending(sessionKey);
    if (pending) {
      const result = await quickPollForAccessToken({
        clientId: clientId!,
        deviceCode: pending.deviceCode,
      });

      if (result === "pending") {
        return {
          approved: false,
          blockReason: [
            "🔐 2FA approval pending.",
            "",
            `Code: ${pending.userCode}`,
            "",
            "Check GitHub Mobile, or enter code at github.com/login/device",
          ].join("\n"),
        };
      }

      if (result === "expired" || result === "denied") {
        clearPending(sessionKey);
      } else {
        clearPending(sessionKey);
        return { approved: true, username: result.login };
      }
    }

    const device = await requestDeviceCode(clientId!);
    const expiresAt = new Date(Date.now() + device.expires_in * 1000);
    setPending(sessionKey, {
      deviceCode: device.device_code,
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      expiresAt: expiresAt.toISOString(),
      intervalMs: Math.max(1000, device.interval * 1000),
    });

    return {
      approved: false,
      blockReason: [
        "🔐 2FA required.",
        "",
        `Code: ${device.user_code}`,
        "",
        "Check GitHub Mobile, or enter code at github.com/login/device",
      ].join("\n"),
    };
  }

  async function getOAuthBlockReason(sessionKey: string): Promise<string> {
    // Auto-start ngrok if configured
    if (ngrokAuthToken && ngrokDomain && !isNgrokRunning()) {
      api.logger.info?.("2fa-github: Starting ngrok tunnel for OAuth...");
      const result = await startNgrok({
        authToken: ngrokAuthToken,
        domain: ngrokDomain,
        port: gatewayPort,
      });
      if ("error" in result) {
        api.logger.error?.(`2fa-github: Failed to start ngrok: ${result.error}`);
        return `🔐 OAuth failed: ${result.error}`;
      }
      api.logger.info?.(`2fa-github: ngrok tunnel ready at ${result.url}`);
    }

    const approvalUrl = generateApprovalUrl(oauthStartUrl, sessionKey);
    return ["🔐 Tap to approve:", "", approvalUrl].join("\n");
  }

  // ============================================================================
  // MAIN HOOK
  // ============================================================================
  api.on("before_tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const params = event.params as Record<string, unknown>;
    // Normalize session key: strip per-request UUIDs and Zoom thread/channel IDs
    // so trust persists across all sessions for the same agent.
    // "agent:zoomwarriorssupportbot:zoom:channel:{uuid}" → "agent:zoomwarriorssupportbot"
    // "agent:main:openai:xxx" → "agent:main"
    const rawSessionKey = ctx.sessionKey ?? "default";
    const sessionKey = rawSessionKey
      .replace(/:(openai|openresponses):[0-9a-f-]+$/i, "")
      .replace(/:(zoom|telegram|discord|slack|whatsapp|signal|web):.*$/i, "");

    api.logger.info?.(`2fa-github: before_tool_call hook fired for tool: ${toolName}`);

    // ========================================================================
    // CHECK FOR GATED READ OPERATIONS
    // ========================================================================
    const gatedRead = isGatedRead(toolName, params, allowedReadPaths);
    api.logger.info?.(`2fa-github: isGatedRead result for ${toolName}: ${gatedRead}`);
    if (gatedRead) {
      api.logger.info?.(`2fa-github: Gated read operation (path not in whitelist)`);

      // Check if session is trusted
      const existingTrust = isTrusted(sessionKey);
      if (existingTrust) {
        api.logger.debug?.(`2fa-github: Trusted session ${sessionKey}, allowing read`);
        return;
      }

      // Require 2FA for non-whitelisted read
      if (authMode === "browser") {
        const result = await doBrowserAuth();
        if (result.success) {
          enableTrust(sessionKey, { githubLogin: result.username });
          api.logger.info?.(`2fa-github: Trust enabled for ${sessionKey} by ${result.username}`);
          return;
        }
        return { block: true, blockReason: `🔐 Auth failed: ${result.error}` };
      } else if (authMode === "oauth") {
        return { block: true, blockReason: await getOAuthBlockReason(sessionKey) };
      } else {
        try {
          const result = await doDeviceAuth(sessionKey);
          if (result.approved) {
            enableTrust(sessionKey, { githubLogin: result.username });
            api.logger.info?.(`2fa-github: Trust enabled for ${sessionKey} by ${result.username}`);
            return;
          }
          return { block: true, blockReason: result.blockReason };
        } catch (err) {
          return { block: true, blockReason: `🔐 Auth failed: ${String(err)}` };
        }
      }
    }

    // ========================================================================
    // CHECK IF TOOL REQUIRES GATE
    // ========================================================================
    const requiresGate = gateAllTools || sensitiveTools.includes(toolName);
    if (!requiresGate) {
      return;
    }

    // ========================================================================
    // CHECK SESSION TRUST (one approval per session, tied to GitHub user)
    // ========================================================================
    const existingTrust = isTrusted(sessionKey);

    if (existingTrust) {
      api.logger.debug?.(
        `2fa-github: Trusted session ${sessionKey} (by ${existingTrust.githubLogin})`,
      );
      return;
    }

    // ========================================================================
    // 2FA FLOW
    // ========================================================================

    if (authMode === "browser") {
      const result = await doBrowserAuth();
      if (result.success) {
        enableTrust(sessionKey, { githubLogin: result.username });
        api.logger.info?.(`2fa-github: Trust enabled for ${sessionKey} by ${result.username}`);
        return;
      }
      return { block: true, blockReason: `🔐 Auth failed: ${result.error}` };
    } else if (authMode === "oauth") {
      // OAuth mode: return link, trust is enabled via callback
      return { block: true, blockReason: await getOAuthBlockReason(sessionKey) };
    } else {
      try {
        const result = await doDeviceAuth(sessionKey);
        if (result.approved) {
          enableTrust(sessionKey, { githubLogin: result.username });
          api.logger.info?.(`2fa-github: Trust enabled for ${sessionKey} by ${result.username}`);
          return;
        }
        return { block: true, blockReason: result.blockReason };
      } catch (err) {
        return { block: true, blockReason: `🔐 Auth failed: ${String(err)}` };
      }
    }
  });

  // ============================================================================
  // TRUST MANAGEMENT TOOL
  // ============================================================================
  api.registerTool({
    name: "manage_2fa_trust",
    description: `Manage 2FA trust settings. Use when user wants to check status, disable trust, or list trusted sessions.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "disable", "list"],
          description: "The action to perform",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      const action = (params as { action: string }).action;

      if (action === "list" || action === "status") {
        const trusted = listTrustedSessions();
        if (trusted.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No sessions have trust enabled.\nNext sensitive operation will require 2FA.",
              },
            ],
          };
        }
        const list = trusted.map((t) => `- ${t.sessionKey} (${t.githubLogin})`).join("\n");
        return {
          content: [
            { type: "text", text: `Trust ENABLED for:\n${list}\n\nSay "disable trust" to revoke.` },
          ],
        };
      }

      if (action === "disable") {
        const trusted = listTrustedSessions();
        if (trusted.length === 0) {
          return { content: [{ type: "text", text: "No trust to disable." }] };
        }
        let count = 0;
        for (const t of trusted) {
          if (revokeTrust(t.sessionKey)) count++;
        }
        return {
          content: [
            {
              type: "text",
              text: `Trust DISABLED for ${count} session(s). Next sensitive op requires 2FA.`,
            },
          ],
        };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
    },
  } as AnyAgentTool);

  // Log configuration
  const modeDesc = {
    device: "device (code entry)",
    browser: "browser (GitHub Mobile push)",
    oauth: "oauth (tap link)",
  }[authMode];

  const readGateStatus = allowedReadPaths
    ? `read gated (${allowedReadPaths.length} allowed paths)`
    : "read ungated";

  api.logger.info?.(
    `2fa-github: Enabled (mode: ${modeDesc}, tools: ${sensitiveTools.join(", ")}, ${readGateStatus})`,
  );
}
