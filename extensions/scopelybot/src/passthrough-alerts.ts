import type { PassthroughTestState } from "./passthrough-state.js";

/**
 * Posts structured passthrough alerts to the ScopelyBot Zoom channel.
 * Reuses the same Zoom client-credentials OAuth pattern as comfort.ts.
 */

const ZOOM_API_BASE = "https://api.zoom.us";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getZoomToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }
  const clientId = process.env.ZOOM_CLIENT_ID ?? "";
  const clientSecret = process.env.ZOOM_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    return null;
  }

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await fetch("https://zoom.us/oauth/token?grant_type=client_credentials", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!resp.ok) {
      console.error(`[scopelybot-passthrough] Zoom token failed: ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as { access_token: string; expires_in: number };
    cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cachedToken.token;
  } catch (err) {
    console.error("[scopelybot-passthrough] Zoom token error:", err);
    return null;
  }
}

async function postToZoomChannel(headerText: string, lines: string[]): Promise<void> {
  const channel = process.env.SCOPELYBOT_ZOOM_CHANNEL ?? "";
  const botJid = process.env.ZOOM_BOT_JID ?? "";
  const accountId = process.env.ZOOM_ACCOUNT_ID ?? "";
  if (!channel || !botJid || !accountId) {
    console.warn("[scopelybot-passthrough] Zoom channel/bot config missing — skipping alert");
    return;
  }

  const token = await getZoomToken();
  if (!token) {
    return;
  }

  const body = {
    robot_jid: botJid,
    to_jid: channel,
    account_id: accountId,
    content: {
      head: { text: headerText },
      body: lines.map((text) => ({ type: "message", text })),
    },
  };

  try {
    const resp = await fetch(`${ZOOM_API_BASE}/v2/im/chat/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`[scopelybot-passthrough] Zoom post failed: ${resp.status}`);
    }
  } catch (err) {
    console.error("[scopelybot-passthrough] Zoom post error:", err);
  }
}

function formatTestForAlert(test: PassthroughTestState): string {
  const lines = [
    `• [${test.passthrough}] failed ${test.consecutiveFailures}× in a row`,
    `  ${test.testTitle}`,
  ];
  if (test.errorMessage) {
    lines.push(`  Error: ${test.errorMessage.slice(0, 200)}`);
  }
  return lines.join("\n");
}

export async function postFailureAlert(failingTests: PassthroughTestState[]): Promise<void> {
  if (failingTests.length === 0) {
    return;
  }

  const header = `🚨 Scopely passthrough failure (${failingTests.length})`;
  const body = [
    `${failingTests.length} passthrough test${failingTests.length === 1 ? "" : "s"} crossed the failure threshold:`,
    "",
    ...failingTests.map(formatTestForAlert),
    "",
    `Run \`scopely_passthrough_status\` in chat for full state.`,
  ];

  await postToZoomChannel(header, body);
}

export async function postRecoveryAlert(recoveredTests: PassthroughTestState[]): Promise<void> {
  if (recoveredTests.length === 0) {
    return;
  }

  const header = `✅ Scopely passthrough recovered (${recoveredTests.length})`;
  const body = [
    `${recoveredTests.length} passthrough test${recoveredTests.length === 1 ? "" : "s"} recovered:`,
    "",
    ...recoveredTests.map((t) => `• [${t.passthrough}] ${t.testTitle}`),
  ];

  await postToZoomChannel(header, body);
}

export async function postRunnerErrorAlert(errorMessage: string): Promise<void> {
  // Distinct from passthrough failures — this means the runner itself broke.
  const header = `⚠️ Scopely passthrough runner error`;
  const body = [
    `The passthrough test runner could not execute:`,
    "",
    errorMessage.slice(0, 500),
    "",
    `Tests did not run this cycle. Check SCOPELY_REPO_PATH and Playwright installation.`,
  ];

  await postToZoomChannel(header, body);
}
