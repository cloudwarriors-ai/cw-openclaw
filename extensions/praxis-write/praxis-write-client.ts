/**
 * Praxis REST client (write surface).
 *
 * A deliberate copy of the read plugin's client rather than a shared import:
 * extension packages are isolated (see extensions/CLAUDE.md — prod code may not
 * reach into a sibling extension), so the write plugin owns its own thin client.
 *
 * Praxis authorizes the REST surface with a single static org bearer token (the
 * `rest_api_token` credential), read from env. The surface is pinned to the
 * versioned contract (`/api/v1`). Authorization for a command binds server-side
 * to the configured operator; this client only carries the command + the audit
 * context (requested_by / channel / message_id) the server records.
 */

const PRAXIS_BASE = (process.env.PRAXIS_API_URL ?? "http://praxis:8000").replace(/\/+$/, "");

/** The bearer token, read lazily per call so a missing token fails the call, not module load. */
export function getApiToken(): string {
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

/** The fields of an issue the write flow needs: the confirm token binds to these
 * so a confirm that races a state change fails closed. */
export interface PraxisIssueState {
  id: number;
  state: string;
  state_reason: string;
  version: number;
}

/** The audit context recorded on the event row. Authorization is NOT here — it
 * binds to the server's configured operator. These describe the real requester. */
export interface CommandAuditContext {
  requested_by: string;
  channel: string;
  message_id: string;
  idempotency_key: string;
}

export function getPraxisBase(): string {
  return PRAXIS_BASE;
}

/** Raw fetch with the bearer attached. Does not throw on HTTP error — returns the
 * parsed body and status so callers map the structured command result themselves. */
export async function praxisFetch<T = unknown>(
  endpoint: string,
  options?: RequestInit,
): Promise<PraxisResponse<T>> {
  const resp = await fetch(`${PRAXIS_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiToken()}`,
    },
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const data = contentType.includes("json") ? await resp.json() : await resp.text();
  return { ok: resp.ok, status: resp.status, data: data as T };
}

/** GET that throws a normalized error on non-2xx. The token is never echoed. */
export async function praxisGet<T = unknown>(endpoint: string): Promise<T> {
  const result = await praxisFetch<T>(endpoint);
  if (!result.ok) {
    const body = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    throw new Error(`Praxis API ${result.status} on ${endpoint}: ${body}`);
  }
  return result.data;
}

/** Fetch the current issue state used to build + bind the confirm token. */
export async function getIssue(issueId: number): Promise<PraxisIssueState> {
  return praxisGet<PraxisIssueState>(`/api/v1/issues/${issueId}`);
}

/** Submit an operator command. Returns the raw structured result + HTTP status so
 * the tool surfaces Praxis's own error/applied/rejected/idempotent outcome verbatim.
 * The server derives any payload and binds authorization to its operator; we send
 * only the command kind + reason + audit context. */
export async function submitCommand(
  issueId: number,
  command: { kind: string; reason: string } & CommandAuditContext,
): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>(`/api/v1/issues/${issueId}/events`, {
    method: "POST",
    body: JSON.stringify(command),
  });
}

/** The UAT verdict kinds accepted by the events endpoint. uat1 = dev_uat stage,
 * uat2 = user_uat stage. The correct kind is determined from the issue's current
 * state, not passed by the model. */
export type UatVerdictKind = "uat1_pass" | "uat1_fail" | "uat2_pass" | "uat2_fail";

/** Map a Praxis issue state to its UAT kind prefix, or undefined when the issue
 * is not currently awaiting a UAT verdict. Exported for testing. */
export function mapStateToUatKindPrefix(state: string): "uat1" | "uat2" | undefined {
  if (state === "dev_uat") {
    return "uat1";
  }
  if (state === "user_uat") {
    return "uat2";
  }
  return undefined;
}

/** Submit a UAT verdict event. `channel_user_id` is the verified Zoom sender id
 * from the trusted runtime context — the server uses it for identity binding. */
export async function submitVerdict(
  issueId: number,
  body: {
    kind: UatVerdictKind;
    reason: string;
    requested_by: string;
    channel: string;
    channel_user_id: string;
  },
): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>(`/api/v1/issues/${issueId}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Start a GitHub identity link flow for the given Zoom user. Returns the OAuth
 * redirect URL the user must tap to authorize. The server binds the pending link
 * to the channel_user_id so it resolves back to the right Zoom identity. */
export async function startGithubLink(body: {
  channel: string;
  channel_user_id: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>("/api/v1/identity/link", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Check whether a verified Zoom identity is linked to a GitHub account. The server
 * resolves the caller's OWN forwarded channel_user_id, so it only ever returns that
 * user's mapping. Returns { linked, github_login }. */
export async function getLinkStatus(params: {
  channel: string;
  channel_user_id: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  const qs = new URLSearchParams({
    channel: params.channel,
    channel_user_id: params.channel_user_id,
  }).toString();
  return praxisFetch<Record<string, unknown>>(`/api/v1/identity/status?${qs}`);
}

/** Onboard an EXISTING repo into Praxis: register it and (by default) backfill its open
 * issues through the live intake path. The server does NOT create the GitHub webhook (that
 * needs repo-admin the Praxis token lacks) — the result carries a `webhook` instruction for a
 * repo admin to finish. Returns the raw result + HTTP status so the tool surfaces it verbatim. */
export async function onboardRepo(body: {
  full_name: string;
  maintainers?: string[];
  owns_dispatch?: boolean;
  backfill?: boolean;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>("/api/v1/repos/onboard", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function runSelfHeal(body: {
  repo?: string;
  mode?: string;
  since_minutes?: number;
  min_occurrences?: number;
  notify?: boolean;
  note?: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>("/api/v1/self-heal/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
