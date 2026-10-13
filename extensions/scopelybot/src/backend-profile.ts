// Live-read backend profile: which ZW app host scopelybot may reach, how, and
// whether it may change anything. Read from <workspace>/scopelybot-backend.json
// (sibling of scopelybot-approvers.json) on EVERY call, so an owner edit — e.g.
// mode "off" as the kill switch — takes effect on the next request with no
// restart.
//
// FAIL CLOSED (INV-2): a missing, unreadable or invalid file yields the default
// profile — zw2 / anonymous / read-only / digest off with NO allowed host, so no
// request reaches any app host. There is deliberately no fallback to the legacy
// env (SCOPELY_BASE_URL, SCOPELY_EMAIL, SCOPELY_PASSWORD) or GH_TOKEN.
//
// Boundaries: this module only reads/validates policy and records audit rows.
// Enforcement lives in scopely-api.ts (method/host guard), gated.ts (staging
// refusal), confirm.ts (CONFIRM refusal) and capability-registry.ts (per-tool
// gating).

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { auditEventBestEffort, noteAuditPolicy } from "./audit.js";

export type BackendMode = "off" | "read-only" | "read-write";

export type BackendProfile = {
  profile: "zw2";
  env: "prod" | "dev";
  /** Origin of the app (prod: https://api.vip.pscx.ai); "" when nothing is reachable. */
  baseUrl: string;
  /** URL.host values (host[:port], lowercase) the guard may contact. */
  allowedHosts: string[];
  /** Host header the guard sends (dev only: the sprint accepts vip.localhost / noob-root). */
  hostHeader?: string;
  /** Only anonymous GETs exist in M1; login modes (jwt) arrive with PK-12. */
  authMode: "anonymous";
  mode: BackendMode;
  digestEnabled: boolean;
  maxRequestsPerMinute: number;
  /** Family id -> tracking issue URL (the only source of "Tracked in" links). */
  issueLinks: Record<string, string>;
};

const PROFILE_FILE = "scopelybot-backend.json";
// The file is re-read on every request: a size cap keeps a huge file from
// stalling the event loop (a real profile is well under 1 KB).
const MAX_PROFILE_BYTES = 64 * 1024;
// Issue links reach users in refusal text: only the org's GitHub, canonical form.
const ISSUE_LINK_PREFIX = "https://github.com/cloudwarriors-ai/";

// The ONLY app hosts each environment may reach (INV-11): a profile's
// allowedHosts must be a subset of its env's list, so a copied or mistyped file
// cannot point dev traffic at prod or prod traffic at the dev box. Prod is the
// API host (the frontend host vip.pscx.ai serves no API paths); dev is the
// zw2-sprint backend on noob-root. Changing a list is an owner-reviewed code
// change, not a file edit.
const ENV_APP_HOSTS: Record<BackendProfile["env"], readonly string[]> = {
  prod: ["api.vip.pscx.ai"],
  dev: ["100.114.142.100:8022"],
};
// The ONLY Host overrides (dev only): the virtual hosts the zw2-sprint stack
// routes to the app. Any other value could reach another service behind the
// same proxy, so this is a code-reviewed table like ENV_APP_HOSTS.
const DEV_HOST_HEADERS: readonly string[] = ["vip.localhost", "noob-root"];

// Default per-process cap protecting the app's shared anonymous throttle
// bucket (AC-7.14); the real green throttle rate is a PK-4 finding.
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 20;

const MODES: ReadonlySet<BackendMode> = new Set(["off", "read-only", "read-write"]);

export function defaultBackendProfile(): BackendProfile {
  return {
    profile: "zw2",
    env: "prod",
    baseUrl: "",
    allowedHosts: [],
    authMode: "anonymous",
    mode: "read-only",
    digestEnabled: false,
    maxRequestsPerMinute: DEFAULT_MAX_REQUESTS_PER_MINUTE,
    issueLinks: {},
  };
}

/** The plugin's workspace dir; an empty OPENCLAW_WORKSPACE falls back too (never the cwd). */
export function resolveWorkspaceDir(): string {
  return process.env.OPENCLAW_WORKSPACE || "/root/.openclaw/workspace";
}

