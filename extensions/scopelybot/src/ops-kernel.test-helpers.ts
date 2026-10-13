// Test-only, contract-faithful mock of the ZW operator-layer kernel, at the
// fetch boundary (the env host table admits no loopback host, so a socket
// server could not be reached through the guard; the suite does no network
// I/O). It mirrors zoomwarriors_2 apps/opsplane at commit 39140839 (the
// review-round-1 kernel; the snapshot is unchanged since 301b1c0e):
//   - edge_rest.py OpsEdgeView: the emergency kill (OPS_KILL_ALL / file) answers
//     503 ops_disabled BEFORE authentication; identity.py OpsTokenAuthentication
//     accepts only `Authorization: Bearer zwops_<12 hex>_<32-64 [A-Za-z0-9_-]>`
//     (scheme case-insensitive), else 401 authentication_failed; both use the
//     bare spine envelope {detail, code, request_id} (spine_api/views/base.py
//     _envelope), as do DRF's own pre-kernel errors (400 parse_error, 413
//     payload_too_large, 415), which the bot's guard-built JSON never earns;
//   - edge_rest.py call_ids: body correlation_id, else X-Correlation-Id, else the
//     request id; X-Ops-Bot-Audit-Id for service tokens; ids must match
//     [A-Za-z0-9._:-]{1,128}, else 400 validation_error (bare envelope);
//   - requester by Zoom user id (IDENTITY-B contract; mirrored from builder
//     E's uncommitted identity.py / capabilities_system.py in the zw2
//     worktree, 2026-10-13): X-Ops-Requester-Zoom-Id normalised like
//     canonicalZoomId and looked up on ZoomIdentityLink.zoom_user_id (same org
//     as the principal); the legacy X-Ops-Requester email header = unmapped
//     ("no longer supported"), blank = missing, a comma = ambiguous,
//     malformed = unmapped, unlinked = unmapped with one detail for every
//     cause; whoami echoes requester.zoom_user_id (canonical id, null when
//     none or invalid) and requester.detail;
//   - a JSON-only renderer: an Accept that admits no JSON is a 406 (bare);
//   - kernel.py invoke: unknown capability 404, unresolved requester 403
//     requester_unresolved with a per-status detail (_GATE_DETAIL; only
//     system.whoami passes), family switch 503 capability_disabled,
//     permission 403 permission_denied, args 400 invalid_args; success {ok,
//     request_id, correlation_id, capability, untrusted_output, data} with the
//     handlers' real data shapes (_domain_refs stripped); errors via
//     kernel._error. The per-(token, requester) throttle (429) is not
//     modeled: the guard answers any 429 as busy before reading a body;
//   - every response carries x-request-id (a uuid4).
// Capabilities and input schemas come from SNAPSHOT, a byte copy of
// apps/opsplane/capabilities.snapshot.json (identical at 301b1c0e and
// 39140839, retrieved 2026-10-13, sha256 pinned in ops-client.test.ts).
// Refresh it by copying the committed file again; never edit it by hand.
// `validate` covers the keywords the snapshot uses with ECMA semantics (the
// kernel's _ecma_pattern makes `$` end-only too); it measures string length
// in UTF-16 units where the kernel counts code points, which no slice-1 schema
// makes observable (no non-ASCII pattern or bound).

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

export type JsonSchema = {
  type?: "object" | "string" | "integer" | "boolean" | "array";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minProperties?: number;
  maxProperties?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  items?: JsonSchema;
  maxItems?: number;
  uniqueItems?: boolean;
};
export type SnapshotCapability = {
  name: string;
  wire_name: string;
  family: string;
  effect: "read" | "write";
  summary: string;
  input_schema: JsonSchema;
  max_items: number;
  untrusted_output: boolean;
};

export const SNAPSHOT_FILE = new URL("./fixtures/ops-capabilities.snapshot.json", import.meta.url);
export const SNAPSHOT: { version: number; capabilities: SnapshotCapability[] } = JSON.parse(
  fs.readFileSync(SNAPSHOT_FILE, "utf8"),
);

