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
//   - a body over 64 KB (an operator-layer invoke: 264 KB) is cut and the
//     result is ok: false.
// Requests carry no cookie and no login, so there is no 401 re-login replay
// (INV-16 holds trivially; PK-12 must keep any replay GET/HEAD-only).
//
// Operator layer (M13 slice 1): scopelyOpsInvoke is the ONE extra request
// shape. It is a POST to exactly OPS_INVOKE_PATH whose body the guard builds
// ({capability, args, correlation_id = audit_id}), for a capability on the
// read allow-list OPS_READ_CAPABILITIES only, under authMode "service-token".
// The guard itself adds `Authorization: Bearer <token>` (read per request,
// readOpsToken), X-Ops-Requester-Zoom-Id (the asker's canonical Zoom user id)
// and X-Ops-Bot-Audit-Id; the caller
// header allow-list is NOT widened, so no caller can send any of them, and the
// token goes on no other request.
// scopelyFetch callers cannot reach this branch: a POST from them is still
// refused outside a dev read-write profile, whatever its path.
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
import { auditEvent, auditEventBestEffort, PLUGIN_VERSION, withAuditPolicyScope } from "./audit.js";
import {
  type BackendProfile,
  readBackendProfile,
  readOpsToken,
  resolveWorkspaceDir,
} from "./backend-profile.js";
import {
  nativeWriteScope,
  productionCoreEnabled,
  productionCapabilityAllowed,
} from "./ops-write-policy.js";
import { redactText, redactValue } from "./redaction.js";

export interface ScopelyFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  /** Set when the body was cut at the read cap (then ok is false and data is the cut text). */
  truncated?: true;
}

export type GuardCode =
  | "backend_off"
  | "write_blocked_read_only"
  | "host_blocked"
  | "header_blocked"
  | "auth_unavailable"
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

/** The operator layer's generic invoke edge (SLICE1-CONTRACT section 6). */
export const OPS_INVOKE_PATH = "/api/spine/v1/ops/invoke/";
/**
 * The kernel capabilities the bot may invoke: the slice-1 reads (contract
 * section 7). Any other name is refused before any I/O, so the bot stays
 * read-only even if the kernel registers a write; adding one is a reviewed
 * code change, like ENV_APP_HOSTS.
 */
export const OPS_READ_CAPABILITIES = [
  "system.whoami",
  "system.health",
  "catalog.vendors.list",
  "catalog.vendors.get",
  "catalog.project_types.list",
  "catalog.deployment_types.list",
  "catalog.scoping_cards.list",
  "catalog.scoping_cards.get",
  "pricing.defaults.list",
  "sessions.list",
  "sessions.get",
  "identity.users.list",
  "identity.users.get",
] as const;
export const OPS_LOCAL_READ_CAPABILITIES = ["ops.approvers.check", "ops.approvers.list"] as const;

export const OPS_LOCAL_WRITE_CAPABILITIES = [
  "ops.approvers.grant",
  "ops.approvers.revoke",
  "catalog.scoping_cards.create",
  "catalog.scoping_cards.update",
  "catalog.scoping_cards.delete",
  "pricing.items.create",
  "pricing.items.update",
  "pricing.items.delete",
  "pricing.defaults.update",
  "identity.users.unlock",
  "identity.users.set_active",
  "identity.users.request_reset",
  "identity.invites.create",
  "sessions.archive",
  "catalog.project_types.update",
  "catalog.deployment_types.update",
  "ops.confirm",
  "ops.cancel",
  "ops.pending",
] as const;
export type OpsCapability =
  | (typeof OPS_READ_CAPABILITIES)[number]
  | (typeof OPS_LOCAL_WRITE_CAPABILITIES)[number]
  | (typeof OPS_LOCAL_READ_CAPABILITIES)[number];
