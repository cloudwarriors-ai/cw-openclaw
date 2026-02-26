/**
 * Shared Tesseract authentication module.
 * Uses a global singleton so the access token is shared across the extension.
 * Follows the same pattern as zw2-auth.ts in zoomwarriors.
 *
 * Per-channel session isolation: each channel/conversation gets its own
 * active user session with automatic expiry (default 1 hour).
 */

if (!process.env.TESSERACT_URL) {
  throw new Error("TESSERACT_URL env var is required. Set it to the internal backend URL (e.g., http://playground-backend:8000).");
}
if (!process.env.TESSERACT_EXTERNAL_URL) {
  throw new Error("TESSERACT_EXTERNAL_URL env var is required. Set it to the browser-accessible backend URL (e.g., http://localhost:8130).");
}

const TESSERACT_URL = process.env.TESSERACT_URL;
const TESSERACT_EXTERNAL_URL = process.env.TESSERACT_EXTERNAL_URL;

/** Rewrite an internal URL to be browser-accessible. */
export function externalizeUrl(internalUrl: string): string {
  return internalUrl.replace(TESSERACT_URL, TESSERACT_EXTERNAL_URL);
}

/** How long a channel session stays active without activity (ms). Default: 24 hours. */
const SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000;

/**
 * Invalid/generic session keys that must not be used for credential isolation.
 * If the framework provides one of these, treat it as "no channel" — require sign-in.
 */
const INVALID_CHANNEL_KEYS = new Set(["unknown", "_default", "global", ""]);

interface ChannelSession {
  email: string;
  connectedAt: number;
  lastActivityAt: number;
}

interface TesseractAuthState {
  token: string | null;
  /** Per-channel user sessions keyed by channel identifier. */
  sessions: Map<string, ChannelSession>;
}

// Global singleton — survives across plugin boundaries
const GLOBAL_KEY = "__tesseract_auth_state__";
const g = globalThis as Record<string, unknown>;
if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = { token: null, sessions: new Map() };
}
const state = g[GLOBAL_KEY] as TesseractAuthState;

// Ensure sessions is a Map (handles upgrade from old asUser format)
if (!(state.sessions instanceof Map)) {
  state.sessions = new Map();
}
/**
 * Set the active user for a specific channel. Pass null email to disconnect.
 * Channel is REQUIRED — we never store credentials under a shared/default key.
 */
export function setActiveUser(email: string | null, channel?: string): void {
  if (!channel || INVALID_CHANNEL_KEYS.has(channel)) {
    throw new Error(
      "Channel identifier is required for session management. " +
      "Cannot store credentials without a specific channel key. " +
      `Got: ${JSON.stringify(channel)}`
    );
  }
  if (!email) {
    state.sessions.delete(channel);
  } else {
    state.sessions.set(channel, {
      email,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
    });
  }
}

/**
 * Get the currently active user email for a channel (null = not connected).
 * Resets the inactivity timer on each access.
 * Returns null if channel is missing or is a generic/shared key — never defaults.
 */
export function getActiveUser(channel?: string): string | null {
  if (!channel || INVALID_CHANNEL_KEYS.has(channel)) return null;

  const session = state.sessions.get(channel);
  if (!session) return null;

  // Check inactivity — expire if no activity for SESSION_INACTIVITY_MS
  if (Date.now() - session.lastActivityAt > SESSION_INACTIVITY_MS) {
    state.sessions.delete(channel);
    return null;
  }

  // Reset inactivity timer
  session.lastActivityAt = Date.now();
  return session.email;
}

/**
 * Get session info for a channel (for who_am_i).
 * Returns "not connected" if channel is missing or is a generic key.
 */