type ParseResult = { profile: BackendProfile } | { error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Canonical form only: "..", backslashes, whitespace and control characters all
// change the parsed href, so a link cannot say one thing and open another.
function isIssueLink(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.href === value && value.startsWith(ISSUE_LINK_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Strictly validate the profile file. Any unsupported or unsafe value makes
 * the whole file invalid (the caller then applies the default); unknown keys
 * are ignored because nothing here reads them, so they cannot loosen policy
 * (there is no per-family write key: prod writes are a code change, PK-14).
 */
export function parseBackendProfile(raw: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: "not valid JSON" };
  }
  if (!isRecord(value)) {
    return { error: "not a JSON object" };
  }
  if (value.profile !== undefined && value.profile !== "zw2") {
    return { error: 'profile must be "zw2"' };
  }
  if (value.authMode !== undefined && value.authMode !== "anonymous") {
    return { error: 'authMode must be "anonymous" (login modes arrive with PK-12)' };
  }
  const env = value.env;
  if (env !== "prod" && env !== "dev") {
    return { error: 'env must be "prod" or "dev"' };
  }
  const mode = value.mode ?? "read-only";
  if (!MODES.has(mode as BackendMode)) {
    return { error: 'mode must be "off", "read-only" or "read-write"' };
  }
  // The new app in production stays read-only (INV-2). With read-write the guard
  // passes any method, so no file edit may grant it on prod: lifting the cap
  // for a family is a reviewed code change (PK-14), never a profile key.
  if (mode === "read-write" && env !== "dev") {
    return {
      error:
        'mode "read-write" is dev-only: prod is read-only until a reviewed code change lifts this cap',
    };
  }

  const hosts = value.allowedHosts;
  if (!Array.isArray(hosts) || hosts.length === 0) {
    return { error: "allowedHosts must be a non-empty array" };
  }
  const allowedHosts: string[] = [];
  for (const [index, entry] of hosts.entries()) {
    const host = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!ENV_APP_HOSTS[env].includes(host)) {
      // The entry itself is never echoed: errors land in the audit log.
      return { error: `allowedHosts entry ${index + 1} is not an allowed ${env} app host` };
    }
    allowedHosts.push(host);
  }

  let base: URL;
  try {
    base = new URL(String(value.baseUrl));
  } catch {
    return { error: "baseUrl is not a URL" };
  }
  const protocolOk = base.protocol === "https:" || (env === "dev" && base.protocol === "http:");
  const originOnly = base.pathname === "/" && !base.search && !base.hash;
  if (!protocolOk || base.username || base.password || !originOnly) {
    return {
      error: "baseUrl must be a bare origin (https; http only for dev), no credentials or path",
    };
  }
  if (!allowedHosts.includes(base.host)) {
    return { error: "baseUrl host is not in allowedHosts" };
  }

  const digestEnabled = value.digestEnabled ?? false;
  if (typeof digestEnabled !== "boolean") {
    return { error: "digestEnabled must be a boolean" };
  }
  const rpm = value.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE;
  if (!Number.isInteger(rpm) || (rpm as number) < 1 || (rpm as number) > 600) {
    return { error: "maxRequestsPerMinute must be an integer from 1 to 600" };
  }
  // A Host override re-routes a connection behind a shared proxy, so prod
  // (Traefik in front of many services) never gets one; the dev sprint needs it.
  const hostHeader = value.hostHeader;
  if (
    hostHeader !== undefined &&
    (env !== "dev" || typeof hostHeader !== "string" || !DEV_HOST_HEADERS.includes(hostHeader))
  ) {
    return { error: `hostHeader is dev-only: one of ${DEV_HOST_HEADERS.join(", ")}` };
  }
  const links = value.issueLinks ?? {};
  if (!isRecord(links) || !Object.values(links).every(isIssueLink)) {
    return { error: `issueLinks must map family ids to ${ISSUE_LINK_PREFIX} URLs` };
  }

  return {
    profile: {
      profile: "zw2",
      env,
      baseUrl: base.origin,
      allowedHosts,
      authMode: "anonymous",
      mode: mode as BackendMode,
      digestEnabled,
      maxRequestsPerMinute: rpm as number,
      ...(hostHeader ? { hostHeader } : {}),
      issueLinks: links as Record<string, string>,
    },
  };
}

// --- audit sink for policy/guard events ---------------------------------------

/**
 * The policy/guard subset of the audit-v2 event_type enum (AuditEventType in
 * audit-chain.ts; the scopelyFetch guard writes its own rows of these types):
 *   policy_change           profile file read (valid, or fail-closed default)
 *   backend_off             guard: mode "off" (kill switch)
 *   write_blocked_read_only guard, registry, stageWrite or CONFIRM refused a write
 *   host_blocked            guard: no valid profile, a path off the app host, or
 *                           a built URL whose host left allowedHosts
 *   header_blocked          guard: caller header outside the allow-list
 *   body_blocked            guard: a GET/HEAD request with a body
 *   redirect_blocked        guard: the app answered 3xx
 *   rate_limited            guard: per-minute cap reached, or the app said 429
 *   not_available           registry: tool not live/local (details.reason:
 *                           tool_not_available | tool_not_ported | tool_not_registered)
 *   digest_skipped          daily digest tick while digestEnabled is false
 */
export type BackendAuditEvent =
  | "policy_change"
  | "backend_off"
  | "write_blocked_read_only"
  | "host_blocked"
  | "header_blocked"
  | "body_blocked"
  | "redirect_blocked"
  | "rate_limited"
  | "not_available"
  | "digest_skipped";