export type OpsInvocation = {
  capability: OpsCapability;
  args: Record<string, unknown>;
  /** The asker's canonical Zoom user id (canonicalZoomId); absent = the kernel answers whoami only. */
  requesterZoomId?: string;
};
// zoomwarriors_2 apps/opsplane (301b1c0e): identity.py OpsTokenAuthentication
// reads only `Authorization: Bearer zwops_...`; edge_rest.py stores
// X-Ops-Bot-Audit-Id as bot_audit_id (service tokens) for the cross-system join.
// Requester by Zoom user id (IDENTITY-B contract): the old email header
// x-ops-requester no longer identifies anyone and is never sent.
const OPS_REQUESTER_HEADER = "x-ops-requester-zoom-id";
const OPS_BOT_AUDIT_HEADER = "x-ops-bot-audit-id";
// edge_rest.py _ID_RE: the kernel's charset for correlation and bot audit ids.
const OPS_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// Slice-1 args are a few short keys; anything bigger is not a read argument.
const MAX_OPS_ARGS_BYTES = 4096;
// Backend pending envelopes are capped at16KiB including args, preview and
// identity. Let it validate that combined budget; never preclude valid writes
// with the smaller read budget. Its exact preview limit also remains in force.
const MAX_OPS_WRITE_ARGS_BYTES = 16 * 1024;
// The canonical Zoom user id, the same rule as the kernel's normaliser
// (journey_models.normalize_zoom_user_id; shared vectors, zoom_id_vectors.json).
const ZOOM_ID_RE = /^[a-z0-9_-]{6,64}$/;
// Before lower-casing: ASCII only, so no Unicode case mapping (KELVIN SIGN ->
// "k") can turn a lookalike into an id.
const ZOOM_ID_SHAPE_RE = /^[A-Za-z0-9_-]{6,64}$/;
// ASCII whitespace only: a NO-BREAK SPACE or BOM is not trimmed (and then fails the shape).
const ASCII_EDGE_SPACE_RE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
// Without the u flag, /i folds no non-ASCII character into ASCII.
const ZOOM_JID_SUFFIX_RE = /@xmpp\.zoom\.us$/i;

/**
 * The canonical form of a Zoom user id (IDENTITY-B contract): trim ASCII
 * whitespace; drop one trailing `@xmpp.zoom.us` (ASCII case ignored); the
 * rest must be ASCII `[A-Za-z0-9_-]{6,64}`, lower-cased; else undefined. Team
 * chat carries the case-preserved operator id, the chatbot path a lowercase
 * JID; Zoom treats them case-insensitively.
 */
export function canonicalZoomId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.replace(ASCII_EDGE_SPACE_RE, "").replace(ZOOM_JID_SUFFIX_RE, "");
  return ZOOM_ID_SHAPE_RE.test(id) ? id.toLowerCase() : undefined;
}

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
// An operator-layer answer may legally carry up to the kernel's
// MAX_RESULT_BYTES of data (kernel.py, 256 KB) plus its envelope (ids,
// capability, flags: well under 8 KB), so the invoke reads that much; the
// model still sees at most 16,000 characters (ops-client.ts boundData).
const MAX_OPS_BODY_BYTES = 256 * 1024 + 8 * 1024;
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

