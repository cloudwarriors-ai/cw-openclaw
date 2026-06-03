const SCOPELY_URL = () => process.env.SCOPELY_URL ?? "https://scopely.pscx.ai";
const SCOPELY_EMAIL = () => process.env.SCOPELY_EMAIL ?? "";
const SCOPELY_PASSWORD = () => process.env.SCOPELY_PASSWORD ?? "";

interface TokenPair {
  access: string;
  refresh: string;
  accessExpiry: number;
  refreshExpiry: number;
}

let cachedTokens: TokenPair | null = null;

// Access tokens last 1h, refresh 7d — refresh access 5 min before expiry
const ACCESS_BUFFER_MS = 5 * 60 * 1000;

export async function scopelyLogin(): Promise<TokenPair> {
  const baseUrl = SCOPELY_URL();
  const email = SCOPELY_EMAIL();
  const password = SCOPELY_PASSWORD();

  if (!email || !password) {
    throw new Error("SCOPELY_EMAIL and SCOPELY_PASSWORD must be set");
  }

  const resp = await fetch(`${baseUrl}/api/v1/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Scopely login failed (${resp.status}): ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as {
    access: string;
    refresh: string;
    access_expiration?: string;
    refresh_expiration?: string;
  };

  if (!data.access || !data.refresh) {
    throw new Error("Scopely login response missing access/refresh tokens");
  }

  const now = Date.now();
  cachedTokens = {
    access: data.access,
    refresh: data.refresh,
    // Default: access 1h, refresh 7d
    accessExpiry: data.access_expiration
      ? new Date(data.access_expiration).getTime()
      : now + 60 * 60 * 1000,
    refreshExpiry: data.refresh_expiration
      ? new Date(data.refresh_expiration).getTime()
      : now + 7 * 24 * 60 * 60 * 1000,
  };

  return cachedTokens;
}

export async function scopelyRefreshToken(): Promise<TokenPair> {
  if (!cachedTokens?.refresh) {
    return scopelyLogin();
  }

  // If refresh token itself is expired, do a full login
  if (Date.now() >= cachedTokens.refreshExpiry - ACCESS_BUFFER_MS) {
    return scopelyLogin();
  }

  const baseUrl = SCOPELY_URL();
  const resp = await fetch(`${baseUrl}/api/v1/auth/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: cachedTokens.refresh }),
  });

  if (!resp.ok) {
    // Refresh failed, try full login
    cachedTokens = null;
    return scopelyLogin();
  }

  const data = (await resp.json()) as { access: string; access_expiration?: string };
  if (!data.access) {
    cachedTokens = null;
    return scopelyLogin();
  }

  cachedTokens = {
    ...cachedTokens,
    access: data.access,
    accessExpiry: data.access_expiration
      ? new Date(data.access_expiration).getTime()
      : Date.now() + 60 * 60 * 1000,
  };

  return cachedTokens;
}

export async function scopelyGetAccessToken(): Promise<string> {
  if (cachedTokens && Date.now() < cachedTokens.accessExpiry - ACCESS_BUFFER_MS) {
    return cachedTokens.access;
  }

  if (cachedTokens?.refresh) {
    const tokens = await scopelyRefreshToken();
    return tokens.access;
  }

  const tokens = await scopelyLogin();
  return tokens.access;
}

export function scopelyClearSession(): void {
  cachedTokens = null;
}
