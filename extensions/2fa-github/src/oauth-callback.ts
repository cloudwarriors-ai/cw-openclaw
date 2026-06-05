/**
 * OAuth Callback Handler
 *
 * Handles the GitHub OAuth flow for 2FA approval:
 * 1. /start?session=xyz - Redirects to GitHub OAuth
 * 2. /callback?code=xyz&state=xyz - Handles GitHub callback, marks session approved
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { enableTrust } from "./session-store.js";

// In-memory store for pending OAuth states
const pendingOAuth = new Map<string, { sessionKey: string; expiresAt: number }>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingOAuth) {
    if (data.expiresAt < now) {
      pendingOAuth.delete(state);
    }
  }
}, 60_000);

function generateState(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function createOAuthRoutes(
  api: OpenClawPluginApi,
  config: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
  },
): void {
  const { clientId, clientSecret, callbackUrl } = config;

  // Store approved sessions that haven't been picked up yet
  const approvedSessions = new Map<string, { githubLogin: string; approvedAt: number }>();

  /**
   * GET /webhook/2fa-github/start?session=xyz
   * Initiates OAuth flow by redirecting to GitHub
   */
  api.registerHttpRoute({
    path: "/webhook/2fa-github/start",
    auth: "plugin",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Strip trailing markdown/URL artifacts that leak in when bots wrap the link
      const rawSession = url.searchParams.get("session");
      const sessionKey = rawSession?.replace(/[)\]*\s]+$/, "").trim() ?? null;

      if (!sessionKey) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain");
        res.end("Missing session parameter");
        return;
      }

      // Generate state for CSRF protection
      const state = generateState();
      pendingOAuth.set(state, {
        sessionKey,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      });

      // Build GitHub OAuth URL
      const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
      githubAuthUrl.searchParams.set("client_id", clientId);
      githubAuthUrl.searchParams.set("redirect_uri", callbackUrl);
      githubAuthUrl.searchParams.set("scope", "read:user");
      githubAuthUrl.searchParams.set("state", state);

      // Redirect to GitHub
      res.statusCode = 302;
      res.setHeader("Location", githubAuthUrl.toString());
      res.end();
    },
  });

  /**
   * GET /webhook/2fa-github/callback?code=xyz&state=xyz
   * Handles GitHub OAuth callback
   */
  api.registerHttpRoute({
    path: "/webhook/2fa-github/callback",
    auth: "plugin",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(renderHtml("Authorization Denied", "You denied the authorization request."));
        return;
      }

      if (!code || !state) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain");
        res.end("Missing code or state");
        return;
      }

      // Verify state
      const pending = pendingOAuth.get(state);
      if (!pending) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html");
        res.end(
          renderHtml("Invalid Request", "This authorization link has expired or is invalid."),
        );
        return;
      }

      pendingOAuth.delete(state);

      // Exchange code for access token
      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: callbackUrl,
          }),
        });

        const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };

        if (!tokenData.access_token) {
          api.logger.error?.(`2fa-github: OAuth token exchange failed: ${tokenData.error}`);
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/html");
          res.end(renderHtml("Authorization Failed", "Failed to complete authorization."));
          return;
        }

        // Get user info
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/json",
          },
        });

        const userData = (await userRes.json()) as { login?: string };
        const githubLogin = userData.login ?? "unknown";

        // Enable trust for the session
        enableTrust(pending.sessionKey, { githubLogin });
        api.logger.info?.(`2fa-github: OAuth approval for ${pending.sessionKey} by ${githubLogin}`);

        // Also store in approved sessions for immediate pickup
        approvedSessions.set(pending.sessionKey, {
          githubLogin,
          approvedAt: Date.now(),
        });

        // Clean up old approved sessions after 5 minutes
        setTimeout(
          () => {
            approvedSessions.delete(pending.sessionKey);
          },
          5 * 60 * 1000,
        );

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(
          renderHtml("Approved", `Session authorized as ${githubLogin}. You can close this tab.`),
        );
      } catch (err) {
        api.logger.error?.(`2fa-github: OAuth callback error: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/html");
        res.end(renderHtml("Error", "An error occurred during authorization."));
      }
    },
  });

  /**
   * GET /webhook/2fa-github/check?session=xyz
   * Check if a session has been approved (for polling)
   */
  api.registerHttpRoute({
    path: "/webhook/2fa-github/check",
    auth: "plugin",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const sessionKey = url.searchParams.get("session");

      res.setHeader("Content-Type", "application/json");

      if (!sessionKey) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "Missing session parameter" }));
        return;
      }

      const approved = approvedSessions.get(sessionKey);
      if (approved) {
        res.statusCode = 200;
        res.end(JSON.stringify({ approved: true, githubLogin: approved.githubLogin }));
        return;
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ approved: false }));
    },
  });

  api.logger.info?.(`2fa-github: OAuth routes registered (callback: ${callbackUrl})`);
}

function renderHtml(title: string, message: string): string {
  const isSuccess = title.toLowerCase().includes("approved");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #0d1117;
      color: #c9d1d9;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      color: ${isSuccess ? "#3fb950" : "#f85149"};
    }
    p {
      font-size: 1.1rem;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${isSuccess ? "✓ " : ""}${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

/**
 * Generate an approval URL for a session
 */
export function generateApprovalUrl(baseUrl: string, sessionKey: string): string {
  return `${baseUrl}/start?session=${encodeURIComponent(sessionKey)}`;
}
