// Cookie-jar auth for the VIP Next.js BFF. The BFF strips JWTs from the login
// response body and sets them as HttpOnly cookies (access_token + refresh_token).
// We capture those cookies and replay them on subsequent calls.

const SCOPELY_URL = () =>
  process.env.SCOPELY_BASE_URL ?? process.env.SCOPELY_URL ?? "https://vip.pscx.ai";
const SCOPELY_EMAIL = () => process.env.SCOPELY_EMAIL ?? "";
const SCOPELY_PASSWORD = () => process.env.SCOPELY_PASSWORD ?? "";

interface CookieJar {
  access?: string;
  refresh?: string;
  // Wall-clock ms when the access token expires, derived from Set-Cookie Max-Age.
  accessExpiry?: number;
}

let jar: CookieJar = {};

// Refresh ACCESS_BUFFER_MS before expiry to avoid racing the deadline.
const ACCESS_BUFFER_MS = 60 * 1000;

function parseSetCookies(headers: Headers): Record<string, { value: string; maxAge?: number }> {
  // Node's fetch Headers exposes getSetCookie() (Node 18+); fall back to single header.
  const lines: string[] =
    typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [headers.get("set-cookie") ?? ""].filter(Boolean);

  const out: Record<string, { value: string; maxAge?: number }> = {};
  for (const line of lines) {
    const parts = line.split(";").map((s) => s.trim());
    const [pair, ...attrs] = parts;
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const maxAgeAttr = attrs.find((a) => /^max-age=/i.test(a));
    const maxAge = maxAgeAttr ? Number(maxAgeAttr.split("=")[1]) : undefined;
    out[name] = { value, maxAge };
  }
  return out;
}

function applyCookiesFromResponse(resp: Response): void {
  const cookies = parseSetCookies(resp.headers);
  if (cookies.access_token) {
    jar.access = cookies.access_token.value;
    jar.accessExpiry = Date.now() + (cookies.access_token.maxAge ?? 3600) * 1000;
  }
  if (cookies.refresh_token) {
    jar.refresh = cookies.refresh_token.value;
  }
}

export function scopelyCookieHeader(): string {
  const parts: string[] = [];
  if (jar.access) parts.push(`access_token=${jar.access}`);
  if (jar.refresh) parts.push(`refresh_token=${jar.refresh}`);
  return parts.join("; ");
}

export async function scopelyLogin(): Promise<void> {
  const email = SCOPELY_EMAIL();
  const password = SCOPELY_PASSWORD();
  if (!email || !password) {
    throw new Error("SCOPELY_EMAIL and SCOPELY_PASSWORD must be set");
  }
  const resp = await fetch(`${SCOPELY_URL()}/api/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Scopely login failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  applyCookiesFromResponse(resp);
  if (!jar.access) {
    throw new Error("Scopely login response missing access_token cookie");
  }
}

async function scopelyRefresh(): Promise<boolean> {
  if (!jar.refresh) return false;
  const resp = await fetch(`${SCOPELY_URL()}/api/auth/refresh`, {
    method: "POST",
    headers: { Cookie: scopelyCookieHeader() },
  });
  if (!resp.ok) {
    jar = {};
    return false;
  }
  applyCookiesFromResponse(resp);
  return Boolean(jar.access);
}

export async function scopelyEnsureAuth(): Promise<void> {
  if (jar.access && Date.now() < (jar.accessExpiry ?? 0) - ACCESS_BUFFER_MS) {
    return;
  }
  if (await scopelyRefresh()) {
    return;
  }
  await scopelyLogin();
}

export function scopelyClearSession(): void {
  jar = {};
}