export function getSessionInfo(channel?: string): {
  email: string | null;
  connectedAt: number | null;
  lastActivityAt: number | null;
  inactivityTimeoutHours: number | null;
} {
  if (!channel || INVALID_CHANNEL_KEYS.has(channel)) {
    return { email: null, connectedAt: null, lastActivityAt: null, inactivityTimeoutHours: null };
  }
  const session = state.sessions.get(channel);
  if (!session || Date.now() - session.lastActivityAt > SESSION_INACTIVITY_MS) {
    if (session) state.sessions.delete(channel);
    return { email: null, connectedAt: null, lastActivityAt: null, inactivityTimeoutHours: null };
  }
  return {
    email: session.email,
    connectedAt: session.connectedAt,
    lastActivityAt: session.lastActivityAt,
    inactivityTimeoutHours: SESSION_INACTIVITY_MS / (60 * 60 * 1000),
  };
}

/** List all active (non-expired) sessions. */
export function listSessions(): Array<{ channel: string; email: string; idleSinceMinutes: number }> {
  const now = Date.now();
  const active: Array<{ channel: string; email: string; idleSinceMinutes: number }> = [];
  for (const [channel, session] of state.sessions.entries()) {
    if (now - session.lastActivityAt > SESSION_INACTIVITY_MS) {
      state.sessions.delete(channel);
    } else {
      active.push({
        channel,
        email: session.email,
        idleSinceMinutes: Math.round((now - session.lastActivityAt) / 60000),
      });
    }
  }
  return active;
}

/** Clear all sessions (used for testing). */
export function clearAllSessions(): void {
  state.sessions.clear();
}

export async function tesseractLogin(): Promise<void> {
  const email = process.env.TESSERACT_USERNAME;
  const password = process.env.TESSERACT_PASSWORD;
  if (!email || !password) {
    throw new Error("TESSERACT_USERNAME and TESSERACT_PASSWORD env vars required");
  }

  const resp = await fetch(`${TESSERACT_URL}/api/auth/login-csrf-free/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!resp.ok) throw new Error(`Tesseract login failed: ${resp.status}`);
  const data = (await resp.json()) as Record<string, unknown>;
  state.token = data.access_token as string;
}

/**
 * Execute a tool via the backend's tool proxy endpoint.
 * Handles auth automatically — logs in on first call and retries on 401.
 * Pass `channel` to scope the as_user lookup to a specific channel.
 */
export async function tesseractToolCall(
  tool: string,
  args: Record<string, unknown>,
  channel?: string,
): Promise<unknown> {
  if (!state.token) await tesseractLogin();

  const asUser = getActiveUser(channel);

  const doCall = async (): Promise<Response> =>
    fetch(`${TESSERACT_URL}/api/chat/tool-proxy/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({
        tool,
        arguments: args,
        ...(asUser ? { as_user: asUser } : {}),
      }),
    });

  let resp = await doCall();
  if (resp.status === 401 || resp.status === 403) {
    await tesseractLogin();
    resp = await doCall();
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Tesseract tool proxy error ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json();
}

/**
 * List available tools from the backend.
 */
export async function tesseractListTools(): Promise<string[]> {
  if (!state.token) await tesseractLogin();

  const resp = await fetch(`${TESSERACT_URL}/api/chat/tools/`, {
    headers: { Authorization: `Bearer ${state.token}` },
  });

  if (!resp.ok) return [];
  const data = (await resp.json()) as { tools: string[] };
  return data.tools;
}

/**
 * Direct fetch to the Tesseract backend (for non-proxy calls).
 */
export async function tesseractFetch(
  endpoint: string,
  options?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!state.token) await tesseractLogin();

  const doFetch = async (): Promise<Response> =>
    fetch(`${TESSERACT_URL}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
        Authorization: `Bearer ${state.token}`,
      },
    });

  let resp = await doFetch();
  if (resp.status === 401) {
    await tesseractLogin();
    resp = await doFetch();
  }

  const data = resp.headers.get("content-type")?.includes("application/json")
    ? await resp.json()
    : await resp.text();

  return { ok: resp.ok, status: resp.status, data };
}

export function getTesseractUrl(): string {
  return TESSERACT_URL;
}
