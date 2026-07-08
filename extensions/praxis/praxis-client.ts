/**
 * Praxis REST client (read-only).
 *
 * Praxis authorizes the REST surface with a single static org bearer token
 * (the `rest_api_token` credential), so this is much simpler than the ZW2
 * login flow: read base URL + token from env, attach the bearer, normalize
 * errors. Connection config is env-based to match the sibling integration
 * extensions (ZW2_*, ZWS_*); nothing here is persisted.
 *
 * The surface is pinned to Praxis's versioned contract (`/api/v1`, the
 * committed OpenAPI schema). `praxisHealth()` validates connectivity AND that
 * the server still speaks the version this client was built against, so a
 * cross-repo contract drift surfaces as a clear health failure instead of
 * mysterious 404s.
 */

const EXPECTED_API_VERSION = "v1";

const PRAXIS_BASE = (process.env.PRAXIS_API_URL ?? "http://praxis:8000").replace(/\/+$/, "");

function bearerToken(): string {
  const token = process.env.PRAXIS_API_TOKEN;
  if (!token) {
    throw new Error("PRAXIS_API_TOKEN env var required");
  }
  return token;
}

export interface PraxisResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

export function getPraxisBase(): string {
  return PRAXIS_BASE;
}

/** Raw fetch against the Praxis API with the bearer attached. Does not throw on
 * HTTP error — returns the parsed body and status so callers can decide. */
export async function praxisFetch<T = unknown>(
  endpoint: string,
  options?: RequestInit,
): Promise<PraxisResponse<T>> {
  // Every call goes through here with a fixed header set; callers never override headers, so we
  // build them explicitly rather than spreading options.headers (which may be an array form).
  const resp = await fetch(`${PRAXIS_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken()}`,
    },
  });

  const contentType = resp.headers.get("content-type") ?? "";
  const data = contentType.includes("json") ? await resp.json() : await resp.text();
  return { ok: resp.ok, status: resp.status, data: data as T };
}

/** GET that throws a normalized error on non-2xx. The token is never echoed in
 * the message; the body is included so a 400/404 reason is visible. */
export async function praxisGet<T = unknown>(endpoint: string): Promise<T> {
  const result = await praxisFetch<T>(endpoint);
  if (!result.ok) {
    const body = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    throw new Error(`Praxis API ${result.status} on ${endpoint}: ${body}`);
  }
  return result.data;
}

/** Build `/api/v1/issues` with optional repo/state filters. */
export function listIssuesPath(filters: { repo?: string; state?: string }): string {
  const params = new URLSearchParams();
  if (filters.repo) {
    params.set("repo", filters.repo);
  }
  if (filters.state) {
    params.set("state", filters.state);
  }
  const qs = params.toString();
  return qs ? `/api/v1/issues?${qs}` : "/api/v1/issues";
}

/** Build the per-issue path for either addressing mode. Callers hold `repo#number`
 * (the GitHub reference in every conversation), so that form is preferred and maps to
 * Praxis's by-number routes (praxis PR #168). `issue_id` is Praxis's INTERNAL pk —
 * the 2026-07-08 incident was the support bot feeding GitHub numbers into the pk
 * route and narrating the honest 404s as a repo-access problem. `suffix` is "" |
 * "/events" | "/diagnose". */
export function issuePath(
  params: { repo?: string; number?: number; issue_id?: number },
  suffix: "" | "/events" | "/diagnose" = "",
): string {
  if (params.repo && params.number !== undefined) {
    return `/api/v1/repos/${params.repo}/issues/${params.number}${suffix}`;
  }
  if (params.issue_id !== undefined) {
    return `/api/v1/issues/${params.issue_id}${suffix}`;
  }
  throw new Error(
    "Provide either repo + number (GitHub reference) or issue_id (Praxis internal id)",
  );
}

/** Connectivity + contract check: fetch the OpenAPI schema and confirm the
 * server's version matches the version this client targets. */
export async function praxisHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const result = await praxisFetch<{ info?: { version?: string } }>("/api/v1/schema?format=json");
    if (!result.ok) {
      return { ok: false, error: `schema fetch failed: HTTP ${result.status}` };
    }
    const version = result.data?.info?.version;
    if (version !== EXPECTED_API_VERSION) {
      return {
        ok: false,
        version,
        error: `Praxis API version mismatch: client targets ${EXPECTED_API_VERSION}, server reports ${version ?? "unknown"}`,
      };
    }
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
