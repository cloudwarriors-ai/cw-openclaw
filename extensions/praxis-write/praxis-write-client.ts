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
  contracts?: string[];
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

/** Non-throwing issue lookup for user-facing flows that must preserve structured 4xx bodies. */
export async function getIssueResponse(
  issueId: number,
): Promise<PraxisResponse<PraxisIssueState & Record<string, unknown>>> {
  return praxisFetch<PraxisIssueState & Record<string, unknown>>(`/api/v1/issues/${issueId}`);
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

/** Stage-neutral verdict kinds accepted by the conversation-aware events endpoint.
 * Praxis resolves the persisted uat1/uat2 event server-side after first checking the
 * inbound-message idempotency key, so a retry cannot change stages. */
export type UatVerdictKind = "uat_pass" | "uat_fail";

/** Map a Praxis issue state to its UAT kind prefix, or undefined when the issue
 * is not currently awaiting a UAT verdict. Exported for testing. */
export function mapStateToUatKindPrefix(state: string): "uat1" | "uat2" | "uat3" | undefined {
  if (state === "dev_uat") {
    return "uat1";
  }
  if (state === "user_uat") {
    return "uat2";
  }
  if (state === "prod_uat") {
    // Prod round (repo opt-in): the reporter's prod confirmation. Server maps uat_pass -> uat3.
    return "uat3";
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
    message_id: string;
    idempotency_key: string;
    expected_state: "dev_uat" | "user_uat";
    expected_version: number;
  },
): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>(`/api/v1/issues/${issueId}/events`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Resolve an "owner/repo#N" GitHub ref to the praxis issue id via the issues list
 * (issue_dict exposes id + repo + source_issue). Returns undefined when not tracked. */
export async function resolveIssueRef(ref: string): Promise<number | undefined> {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim());
  if (!m) {
    return undefined;
  }
  const repo = m[1];
  const number = Number(m[2]);
  const res = await praxisGet<{ issues: Array<{ id: number; source_issue: number }> }>(
    `/api/v1/issues?repo=${encodeURIComponent(repo)}`,
  );
  const hit = (res.issues ?? []).find((i) => i.source_issue === number);
  return hit?.id;
}

/** Submit a needs-info answer on behalf of a verified Zoom user. The server resolves
 * the identity, verifies reporter/maintainer authz, consumes the OPEN question, and applies
 * info_provided with the question's stored field — the caller supplies only the answer text
 * (kind/reason contract of POST /issues/{id}/events). */
export async function submitNeedsInfoAnswer(
  issueId: number,
  body: {
    reason: string;
    requested_by: string;
    channel: string;
    channel_user_id: string;
    message_id: string;
    idempotency_key: string;
  },
): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>(`/api/v1/issues/${issueId}/events`, {
    method: "POST",
    body: JSON.stringify({ kind: "info_provided", ...body }),
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

/** Force-ingest a single GitHub issue into an already-onboarded repo through Praxis's live intake
 * path — the per-issue complement to onboardRepo's bulk backfill. The server resolves the repo,
 * fetches the one open issue, and runs the same intake bridge (idempotent). Returns the raw result
 * + HTTP status so the tool surfaces Praxis's outcome (ingested / repo_not_onboarded /
 * issue_not_open) verbatim. The requester + channel travel as audit context the server records. */
export async function ingestIssue(body: {
  full_name: string;
  number: number;
  requested_by: string;
  channel: string;
  message_id: string;
  idempotency_key: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>("/api/v1/issues/ingest", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Author and file a single GitHub issue into a repo (default: the Praxis self-heal repo) — the
 * direct, agent-authored complement to runSelfHeal's scan-detected issues. Lets the agent seed a
 * self-healing / self-improvement issue Praxis can then work. `labels` is omitted from the body
 * when undefined so the server applies its default self-improvement marker. Returns the raw result
 * + HTTP status ({filed, full_name, number, url, labels}) verbatim. */
export async function fileIssue(body: {
  full_name: string;
  title: string;
  body: string;
  labels?: string[];
  requested_by: string;
  channel: string;
  message_id: string;
  idempotency_key: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>("/api/v1/issues/file", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Identity-scoped "my issues" list (Praxis /api/v1/my/issues). The caller forwards only the
 * verified runtime channel identity; Praxis resolves the GitHub login server-side, so a user can
 * only ever read their own reported issues. Returns raw result + status for the tool to surface. */
export async function getMyIssues(params: {
  channel: string;
  channel_user_id: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  const qs = new URLSearchParams({
    channel: params.channel,
    channel_user_id: params.channel_user_id,
  }).toString();
  return praxisFetch<Record<string, unknown>>(`/api/v1/my/issues?${qs}`);
}

/** Thread-correlated resolution (Praxis /api/v1/my/thread-issue): map the TRUSTED reply thread
 * root id to the one issue whose comms live in that thread, identity-scoped and role-gated.
 * Unknown/foreign threads are undisclosed 404s. The caller forwards only the runtime-provided
 * thread id — never a model-chosen value. */
export async function resolveThreadIssue(params: {
  channel: string;
  channel_user_id: string;
  thread_ref: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  const qs = new URLSearchParams({
    channel: params.channel,
    channel_user_id: params.channel_user_id,
    thread_ref: params.thread_ref,
  }).toString();
  return praxisFetch<Record<string, unknown>>(`/api/v1/my/thread-issue?${qs}`);
}

/** Open-ask resolution (Praxis /api/v1/my/open-ask): the ONE issue with a question addressed to
 * this identity, resolved server-side. 404 = nothing waiting; 409 = several (body carries the
 * candidate list). Removes the model's need to guess which issue a bare reply answers. */
export async function resolveOpenAsk(params: {
  channel: string;
  channel_user_id: string;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  const qs = new URLSearchParams({
    channel: params.channel,
    channel_user_id: params.channel_user_id,
  }).toString();
  return praxisFetch<Record<string, unknown>>(`/api/v1/my/open-ask?${qs}`);
}

/** Identity-scoped drill-down (Praxis /api/v1/my/issues/{id}): 404 unless the resolved user is
 * that issue's reporter — the end-user detail path; org-wide /issues/{id} stays operator-only. */
export async function getMyIssue(
  issueId: number,
  params: { channel: string; channel_user_id: string },
): Promise<PraxisResponse<Record<string, unknown>>> {
  const qs = new URLSearchParams({
    channel: params.channel,
    channel_user_id: params.channel_user_id,
  }).toString();
  return praxisFetch<Record<string, unknown>>(`/api/v1/my/issues/${issueId}?${qs}`);
}

/** Self-serve proactive-outreach consent for the caller (Praxis /api/v1/my/consent). `opt_in`
 * true = POST (opt in), false = DELETE (opt out). Only the verified runtime identity is forwarded;
 * Praxis resolves the login and records the caller's OWN consent as a user opt-in. */
export async function setMyConsent(params: {
  channel: string;
  channel_user_id: string;
  opt_in: boolean;
}): Promise<PraxisResponse<Record<string, unknown>>> {
  return praxisFetch<Record<string, unknown>>("/api/v1/my/consent", {
    method: params.opt_in ? "POST" : "DELETE",
    body: JSON.stringify({
      channel: params.channel,
      channel_user_id: params.channel_user_id,
    }),
  });
}