/**
 * The JSON Schema subset the snapshot uses (Draft 2020-12 keywords above),
 * for the binding cross-check and the mock's args check. Returns the errors,
 * [] when valid.
 */
export function validate(schema: JsonSchema, value: unknown, at = "args"): string[] {
  const errors: string[] = [];
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  switch (schema.type) {
    case "object":
      if (!isObject) {
        return [`${at}: not an object`];
      }
      break;
    case "array":
      if (!Array.isArray(value)) {
        return [`${at}: not an array`];
      }
      break;
    case "string":
      if (typeof value !== "string") {
        return [`${at}: not a string`];
      }
      break;
    case "integer":
      if (!Number.isInteger(value)) {
        return [`${at}: not an integer`];
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        return [`${at}: not a boolean`];
      }
      break;
    default:
      break;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: not one of the enum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${at}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${at}: below ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${at}: above ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}: more than ${schema.maxItems} items`);
    }
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${at}: items not unique`);
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(schema.items!, item, `${at}/${i}`)));
    }
  }
  if (isObject) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push(`${at}: fewer than ${schema.minProperties} properties`);
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push(`${at}: more than ${schema.maxProperties} properties`);
    }
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        errors.push(`${at}/${key}: required`);
      }
    }
    for (const key of keys) {
      const prop = schema.properties?.[key];
      if (prop) {
        errors.push(...validate(prop, record[key], `${at}/${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}/${key}: additional property`);
      }
    }
  }
  return errors;
}

/** A ZW user with a ZoomIdentityLink.zoom_user_id (canonical) in the principal's org. */
export type MockUser = { zoomId: string; staff: boolean; id: number };
export type KernelCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { capability?: unknown; args?: unknown; correlation_id?: unknown };
  status: number;
  response: Record<string, unknown>;
};
export type KernelOptions = {
  /** The service token the kernel knows (a zwops_ token). */
  token: string;
  users: MockUser[];
  /** OPS_KILL_ALL or the kill file: every call refused before authentication. */
  killAll?: boolean;
  /** Families whose OpsFamilySwitch row disables reads. */
  killFamilies?: string[];
  /** Per-capability handler data (default: a small answer in the real shape). */
  data?: Record<string, Record<string, unknown>>;
  /** Answer every authenticated call with this refusal (kernel envelope, or bare for an edge code). */
  refuse?: { status: number; code: string; detail: string; bare?: boolean };
  /** throttle.allow: calls per (token, requester) bucket; all unresolved askers share one. */
  throttlePerBucket?: number;
};

const INVOKE = "/api/spine/v1/ops/invoke/";
const TOKEN_RE = /^zwops_([0-9a-f]{12})_([A-Za-z0-9_-]{32,64})$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PRINCIPAL = { id: 7, name: "scopelybot", organization: "platform" };
const ORG = { id: 1, slug: "platform" };
const STAFF_FAMILIES = new Set(["sessions", "pricing"]);
const PROJECT_TYPE = { key: "ucaas", label: "UCaaS", enabled: true, scope_category: "ucaas" };
const VENDOR_ROW = {
  key: "zoom",
  name: "Zoom",
  is_source: true,
  is_destination: true,
  logo_url: null,
  project_types: [PROJECT_TYPE],
};
const SESSION_ROW = {
  id: 42,
  order_number: "PS-0000042",
  status: "signed",
  company_name: "Acme",
  vendor_key: "zoom",
  vendor_name: "Zoom",
  project_type: "ucaas",
  deployment_type: "autopilot",
  grand_total: "1200.00",
  organization_id: 3,
  organization_name: "Acme Org",
  historical_vip_execution: false,
  created_at: "2026-10-01T00:00:00+00:00",
  updated_at: "2026-10-02T00:00:00+00:00",
};
/** identity.py _DETAIL (+ _WHOAMI_ONLY) for a service token, by cause. */
const WHOAMI_ONLY = " Only system.whoami is available.";
export const GATE_DETAIL = {
  legacy_header: `X-Ops-Requester (an email) is no longer supported: the bot must send the sender's Zoom user id in X-Ops-Requester-Zoom-Id.${WHOAMI_ONLY}`,
  missing: `This service token must name the person it acts for by Zoom user id in X-Ops-Requester-Zoom-Id.${WHOAMI_ONLY}`,
  multiple: `X-Ops-Requester-Zoom-Id names more than one person.${WHOAMI_ONLY}`,
  malformed: `X-Ops-Requester-Zoom-Id is not a valid Zoom user id.${WHOAMI_ONLY}`,
  // The same text for no link, an inactive link or user, and another org.
  unlinked: (id: string) =>
    `Zoom id ${id} is not mapped to a platform user: ask an admin to link Zoom id ${id} to your account.${WHOAMI_ONLY}`,
};

