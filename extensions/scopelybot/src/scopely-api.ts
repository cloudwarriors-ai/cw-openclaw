import { scopelyGetAccessToken, scopelyClearSession } from "./scopely-auth.js";

const SCOPELY_URL = () => process.env.SCOPELY_URL ?? "https://scopely.pscx.ai";

export interface ScopelyFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export async function scopelyFetch(
  path: string,
  opts?: RequestInit & { retried?: boolean },
): Promise<ScopelyFetchResult> {
  const token = await scopelyGetAccessToken();
  const url = `${SCOPELY_URL()}${path}`;

  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  };
  if (opts?.body) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, {
    ...opts,
    headers,
  });

  // If 401, refresh token and retry once
  if (resp.status === 401 && !opts?.retried) {
    scopelyClearSession();
    return scopelyFetch(path, { ...opts, retried: true });
  }

  const data = resp.headers.get("content-type")?.includes("application/json")
    ? await resp.json()
    : await resp.text();

  return { ok: resp.ok, status: resp.status, data };
}

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
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
