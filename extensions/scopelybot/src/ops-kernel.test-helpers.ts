// Test-only, contract-faithful mock of the ZW operator-layer kernel, at the
// fetch boundary (the env host table admits no loopback host, so a socket
// server could not be reached through the guard; the suite does no network
// I/O). It mirrors zoomwarriors_2 commit 301b1c0e, apps/opsplane:
//   - edge_rest.py OpsEdgeView: the emergency kill (OPS_KILL_ALL / file) answers
//     503 ops_disabled BEFORE authentication; identity.py OpsTokenAuthentication
//     accepts only `Authorization: Bearer zwops_<12 hex>_<32-64 [A-Za-z0-9_-]>`,
//     else 401 authentication_failed; both use the bare spine envelope
//     {detail, code, request_id} (spine_api/views/base.py _envelope);
//   - edge_rest.py call_ids: body correlation_id, else X-Correlation-Id, else the
//     request id; X-Ops-Bot-Audit-Id for service tokens; ids must match
//     [A-Za-z0-9._:-]{1,128}, else 400 validation_error (bare envelope);
//   - kernel.py invoke: unknown capability 404, unresolved requester 403
//     requester_unresolved (only system.whoami passes), family switch 503
//     capability_disabled, permission 403 permission_denied, args 400
//     invalid_args; success {ok, request_id, correlation_id, capability,
//     untrusted_output, data}; errors via kernel._error;
//   - every response carries x-request-id (a uuid4).
// Capabilities and input schemas come from SNAPSHOT, a byte copy of
// apps/opsplane/capabilities.snapshot.json at 301b1c0e (retrieved 2026-10-13,
// sha256 pinned in ops-client.test.ts). Refresh it by copying the committed
// file again; never edit it by hand.

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

export type MockUser = { email: string; staff: boolean; id: number };
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
};

const INVOKE = "/api/spine/v1/ops/invoke/";
const TOKEN_RE = /^zwops_([0-9a-f]{12})_([A-Za-z0-9_-]{32,64})$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PRINCIPAL = { id: 7, name: "scopelybot", organization: "platform" };
const ORG = { id: 1, slug: "platform" };
const STAFF_FAMILIES = new Set(["sessions", "pricing"]);
/** kernel.py: the requester-gate refusal text. */
export const REQUESTER_UNRESOLVED_DETAIL =
  "The requester is not mapped to a platform user; only system.whoami is available.";

function defaultData(
  cap: SnapshotCapability,
  actor: MockUser | undefined,
  status: string,
  killed: Set<string>,
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
    case "catalog.vendors.list":
      return { items: [{ key: "zoom", display_name: "Zoom" }], total: 1, truncated: false };
    default:
      return { items: [], total: 0, truncated: false };
  }
}

/** A fetch implementation answering like the kernel, plus every call it saw. */
export function mockKernel(opts: KernelOptions) {
  const calls: KernelCall[] = [];
  const impl = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    let body: KernelCall["body"] = {};
    try {
      body = JSON.parse(String(init.body ?? "{}"));
    } catch {
      body = {};
    }
    const requestId = randomUUID();
    const respond = (status: number, response: Record<string, unknown>) => {
      calls.push({ url: url.href, method: init.method ?? "GET", headers, body, status, response });
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json", "x-request-id": requestId },
      });
    };
    // spine_api/views/base.py _envelope: no ok, no correlation id.
    const bare = (status: number, code: string, detail: string) =>
      respond(status, { detail, code, request_id: requestId });

    if (url.pathname !== INVOKE || init.method !== "POST") {
      return bare(404, "not_found", "Not found.");
    }
    if (opts.killAll) {
      return bare(503, "ops_disabled", "The operator plane is disabled.");
    }
    const auth = headers.authorization;
    if (!auth) {
      return bare(401, "authentication_failed", "Authentication credentials were not provided.");
    }
    const [scheme, raw] = [auth.slice(0, auth.indexOf(" ")), auth.slice(auth.indexOf(" ") + 1)];
    if (scheme !== "Bearer" || !TOKEN_RE.test(raw.trim()) || raw.trim() !== opts.token) {
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
    // identity.resolve_requester (service token): missing / ambiguous / unmapped / resolved
    const claim = (headers["x-ops-requester"] ?? "").trim();
    const actor =
      claim && !claim.includes(",") && claim.length <= 254
        ? opts.users.find((u) => u.email.toLowerCase() === claim.toLowerCase())
        : undefined;
    const status = !claim
      ? "missing"
      : claim.includes(",") || claim.length > 254
        ? "ambiguous"
        : actor
          ? "resolved"
          : "unmapped";
    if (!cap) {
      return error(404, "unknown_capability", "Unknown capability.");
    }
    if (!actor && cap.name !== "system.whoami") {
      return error(403, "requester_unresolved", REQUESTER_UNRESOLVED_DETAIL);
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
      data: opts.data?.[cap.name] ?? defaultData(cap, actor, status, killed),
    });
  };
  return { impl, calls };
}