/**
 * Append a policy/guard event to the workspace audit-v2 chain (best-effort:
 * nothing was sent, so a failed append only marks the writer degraded).
 * Callers pass codes and short values only; every detail is still redacted
 * and length-bounded in audit.ts.
 */
export function auditBackendEvent(
  event: BackendAuditEvent,
  details: Record<string, unknown>,
  workspaceDir = resolveWorkspaceDir(),
): void {
  auditEventBestEffort(workspaceDir, event, { detail: details });
}

// --- live read ------------------------------------------------------------------

// Last seen file content (by sha256) per profile path. Parsing happens only when
// the content changes, and every change writes ONE policy_change row, so a bad
// edit is audited once rather than on every request.
const seen = new Map<
  string,
  { sha: string; profile: BackendProfile; policy: Parameters<typeof noteAuditPolicy>[0] }
>();
let testOverride: BackendProfile | undefined;

// Read the profile without trusting what sits at the path. O_NONBLOCK: opening
// a FIFO must not block the event loop; fstat on the opened fd (no
// check-then-open race) then requires a regular file under the size cap.
function readProfileText(file: string): { raw: string } | { error: string } {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      error:
        code === "ENOENT" ? "profile file missing" : `profile file unreadable (${code ?? "error"})`,
    };
  }
  try {
    if (!fstatSync(fd).isFile()) {
      return { error: "profile file is not a regular file" };
    }
    const buf = Buffer.alloc(MAX_PROFILE_BYTES + 1);
    let size = 0;
    while (size < buf.length) {
      const n = readSync(fd, buf, size, buf.length - size, size);
      if (n === 0) {
        break;
      }
      size += n;
    }
    if (size > MAX_PROFILE_BYTES) {
      return { error: "profile file is larger than 64 KB" };
    }
    return { raw: buf.toString("utf8", 0, size) };
  } catch (err) {
    return { error: `profile file unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  } finally {
    closeSync(fd);
  }
}

export function readBackendProfile(workspaceDir = resolveWorkspaceDir()): BackendProfile {
  if (testOverride) {
    noteAuditPolicy({
      env: testOverride.env,
      state: "valid",
      mode: testOverride.mode,
      profile_sha256: null,
    });
    return testOverride;
  }
  const file = join(workspaceDir, PROFILE_FILE);
  const read = readProfileText(file);
  const sha = "raw" in read ? createHash("sha256").update(read.raw).digest("hex") : read.error;
  const cached = seen.get(file);
  if (cached?.sha === sha) {
    noteAuditPolicy(cached.policy);
    return cached.profile;
  }

  const parsed: ParseResult = "raw" in read ? parseBackendProfile(read.raw) : read;
  // Frozen: every caller shares this cached object, so none may loosen it.
  const profile = Object.freeze("profile" in parsed ? parsed.profile : defaultBackendProfile());
  // Rows carry env "unknown" under the fail-closed default (its env is not the file's).
  const policy = {
    env: "error" in parsed ? ("unknown" as const) : profile.env,
    state: "error" in parsed ? ("fail_closed_default" as const) : ("valid" as const),
    mode: profile.mode,
    profile_sha256: "raw" in read ? sha : null,
  };
  seen.set(file, { sha, profile, policy });
  noteAuditPolicy(policy);
  auditBackendEvent(
    "policy_change",
    "error" in parsed
      ? {
          valid: false,
          sha256: "raw" in read ? sha : null,
          error: parsed.error,
          applied: "fail-closed default",
        }
      : {
          valid: true,
          sha256: sha,
          env: profile.env,
          mode: profile.mode,
          allowedHosts: profile.allowedHosts,
        },
    workspaceDir,
  );
  return profile;
}

/**
 * Test-only: pin the profile without a file (null restores live reads). The
 * override is validated like a real profile file, on top of the valid DEV
 * profile, so no test can pin a state the parser refuses. It throws outside a
 * Vitest worker, and the AST closure scan (single-choke-point.test.ts) forbids
 * calling it from production modules.
 */
export function setBackendProfileForTest(profile: Partial<BackendProfile> | null): void {
  if (!process.env.VITEST) {
    throw new Error("setBackendProfileForTest is test-only");
  }
  if (!profile) {
    testOverride = undefined;
    return;
  }
  const devHost = ENV_APP_HOSTS.dev[0];
  const parsed = parseBackendProfile(
    JSON.stringify({
      env: "dev",
      baseUrl: `http://${devHost}`,
      allowedHosts: [devHost],
      ...profile,
    }),
  );
  if ("error" in parsed) {
    throw new Error(`invalid test profile: ${parsed.error}`);
  }
  testOverride = Object.freeze(parsed.profile);
}
