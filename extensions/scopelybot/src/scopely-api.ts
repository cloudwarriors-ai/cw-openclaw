// The single HTTP choke point to the ZW app (INV-2, INV-5). Every bot request to
// the app host goes through scopelyFetch, which enforces the live backend
// profile (backend-profile.ts) BEFORE any network I/O and denies by default:
//   - mode "off" refuses everything (the operator kill switch);
//   - only GET/HEAD pass unless the profile says read-write (read-only is the
//     default and the M1 setting);
//   - the target is the profile's baseUrl (its host pinned to allowedHosts and
//     the env host table; the default profile has none) plus a single-slash
//     absolute path, so no path can change the origin, and the built URL's
//     host is re-checked against allowedHosts (no userinfo) before the request;
//   - a GET/HEAD with a body is refused (body_blocked);
//   - caller headers are an allow-list (accept, content-type) and no other
//     RequestInit option is forwarded; the only Host override is the profile's
//     own (dev-only) hostHeader;
//   - a per-minute cap protects the app's shared anonymous throttle bucket, and
//     an HTTP 429 maps to the same clear "busy" error, never a partial answer;
//   - redirects are never followed: fetch runs with redirect: "manual" and any
//     3xx answer is refused (redirect_blocked);
//   - a body over 64 KB is cut and the result is ok: false.
// Requests are anonymous: no cookie, no login, so no 401 re-login replay
// (INV-16 holds trivially; PK-12 must keep any replay GET/HEAD-only).
// An AST scan of index.ts's import closure (single-choke-point.test.ts) fails
// if any other module reaches the network. Refusals throw ScopelyGuardError
// and are audited.
//
// Audit before action (INV-15, PK-7b): a validated request first gets an
// audit_id and an http_intent row, appended and fsynced; if that append fails
// the request is NOT sent (audit_unavailable). The request carries the id as
// ?bot_audit_id= and x-correlation-id (INV-5), and exactly one terminal row
// with the same audit_id follows (http_outcome, redirect_blocked or
// rate_limited). A failed outcome append is reported (audit_degraded) and the
// writer's recovery sweep later records the intent as indeterminate. Nothing
// here retries a request.

import { boundedText, newAuditId } from "./audit-chain.js";
import { auditEvent, auditEventBestEffort, PLUGIN_VERSION } from "./audit.js";
import { type BackendProfile, readBackendProfile, resolveWorkspaceDir } from "./backend-profile.js";
import { redactText, redactValue } from "./redaction.js";

export interface ScopelyFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
}

export type GuardCode =
  | "backend_off"
  | "write_blocked_read_only"
  | "host_blocked"
  | "header_blocked"
  | "body_blocked"
  | "redirect_blocked"
  | "rate_limited"
  | "audit_unavailable";

export class ScopelyGuardError extends Error {
  constructor(
    readonly code: GuardCode,
    message: string,
  ) {
    super(message);
    this.name = "ScopelyGuardError";
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);
// Caller headers are an allow-list. Anything else could tunnel a mutating verb
// through a GET (X-HTTP-Method-Override), re-route the connection to another
// virtual host behind the shared proxy (Host, X-Forwarded-*, X-Original-URL)
// or smuggle identity (Authorization, Cookie); identity and the dev Host
// override only ever come from the profile.
const ALLOWED_HEADERS = new Set(["accept", "content-type"]);
const BUSY_MESSAGE = "The new app is busy, try again shortly.";
// A hung upstream must not hang the tool (the signal also bounds the body read).
const REQUEST_TIMEOUT_MS = 10_000;
// Bodies are read up to this size and the rest cancelled, so a huge or endless
// answer (the sprint serves an 80 KB Django debug page) cannot pin memory.
const MAX_BODY_BYTES = 64 * 1024;
// An intent without a terminal row is orphaned only after this deadline, which
// is past the 10 s bound on fetch plus body read.
const INTENT_DEADLINE_MS = 15_000;
const AUDIT_UNAVAILABLE = "Request not sent: the audit log is unavailable.";
const X_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const NOT_SENT_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"]);

// performance.now() stamps of admitted requests in the last minute (one process
// owns this). Monotonic: a wall clock stepped back must not pin the bot busy.
let recentRequests: number[] = [];
// Set when an outcome row of a mutating request could not be written: further
// non-GET/HEAD requests are refused until restart (reads recover by themselves).
let writesLatched = false;

type HttpFields = { method: string; host?: string; path_template?: string; query_keys?: string[] };

// The pathname with id-like segments (digits, UUID, ULID) as ":id", charset
// checked and bounded: rows never carry raw ids or query values.
function pathTemplate(pathname: string): string {
  const template = pathname
    .split("/")
    .map((seg) =>
      /^\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9A-HJKMNP-TV-Z]{26}$/i.test(
        seg,
      )
        ? ":id"
        : seg,
    )
    .join("/");
  return /^[A-Za-z0-9._~:/-]{0,200}$/.test(template) ? template : "/:unsafe";
}

