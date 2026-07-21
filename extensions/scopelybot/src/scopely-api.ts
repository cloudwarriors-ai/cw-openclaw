import { redactText, redactValue } from "./redaction.js";
import { scopelyCookieHeader, scopelyEnsureAuth, scopelyClearSession } from "./scopely-auth.js";

const SCOPELY_URL = () =>
  process.env.SCOPELY_BASE_URL ?? process.env.SCOPELY_URL ?? "https://vip.pscx.ai";

export interface ScopelyFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function scopelyFetch(
  path: string,
  opts?: RequestInit & { retried?: boolean },
): Promise<ScopelyFetchResult> {
  await scopelyEnsureAuth();
  const url = `${SCOPELY_URL()}${path}`;

  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> | undefined),
    Cookie: scopelyCookieHeader(),
  };
  if (opts?.body) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, {
    ...opts,
    headers,
  });

  // BFF returns 401 when the access cookie has expired or been blacklisted.
  // Drop the jar and retry once with a fresh login.
  if (resp.status === 401 && !opts?.retried) {
    scopelyClearSession();
    return scopelyFetch(path, { ...opts, retried: true });
  }

  // Read as text first, then parse. DRF answers DELETE with 204 No Content but
  // STILL sets Content-Type: application/json on the empty body — resp.json()
  // throws "Unexpected end of JSON input", which surfaced live (2026-07-21) as
  // a false "❌ Error executing DELETE …" on a delete that had SUCCEEDED.
  // Empty or malformed bodies fall back to the raw text: an honest payload
  // beats an exception that misreports a completed mutation as a failure.
  const raw = await resp.text();
  let data: unknown = raw;
  if (resp.headers.get("content-type")?.includes("application/json") && raw.trim() !== "") {
    try {
      data = JSON.parse(raw);
    } catch {
      // Content-Type lied — keep the raw text.
    }
  }

  return { ok: resp.ok, status: resp.status, data };
}

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(redactValue(data)) }] };
}

export function errorResult(err: unknown) {
  const message = redactText(err instanceof Error ? err.message : String(err), 1000);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}

export function buildQuery(params: Record<string, unknown>, keys: string[]): string {
  const qs = new URLSearchParams();
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === null) {
      continue;
    }
    // Only stringify primitives — skip objects/arrays so we don't emit "[object Object]"
    if (typeof value === "string") {
      qs.set(key, value);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      qs.set(key, String(value));
    }
  }
  const str = qs.toString();
  return str ? `?${str}` : "";
}