// The kernel's own normaliser (zoom_id_vectors.json "rules"), written
// independently of canonicalZoomId so the shared vectors test two
// implementations: ASCII-whitespace trim, one case-insensitive ASCII suffix,
// ASCII only, then lower-case.
const ASCII_WS = " \t\n\r\f\v";
const isAscii = (text: string) => [...text].every((ch) => ch.charCodeAt(0) < 128);
export function kernelCanonical(raw: string): string | null {
  let start = 0;
  let end = raw.length;
  while (start < end && ASCII_WS.includes(raw[start])) {
    start++;
  }
  while (end > start && ASCII_WS.includes(raw[end - 1])) {
    end--;
  }
  let id = raw.slice(start, end);
  const tail = id.slice(-13);
  if (isAscii(tail) && tail.length === 13 && tail.toLowerCase() === "@xmpp.zoom.us") {
    id = id.slice(0, -13);
  }
  if (!isAscii(id)) {
    return null;
  }
  id = id.toLowerCase();
  return /^[a-z0-9_-]{6,64}$/.test(id) ? id : null;
}

function defaultData(
  cap: SnapshotCapability,
  actor: MockUser | undefined,
  status: string,
  killed: Set<string>,
  zoomUserId: string | null,
  detail: string,
): Record<string, unknown> {
  switch (cap.name) {
    case "system.whoami":
      // capabilities_system.whoami: a bot never gets the email echoed.
      return {
        requester: {
          kind: "bot",
          status,
          user_id: actor?.id ?? null,
          email: null,
          is_platform_staff: Boolean(actor?.staff),
          zoom_user_id: zoomUserId,
          detail: detail || null,
        },
        via_principal: PRINCIPAL,
        org: ORG,
        client: "bot",
      };
    case "system.health": {
      const families = [...new Set(SNAPSHOT.capabilities.map((c) => `${c.family}|${c.effect}`))]
        .toSorted()
        .map((key) => {
          const [family, effect] = key.split("|");
          return { family, effect, enabled: !killed.has(family) };
        });
      return {
        status: "ok",
        capabilities: SNAPSHOT.capabilities.length,
        registry_frozen: true,
        families,
      };
    }
    // catalog/ops_capabilities.py handlers
    case "catalog.vendors.list":
      return { items: [VENDOR_ROW], total: 1, truncated: false };
    case "catalog.vendors.get":
      return {
        ...VENDOR_ROW,
        config_version: 3,
        intake: [{ key: "company", title: "Company", fields: [] }],
        truncated: false,
      };
    case "catalog.project_types.list":
      return {
        vendor_key: "zoom",
        config_version: 3,
        items: [PROJECT_TYPE],
        total: 1,
        truncated: false,
      };
    case "catalog.deployment_types.list":
      return {
        vendor_key: "zoom",
        project_type: "ucaas",
        items: [{ key: "autopilot", label: "Autopilot", description: "Hands-off" }],
        total: 1,
        truncated: false,
      };
    case "catalog.scoping_cards.list":
      return {
        vendor_key: "zoom",
        project_type: "ucaas",
        config_version: 3,
        items: [{ key: "sites", title: "Sites", field_count: 2 }],
        total: 1,
        truncated: false,
      };
    case "catalog.scoping_cards.get":
      return {
        vendor_key: "zoom",
        project_type: "ucaas",
        config_version: 3,
        key: "sites",
        title: "Sites",
        field_count: 1,
        fields: [{ key: "site_count", label: "Sites", field_type: "number", options: [] }],
        truncated: false,
      };
    // pricing/ops_capabilities.py _defaults_list
    case "pricing.defaults.list":
      return {
        vendor_key: "zoom",
        card: {
          version: 2,
          status: "active",
          source: "seed",
          effective_from: null,
          effective_to: null,
        },
        items: [{ pricing_key: "site", label: "Site", unit_amount: "100.00", currency: "USD" }],
        total: 1,
        truncated: false,
      };
    // orders/ops_capabilities.py
    case "sessions.list":
      return { items: [SESSION_ROW], total: 1, page: 1, page_size: 25, truncated: false };
    case "sessions.get":
      return {
        ...SESSION_ROW,
        version: 4,
        answer_count: 2,
        answer_keys: ["a", "b"],
        truncated: false,
      };
    default:
      return { items: [], total: 0, truncated: false };
  }
}