function refuse(
  code: GuardCode,
  message: string,
  http: HttpFields,
  detail?: Record<string, unknown>,
): never {
  auditEventBestEffort(
    resolveWorkspaceDir(),
    code === "audit_unavailable" ? "write_blocked_read_only" : code,
    {
      http: { ...http, status: null },
      detail: { ...detail, ...(code === "audit_unavailable" ? { reason: code } : {}) },
    },
  );
  throw new ScopelyGuardError(code, message);
}

// The mode and rate checks: the last gate before the request hits the network.
// The rate slot is committed only after the intent row is durable.
function admit(profile: BackendProfile, method: string, http: HttpFields): void {
  if (profile.mode === "off") {
    refuse("backend_off", "The bot's connection to the app is switched off by the operator.", http);
  }
  if (!SAFE_METHODS.has(method) && profile.mode !== "read-write") {
    refuse(
      "write_blocked_read_only",
      `Blocked: the bot is read-only on the new app, so ${method} requests are refused.`,
      http,
    );
  }
  if (!SAFE_METHODS.has(method) && writesLatched) {
    refuse("audit_unavailable", AUDIT_UNAVAILABLE, http);
  }
  const now = performance.now();
  recentRequests = recentRequests.filter((t) => now - t < 60_000);
  if (recentRequests.length >= profile.maxRequestsPerMinute) {
    refuse("rate_limited", BUSY_MESSAGE, http);
  }
}

/** What a caller may ask for; any other RequestInit option is never forwarded. */
export type ScopelyRequest = { method?: string; body?: string; headers?: HeadersInit };

// The headers actually sent: the caller's allow-listed ones (any other name, or
// a malformed one, refuses the request), then the guard's own.
function guardHeaders(
  profile: BackendProfile,
  method: string,
  opts: ScopelyRequest,
): Record<string, string> {
  let caller: Headers;
  try {
    caller = new Headers(opts.headers);
  } catch {
    refuse("header_blocked", "Blocked: a request header is malformed.", { method });
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of caller) {
    if (!ALLOWED_HEADERS.has(name)) {
      refuse(
        "header_blocked",
        `Blocked: the ${name} request header is refused.`,
        { method },
        { header: name },
      );
    }
    headers[name] = value;
  }
  if (opts.body) {
    headers["content-type"] = "application/json";
  }
  if (profile.hostHeader) {
    headers.host = profile.hostHeader;
  }
  return headers;
}

