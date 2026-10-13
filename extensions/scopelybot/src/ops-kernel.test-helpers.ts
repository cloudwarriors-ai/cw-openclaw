// Test-only, contract-faithful mock of the ZW operator-layer kernel
// (SLICE1-CONTRACT sections 4, 6 and 7), at the fetch boundary: the env host
// table admits no loopback host, so a socket server could not be reached
// through the guard, and the suite does no network I/O. It is generated from
// SLICE1_SNAPSHOT, written in the shape of apps/opsplane/capabilities.snapshot.json;
// replace it with the committed snapshot when the kernel lands (the input
// schemas below are this side's assumption until then).

type JsonSchema = {
  type: "object";
  additionalProperties: false;
  required?: string[];
  properties: Record<string, { type: "string" | "integer"; enum?: string[] }>;
};
type SnapshotCapability = {
  name: string;
  family: string;
  effect: "read" | "write";
  input_schema: JsonSchema;
};

const noArgs: JsonSchema = { type: "object", additionalProperties: false, properties: {} };
const str = { type: "string" as const };
function args(required: string[], optional: Record<string, { type: "string" | "integer" }> = {}) {
  return {
    type: "object" as const,
    additionalProperties: false as const,
    required,
    properties: { ...Object.fromEntries(required.map((k) => [k, str])), ...optional },
  };
}

export const SLICE1_SNAPSHOT: { version: 1; capabilities: SnapshotCapability[] } = {
  version: 1,
  capabilities: [
    { name: "system.whoami", family: "system", effect: "read", input_schema: noArgs },
    { name: "system.health", family: "system", effect: "read", input_schema: noArgs },
    { name: "audit.search", family: "audit", effect: "read", input_schema: noArgs },
    { name: "catalog.vendors.list", family: "catalog", effect: "read", input_schema: noArgs },
    {
      name: "catalog.vendors.get",
      family: "catalog",
      effect: "read",
      input_schema: args(["vendor_key"]),
    },
    {
      name: "catalog.project_types.list",
      family: "catalog",
      effect: "read",
      input_schema: args(["vendor_key"]),
    },
    {
      name: "catalog.deployment_types.list",
      family: "catalog",
      effect: "read",
      input_schema: args(["vendor_key", "project_type"]),
    },
    {
      name: "catalog.scoping_cards.list",
      family: "catalog",
      effect: "read",
      input_schema: args(["vendor_key", "project_type"]),
    },
    {
      name: "catalog.scoping_cards.get",
      family: "catalog",
      effect: "read",
      input_schema: args(["vendor_key", "project_type", "card_key"]),
    },
    {
      name: "pricing.defaults.list",
      family: "pricing",
      effect: "read",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: { scope_category: { type: "string", enum: ["ucaas", "ccaas"] } },
      },
    },
    {
      name: "sessions.list",
      family: "sessions",
      effect: "read",
      input_schema: args([], { status: str, vendor: str, search: str, limit: { type: "integer" } }),
    },
    {
      name: "sessions.get",
      family: "sessions",
      effect: "read",
      input_schema: args(["session_id"]),
    },
  ],
};

export type MockUser = { email: string; staff: boolean };
export type KernelCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { capability?: unknown; args?: unknown; correlation_id?: unknown };
  status: number;
  response: Record<string, unknown>;
};
export type KernelOptions = {
  token: string;
  users: MockUser[];
  /** OPS_KILL_ALL: every call refused before anything else (contract section 4.3). */
  killAll?: boolean;
  killFamilies?: string[];
  /** Per-capability handler data (default: a small canned answer). */
  data?: Record<string, unknown>;
};

const INVOKE = "/api/spine/v1/ops/invoke/";

function validArgs(schema: JsonSchema, value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["args: not an object"];
  }
  const errors: string[] = [];
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const prop = schema.properties[key];
    if (!prop) {
      errors.push(`${key}: unexpected`);
    } else if (
      prop.type === "string" ? typeof record[key] !== "string" : !Number.isInteger(record[key])
    ) {
      errors.push(`${key}: not a ${prop.type}`);
    } else if (prop.enum && !prop.enum.includes(record[key] as string)) {
      errors.push(`${key}: not one of ${prop.enum.join(", ")}`);
    }
  }
  for (const key of schema.required ?? []) {
    if (!(key in record)) {
      errors.push(`${key}: required`);
    }
  }
  return errors;
}

function defaultData(capability: string, actor: MockUser | undefined): unknown {
  switch (capability) {
    case "system.whoami":
      return { acting_user: actor?.email ?? null, requester_kind: "bot", via_principal: "svc-bot" };
    case "system.health":
      return { status: "ok", database: true };
    case "catalog.vendors.list":
      return [{ key: "zoom", display_name: "Zoom" }];
    default:
      return { capability };
  }
}

/** A fetch implementation answering like the kernel, plus every call it saw. */
export function mockKernel(opts: KernelOptions) {
  const calls: KernelCall[] = [];
  let seq = 0;
  const impl = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    let body: KernelCall["body"] = {};
    try {
      body = JSON.parse(String(init.body ?? "{}"));
    } catch {
      body = {};
    }
    const requestId = `req-${++seq}`;
    const answer = (
      status: number,
      payload: { data: unknown } | { error: Record<string, unknown> },
    ) => {
      const response = {
        ok: "data" in payload,
        request_id: requestId,
        correlation_id: typeof body.correlation_id === "string" ? body.correlation_id : null,
        ...payload,
      };
      calls.push({ url: url.href, method: init.method ?? "GET", headers, body, status, response });
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json", "x-request-id": requestId },
      });
    };
    const refuse = (status: number, code: string, detail: string) =>
      answer(status, { error: { code, detail } });

    if (url.pathname !== INVOKE || init.method !== "POST") {
      return refuse(404, "not_found", "no such operator-layer route");
    }
    // 1. edge credential
    if (headers["x-service-token"] !== opts.token) {
      return refuse(401, "unauthenticated", "service token missing or wrong");
    }
    const keys = Object.keys(body).toSorted();
    if (keys.join(",") !== "args,capability,correlation_id") {
      return refuse(400, "invalid_request", `body keys: ${keys.join(",")}`);
    }
    // 3. kill switch (env/file override): no database, refuse everything
    if (opts.killAll) {
      return refuse(503, "kill_switch", "OPS_KILL_ALL is set");
    }
    const cap = SLICE1_SNAPSHOT.capabilities.find((c) => c.name === body.capability);
    if (!cap) {
      return refuse(404, "unknown_capability", "no such capability");
    }
    // 2. acting user: unmapped, ambiguous or missing requester = whoami only
    const claim = headers["x-ops-requester"];
    const matches = claim
      ? opts.users.filter((u) => u.email.toLowerCase() === claim.toLowerCase())
      : [];
    const actor = matches.length === 1 ? matches[0] : undefined;
    if (!actor && cap.name !== "system.whoami") {
      return refuse(403, "requester_unresolved", "requester is not mapped to a user");
    }
    if (opts.killFamilies?.includes(cap.family)) {
      return refuse(503, "kill_switch", `family ${cap.family} is switched off`);
    }
    const argErrors = validArgs(cap.input_schema, body.args);
    if (argErrors.length > 0) {
      return refuse(400, "invalid_args", argErrors.join("; "));
    }
    // 5. permission from the acting user's grants (sessions and audit are staff-only here)
    if (["sessions", "audit"].includes(cap.family) && !actor?.staff) {
      return refuse(403, "permission_denied", "platform staff only");
    }
    return answer(200, { data: opts.data?.[cap.name] ?? defaultData(cap.name, actor) });
  };
  return { impl, calls };
}
