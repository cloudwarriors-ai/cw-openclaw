import * as z from "zod";
import type { DashboardConfig, DashboardUser } from "./types.js";

const userSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password_hash: z.string().trim().min(1).max(1024),
  tenant_id: z.string().trim().min(1).max(256),
  display_name: z.string().trim().min(1).max(128).optional(),
});

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseUsers(env: NodeJS.ProcessEnv): DashboardUser[] {
  const raw = env.SLM_DASHBOARD_USERS_JSON?.trim();
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    const users = z.array(userSchema).min(1).parse(parsed);
    return users.map((entry) => ({
      username: entry.username,
      passwordHash: entry.password_hash,
      tenantId: entry.tenant_id,
      displayName: entry.display_name,
    }));
  }

  const username = env.SLM_DASHBOARD_USER?.trim();
  const passwordHash = env.SLM_DASHBOARD_PASSWORD_HASH?.trim();
  const tenantId = env.SLM_DASHBOARD_TENANT_ID?.trim();
  const displayName = env.SLM_DASHBOARD_DISPLAY_NAME?.trim();
  if (username && passwordHash && tenantId) {
    return [
      {
        username,
        passwordHash,
        tenantId,
        displayName: displayName || undefined,
      },
    ];
  }

  throw new Error(
    [
      "SLM dashboard users are not configured.",
      "Set SLM_DASHBOARD_USERS_JSON to a JSON array with username/password_hash/tenant_id entries,",
      "or set SLM_DASHBOARD_USER + SLM_DASHBOARD_PASSWORD_HASH + SLM_DASHBOARD_TENANT_ID.",
    ].join(" "),
  );
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function loadDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const port = parseInteger(env.PORT, 3875, 1, 65535);
  const sessionTtlSeconds = parseInteger(env.SLM_DASHBOARD_SESSION_TTL_SECONDS, 28_800, 60, 604_800);
  const secureDefault = env.NODE_ENV === "production";
  const cookieSecure = parseBoolean(env.SLM_DASHBOARD_COOKIE_SECURE, secureDefault);
  const cookieName = env.SLM_DASHBOARD_COOKIE_NAME?.trim() || "slm_dashboard_session";
  const gatewayTimeoutMs = parseInteger(env.SLM_DASHBOARD_GATEWAY_TIMEOUT_MS, 15_000, 1_000, 120_000);
  const gatewayUrl = env.SLM_DASHBOARD_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789";
  const users = parseUsers(env);

  return {
    port,
    cookieName,
    cookieSecure,
    sessionTtlMs: sessionTtlSeconds * 1000,
    gatewayUrl,
    gatewayToken: env.SLM_DASHBOARD_GATEWAY_TOKEN?.trim() || undefined,
    gatewayPassword: env.SLM_DASHBOARD_GATEWAY_PASSWORD?.trim() || undefined,
    gatewayTimeoutMs,
    users,
  };
}