export async function scopelyFetch(
  path: string,
  opts: ScopelyRequest = {},
): Promise<ScopelyFetchResult> {
  const profile = readBackendProfile();
  const method = (opts.method ?? "GET").toUpperCase();
  if (!profile.baseUrl) {
    refuse(
      "host_blocked",
      "Blocked: no valid backend profile (scopelybot-backend.json), so the bot is not connected to the app.",
      { method },
    );
  }
  // The ONE host rule: the URL is the profile's baseUrl (a bare origin whose host
  // parseBackendProfile pins to allowedHosts and the env table) plus a string
  // path starting with exactly one slash, so its origin is always baseUrl.
  // "@host", ".host", "//host" or a full URL could otherwise move it off-host;
  // a non-string could change its text between this check and the URL build.
  if (typeof path !== "string" || !/^\/(?![/\\])/.test(path)) {
    refuse("host_blocked", "Blocked: the request path must be an absolute path on the app host.", {
      method,
    });
  }
  // fetch would throw a bare TypeError for a GET/HEAD body: refuse it here,
  // audited, before a rate token is spent.
  if (SAFE_METHODS.has(method) && opts.body !== undefined) {
    refuse("body_blocked", `Blocked: a ${method} request cannot carry a body.`, { method });
  }
  const headers = guardHeaders(profile, method, opts);

  const url = new URL(`${profile.baseUrl}${path}`);
  const http: HttpFields = {
    method,
    host: url.host,
    path_template: pathTemplate(url.pathname),
    query_keys: [...new Set(url.searchParams.keys())]
      .filter((k) => k !== "bot_audit_id")
      .map(boundedText)
      .toSorted(),
  };
  // Last gate, independent of how the URL was assembled: the target host must be
  // one the validated profile names, with no userinfo. Redundant today (the URL is
  // baseUrl plus a single-slash path); it fails closed if URL assembly, baseUrl
  // handling or profile validation ever drift apart.
  if (!profile.allowedHosts.includes(url.host) || url.username || url.password) {
    refuse("host_blocked", "Blocked: the request target is not an allowed app host.", http);
  }
  admit(profile, method, http);

  // Correlation (INV-5): set by the guard only, after every caller input; the
  // param is set (never appended), so it appears exactly once.
  const auditId = newAuditId();
  url.searchParams.set("bot_audit_id", auditId);
  headers["x-correlation-id"] = auditId;
  headers["x-vipbot-client"] = `scopelybot/${PLUGIN_VERSION} (${profile.env})`;

  const workspace = resolveWorkspaceDir();
  const started = Date.now();
  try {
    auditEvent(workspace, "http_intent", {
      audit_id: auditId,
      phase: "intent",
      http: {
        ...http,
        status: null,
        x_request_id: null,
        duration_ms: null,
        deadline_ts: new Date(started + INTENT_DEADLINE_MS).toISOString(),
      },
    });
  } catch {
    throw new ScopelyGuardError("audit_unavailable", AUDIT_UNAVAILABLE);
  }
  recentRequests.push(performance.now());

  // Exactly one terminal row per intent, written even when the request fails.
  const outcome = (
    event: "http_outcome" | "redirect_blocked" | "rate_limited",
    status: number | null,
    result: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    try {
      auditEvent(workspace, event, {
        audit_id: auditId,
        phase: "outcome",
        http: { ...http, status, duration_ms: Date.now() - started, ...extra },
        result,
      });
    } catch {
      // The request already happened: return its result; the intent stays open
      // until the writer's recovery sweep records it as indeterminate.
      if (!SAFE_METHODS.has(method)) {
        writesLatched = true;
      }
    }
  };

  let resp: Response;
  try {
    resp = await fetch(url.href, {
      method,
      headers,
      body: opts.body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    const notSent = typeof code === "string" && NOT_SENT_CODES.has(code);
    outcome("http_outcome", null, {
      status: notSent ? "not_sent" : "indeterminate",
      error_class: notSent ? code : ((err as Error)?.name ?? "error").slice(0, 64),
    });
    throw err;
  }
  const requestId = resp.headers.get("x-request-id");
  const xRequestId = requestId && X_REQUEST_ID_RE.test(requestId) ? requestId : null;
  if (resp.status === 429 || (resp.status >= 300 && resp.status < 400)) {
    // Neither answer is read: release its connection, then refuse. A 429 is the
    // busy reply; a 3xx is never followed, because M1 calls one fixed URL and a
    // hop would be a second request the guard (and the kill switch) never saw.
    // Only the redirect's host is recorded, never the Location value.
    await resp.body?.cancel().catch(() => undefined);
    if (resp.status === 429) {
      outcome("rate_limited", 429, { status: "http_error" }, { x_request_id: xRequestId });
      throw new ScopelyGuardError("rate_limited", BUSY_MESSAGE);
    }
    let redirectHost: string | null = null;
    try {
      redirectHost = boundedText(new URL(resp.headers.get("location") ?? "", url).host);
    } catch {
      // unparseable Location: no host to record
    }
    outcome(
      "redirect_blocked",
      resp.status,
      { status: "blocked" },
      { x_request_id: xRequestId, redirect_to_host: redirectHost },
    );
    throw new ScopelyGuardError(
      "redirect_blocked",
      `Blocked: the app answered with a redirect (HTTP ${resp.status}) and the bot does not follow redirects.`,
    );
  }
  let result: ScopelyFetchResult;
  try {
    result = await readResult(resp);
  } catch (err) {
    outcome(
      "http_outcome",
      resp.status,
      { status: "error", error_class: "body_read" },
      { x_request_id: xRequestId },
    );
    throw err;
  }
  outcome(
    "http_outcome",
    resp.status,
    { status: resp.ok ? "ok" : "http_error" },
    { x_request_id: xRequestId },
  );
  return result;
}

// Read as text first, then parse. DRF answers DELETE with 204 No Content but
// STILL sets Content-Type: application/json on the empty body — resp.json()
// throws "Unexpected end of JSON input", which surfaced live (2026-07-21) as
// a false "❌ Error executing DELETE …" on a delete that had SUCCEEDED.
// Empty or malformed bodies fall back to the raw text: an honest payload
// beats an exception that misreports a completed mutation as a failure.
// A truncated body is ok: false whatever the status: callers (the health
// check, JSON consumers) must not read a cut 200 answer as a success.
async function readResult(resp: Response): Promise<ScopelyFetchResult> {
  const { text, truncated } = await readCappedText(resp);
  let data: unknown = text;
  if (resp.headers.get("content-type")?.includes("application/json") && text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      // Content-Type lied — keep the raw text.
    }
  }
  return { ok: resp.ok && !truncated, status: resp.status, data };
}

// UTF-8 text of the body, capped at MAX_BODY_BYTES: past the cap the stream is
// cancelled and the text marked "...[truncated]" (a cut JSON body then stays
// raw text), so a partial body is never passed off as a complete one.
async function readCappedText(resp: Response): Promise<{ text: string; truncated: boolean }> {
  if (!resp.body) {
    return { text: "", truncated: false };
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
    }
    chunks.push(value);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      const text = `${Buffer.concat(chunks).toString("utf8", 0, MAX_BODY_BYTES)}...[truncated]`;
      return { text, truncated: true };
    }
  }
}

/**
 * Test-only: forget admitted requests so the per-minute cap starts fresh.
 * Throws outside a Vitest worker; the AST closure scan forbids production calls.
 */
export function resetScopelyGuardForTest(): void {
  if (!process.env.VITEST) {
    throw new Error("resetScopelyGuardForTest is test-only");
  }
  recentRequests = [];
  writesLatched = false;
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