type HttpFields = {
  method: string;
  host?: string;
  path_template?: string;
  query_keys?: string[];
  /** Operator-layer invokes only: the capability, and whether a requester id was sent. */
  capability?: string;
  requester_header?: boolean;
};

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
// The rate slot is committed only after the intent row is durable. An
// operator-layer invoke is a POST but a read (its capability passed
// checkOpsInvocation), so it is exempt from the read-only and write-latch rules
// and from nothing else: the kill switch and the rate cap still apply.
function admit(
  profile: BackendProfile,
  method: string,
  http: HttpFields,
  isOps: boolean,
  nativeInvoke = false,
): void {
  if (profile.env === "prod" && !SAFE_METHODS.has(method) && !nativeInvoke) {
    refuse(
      "write_blocked_read_only",
      "Production permits only admitted native capabilities.",
      http,
    );
  }
  if (profile.mode === "off") {
    refuse("backend_off", "The bot's connection to the app is switched off by the operator.", http);
  }
  const mutating = !SAFE_METHODS.has(method) && !isOps;
  if (mutating && profile.mode !== "read-write") {
    refuse(
      "write_blocked_read_only",
      `Blocked: the bot is read-only on the new app, so ${method} requests are refused.`,
      http,
    );
  }
  if (mutating && writesLatched) {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The invoke's own checks, before the mode/rate gate: a read capability, a
// well-formed requester, small JSON-object args. Returns the serialized args.
function checkOpsInvocation(op: OpsInvocation, http: HttpFields, profile: BackendProfile): string {
  const read = (OPS_READ_CAPABILITIES as readonly string[]).includes(op.capability);
  const localWrite = (OPS_LOCAL_WRITE_CAPABILITIES as readonly string[]).includes(op.capability);
  const localRead = (OPS_LOCAL_READ_CAPABILITIES as readonly string[]).includes(op.capability);
  const local =
    (localWrite || localRead) &&
    profile.env === "local" &&
    profile.mode === "read-write" &&
    profile.baseUrl === "http://127.0.0.1:8100";
  const production =
    productionCoreEnabled(profile) &&
    productionCapabilityAllowed(op.capability) &&
    nativeWriteScope(profile, process.env.SCOPELYBOT_ZOOM_CHANNEL);
  if (!read && !local && !production) {
    refuse("write_blocked_read_only", "Blocked: this native capability is not admitted.", http, {
      // Runtime callers can violate TypeScript; keep refusal formatting safe.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
      capability: boundedText(String(op.capability)),
    });
  }
  // Header absence must not let a misconfigured personal token act as its
  // owner. Whoami alone may diagnose the credential without business reads.
  if (op.requesterZoomId === undefined && op.capability !== "system.whoami") {
    refuse(
      "header_blocked",
      "Blocked: this app read requires the current sender's Zoom identity.",
      http,
    );
  }
  if (op.requesterZoomId !== undefined && !ZOOM_ID_RE.test(op.requesterZoomId)) {
    refuse("header_blocked", "Blocked: the requester is not a canonical Zoom user id.", http, {
      header: OPS_REQUESTER_HEADER,
    });
  }
  let args: string | undefined;
  try {
    args = isPlainObject(op.args) ? JSON.stringify(op.args) : undefined;
  } catch {
    // a cycle or a BigInt: not a JSON argument object
  }
  if (
    args === undefined ||
    Buffer.byteLength(args) > (localWrite ? MAX_OPS_WRITE_ARGS_BYTES : MAX_OPS_ARGS_BYTES)
  ) {
    refuse("body_blocked", "Blocked: the capability arguments are not a small JSON object.", http);
  }
  return args;
}

// After the kill switch: the invoke needs authMode "service-token" and a usable
// token file. Problems are refused by code; the token is never in a message or row.
function opsToken(profile: BackendProfile, http: HttpFields): string {
  if (profile.authMode !== "service-token") {
    refuse(
      "auth_unavailable",
      "Request not sent: the bot has no service token for the app (authMode is anonymous).",
      http,
      { reason: "anonymous" },
    );
  }
  const read = readOpsToken();
  if ("problem" in read) {
    refuse(
      "auth_unavailable",
      `Request not sent: the bot's service token is unavailable (${read.problem}).`,
      http,
      { reason: read.problem },
    );
  }
  return read.token;
}

// What the outcome row keeps of a kernel envelope: its ok flag, request_id and
// error code (charset checked and bounded), for the join with the app's audit,
// and the refusal detail (redacted, at most 200 characters): operator wording
// the person in chat never sees (ops-client.ts), kept here for the operator.
// Edge refusals (401, the emergency 503, a 400 on ids) use the bare spine
// envelope {detail, code, request_id}: no ok, the code at the top level.
function kernelSummary(data: unknown) {
  const envelope = isPlainObject(data) ? data : {};
  const error = isPlainObject(envelope.error) ? envelope.error : envelope;
  const id = (value: unknown) =>
    typeof value === "string" && X_REQUEST_ID_RE.test(value) ? value : null;
  return {
    ok: typeof envelope.ok === "boolean" ? envelope.ok : null,
    request_id: id(envelope.request_id),
    error_code: id(error.code),
    detail: typeof error.detail === "string" ? redactText(error.detail, 200) : null,
  };
}

export function scopelyFetch(path: string, opts: ScopelyRequest = {}): Promise<ScopelyFetchResult> {
  return guardedRequest(path, opts);
}

/**
 * The operator-layer invoke: POST OPS_INVOKE_PATH with a guard-built body and
 * the guard's own token and requester headers. Sent once, never retried.
 */
export function scopelyOpsInvoke(op: OpsInvocation): Promise<ScopelyFetchResult> {
  return guardedRequest(OPS_INVOKE_PATH, {}, op);
}

function guardedRequest(
  path: string,
  opts: ScopelyRequest,
  op?: OpsInvocation,
): Promise<ScopelyFetchResult> {
  return withAuditPolicyScope("request", () => executeGuardedRequest(path, opts, op));
}

async function executeGuardedRequest(
  path: string,
  opts: ScopelyRequest,
  op?: OpsInvocation,
): Promise<ScopelyFetchResult> {
  const profile = readBackendProfile();
  const method = op ? "POST" : (opts.method ?? "GET").toUpperCase();
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
  const opsArgs = op ? checkOpsInvocation(op, http, profile) : undefined;
  if (op) {
    // Recorded only once checked: the name is then one of the allow-list's.
    http.capability = op.capability;
    http.requester_header = op.requesterZoomId !== undefined;
  }
  admit(
    profile,
    method,
    http,
    op !== undefined &&
      ([...OPS_READ_CAPABILITIES, ...OPS_LOCAL_READ_CAPABILITIES] as readonly string[]).includes(
        op.capability,
      ),
    op !== undefined,
  );
  const token = op ? opsToken(profile, http) : undefined;

  // Correlation (INV-5): set by the guard only, after every caller input; the
  // param is set (never appended), so it appears exactly once.
  const auditId = newAuditId();
  if (op && !OPS_ID_RE.test(auditId)) {
    // The kernel would answer 400 to an id outside its charset: refuse first.
    refuse("header_blocked", "Blocked: the audit id is not a valid operator-layer id.", http, {
      header: OPS_BOT_AUDIT_HEADER,
    });
  }
  url.searchParams.set("bot_audit_id", auditId);
  headers["x-correlation-id"] = auditId;
  headers["x-vipbot-client"] = `scopelybot/${PLUGIN_VERSION} (${profile.env})`;
  let body = opts.body;
  if (op && token !== undefined) {
    // The correlation id in the body is the audit_id: the kernel's audit row
    // and this chain join on it (with bot_audit_id and x-correlation-id).
    body = `{"capability":${JSON.stringify(op.capability)},"args":${opsArgs},"correlation_id":"${auditId}"}`;
    headers["content-type"] = "application/json";
    headers.authorization = `Bearer ${token}`;
    headers[OPS_BOT_AUDIT_HEADER] = auditId;
    if (
      (OPS_LOCAL_WRITE_CAPABILITIES as readonly string[]).includes(op.capability) ||
      (profile.env === "prod" && productionCapabilityAllowed(op.capability))
    ) {
      const channel = process.env.SCOPELYBOT_ZOOM_CHANNEL;
      if (!channel || channel.length > 200 || /[\r\n]/.test(channel)) {
        refuse("header_blocked", "The local Zoom channel is not configured.", http);
      }
      headers["x-ops-surface"] = channel;
    }
    if (op.requesterZoomId !== undefined) {
      headers[OPS_REQUESTER_HEADER] = op.requesterZoomId;
    }
  }

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
      if (
        !SAFE_METHODS.has(method) &&
        (!op ||
          !(
            [...OPS_READ_CAPABILITIES, ...OPS_LOCAL_READ_CAPABILITIES] as readonly string[]
          ).includes(op.capability))
      ) {
        writesLatched = true;
      }
    }
  };

  let resp: Response;
  try {
    resp = await fetch(url.href, {
      method,
      headers,
      body,
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
    result = await readResult(resp, op ? MAX_OPS_BODY_BYTES : MAX_BODY_BYTES);
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
    {
      // A cut body is not an answer anyone can use: never recorded as "ok".
      status: result.truncated ? "truncated" : resp.ok ? "ok" : "http_error",
      ...(op ? { kernel: kernelSummary(result.data) } : {}),
    },
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
async function readResult(resp: Response, maxBytes: number): Promise<ScopelyFetchResult> {
  const { text, truncated } = await readCappedText(resp, maxBytes);
  let data: unknown = text;
  if (resp.headers.get("content-type")?.includes("application/json") && text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      // Content-Type lied — keep the raw text.
    }
  }
  return {
    ok: resp.ok && !truncated,
    status: resp.status,
    data,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

// UTF-8 text of the body, capped at maxBytes: past the cap the stream is
// cancelled and the text marked "...[truncated]" (a cut JSON body then stays
// raw text), so a partial body is never passed off as a complete one.
async function readCappedText(
  resp: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
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
    if (size > maxBytes) {
      await reader.cancel();
      const text = `${Buffer.concat(chunks).toString("utf8", 0, maxBytes)}...[truncated]`;
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