/** A fetch implementation answering like the kernel, plus every call it saw. */
export function mockKernel(opts: KernelOptions) {
  const calls: KernelCall[] = [];
  const buckets = new Map<string, number>();
  const impl = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    const method = (init.method ?? "GET").toUpperCase();
    const rawBody = typeof init.body === "string" ? init.body : "";
    let body: KernelCall["body"] = {};
    let parsed = true;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      parsed = false;
      body = {};
    }
    const requestId = randomUUID();
    const respond = (
      status: number,
      response: Record<string, unknown>,
      extra: Record<string, string> = {},
    ) => {
      calls.push({ url: url.href, method, headers, body, status, response });
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json", "x-request-id": requestId, ...extra },
      });
    };
    // spine_api/views/base.py _envelope: no ok, no correlation id.
    const bare = (status: number, code: string, detail: string, extra?: Record<string, string>) =>
      respond(status, { detail, code, request_id: requestId }, extra);

    if (url.pathname !== INVOKE) {
      return bare(404, "not_found", "Not found.");
    }
    // DRF answers a wrong method before authentication (edge_rest.py 39140839).
    if (method !== "POST") {
      return bare(405, "method_not_allowed", `Method "${method}" not allowed.`, {
        allow: "POST, OPTIONS",
      });
    }
    if (opts.killAll) {
      return bare(503, "ops_disabled", "The operator plane is disabled.");
    }
    // JSON-only renderer: an Accept that admits no JSON is a 406.
    const accept = headers.accept ?? "*/*";
    if (!/(^|,)\s*(\*\/\*|application\/\*|application\/json)\s*(;|,|$)/.test(accept)) {
      return bare(406, "not_acceptable", "Could not satisfy the request Accept header.");
    }
    const auth = headers.authorization;
    if (!auth) {
      return bare(401, "authentication_failed", "Authentication credentials were not provided.");
    }
    const [scheme, raw] = [auth.slice(0, auth.indexOf(" ")), auth.slice(auth.indexOf(" ") + 1)];
    if (
      scheme.toLowerCase() !== "bearer" ||
      !TOKEN_RE.test(raw.trim()) ||
      raw.trim() !== opts.token
    ) {
      return bare(401, "authentication_failed", "Invalid token.");
    }
    const bodyCorrelation = typeof body.correlation_id === "string" ? body.correlation_id : "";
    const correlation = bodyCorrelation || headers["x-correlation-id"] || "";
    const botAuditId = headers["x-ops-bot-audit-id"] ?? "";
    for (const [field, value] of [
      ["correlation_id", correlation],
      ["bot_audit_id", botAuditId],
    ]) {
      if (value && !ID_RE.test(value)) {
        return bare(400, "validation_error", `${field}: must match [A-Za-z0-9._:-]{1,128}`);
      }
    }
    // OpsJSONParser (after authentication): JSON only, at most 64 KB.
    if (!(headers["content-type"] ?? "").startsWith("application/json")) {
      return bare(415, "unsupported_media_type", "Unsupported media type in request.");
    }
    if (Buffer.byteLength(rawBody) > 64 * 1024) {
      return bare(413, "payload_too_large", `Request body exceeds ${64 * 1024} bytes.`);
    }
    if (!parsed) {
      return bare(400, "parse_error", "JSON parse error - not valid JSON.");
    }
    if (opts.refuse?.bare) {
      return bare(opts.refuse.status, opts.refuse.code, opts.refuse.detail);
    }
    const correlationId = correlation || requestId;
    const name = typeof body.capability === "string" ? body.capability : null;
    // kernel._error
    const error = (status: number, code: string, detail: string) =>
      respond(status, {
        ok: false,
        request_id: requestId,
        correlation_id: correlationId,
        capability: name,
        error: { detail, code, request_id: requestId },
      });

    const cap = SNAPSHOT.capabilities.find((c) => c.name === name);
    // identity.resolve_requester (service token), in its order: legacy email
    // header, blank, a comma, malformed, unlinked, resolved.
    const claim = headers["x-ops-requester-zoom-id"] ?? "";
    const blank = (value: string) => value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "") === "";
    const legacy = !blank(headers["x-ops-requester"] ?? "");
    const canonical =
      !legacy && !blank(claim) && !claim.includes(",") ? kernelCanonical(claim) : null;
    const actor = canonical ? opts.users.find((u) => u.zoomId === canonical) : undefined;
    const [status, detail, zoomUserId] = legacy
      ? ["unmapped", GATE_DETAIL.legacy_header, null]
      : blank(claim)
        ? ["missing", GATE_DETAIL.missing, null]
        : claim.includes(",")
          ? ["ambiguous", GATE_DETAIL.multiple, null]
          : !canonical
            ? ["unmapped", GATE_DETAIL.malformed, null]
            : !actor
              ? ["unmapped", GATE_DETAIL.unlinked(canonical), canonical]
              : ["resolved", "", canonical];
    if (opts.refuse) {
      return error(opts.refuse.status, opts.refuse.code, opts.refuse.detail);
    }
    // 2b. throttle per (token, requester); every unresolved asker shares one bucket.
    if (opts.throttlePerBucket !== undefined) {
      const bucket = actor ? `user:${actor.id}` : "unresolved";
      const used = (buckets.get(bucket) ?? 0) + 1;
      buckets.set(bucket, used);
      if (used > opts.throttlePerBucket) {
        return error(429, "throttled", "Too many requests; slow down.");
      }
    }
    if (!cap) {
      return error(404, "unknown_capability", "Unknown capability.");
    }
    if (!actor && cap.name !== "system.whoami") {
      return error(403, "requester_unresolved", detail);
    }
    const killed = new Set(opts.killFamilies ?? []);
    if (killed.has(cap.family)) {
      return error(503, "capability_disabled", "This capability is disabled.");
    }
    if (STAFF_FAMILIES.has(cap.family) && !actor?.staff) {
      return error(403, "permission_denied", "Permission denied.");
    }
    const argErrors = validate(cap.input_schema, body.args ?? {});
    if (argErrors.length > 0) {
      return error(400, "invalid_args", argErrors[0].slice(0, 300));
    }
    return respond(200, {
      ok: true,
      request_id: requestId,
      correlation_id: correlationId,
      capability: cap.name,
      untrusted_output: cap.untrusted_output,
      data: opts.data?.[cap.name] ?? defaultData(cap, actor, status, killed, zoomUserId, detail),
    });
  };
  return { impl, calls };
}
