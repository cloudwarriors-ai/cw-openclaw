// Real plugin factories/guard/audit against a mocked HTTP boundary. Actual native
// permissions, selectors and REST/MCP audit behavior are proved by backend P4 tests.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("./comfort.js", () => ({
  sendScopelyText: send,
  getChannelThreadAnchor: () => undefined,
  rememberChannelThreadAnchor: () => {},
  resolveInboundThreadAnchor: () => undefined,
  sendComfortMessage: () => Promise.resolve(),
}));
import plugin from "../index.js";
import { readAuditRows } from "./audit.test-helpers.js";
import { opsBindingFor, registryTools } from "./capability-registry.js";
import { noteInboundSender } from "./ops-client.js";
import { mockKernel } from "./ops-kernel.test-helpers.js";
import { takePending } from "./pending-confirm.js";
import { resetInboundSendersForTest } from "./requester-epoch.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";

type Tool = {
  prepareArguments?: (args: unknown) => unknown;
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};
const TOKEN = "zwops_0123456789ab_Discovery_0123456789abcdefABCDEF_xyz";
const SENDER = "discovery-admin";
const CHANNEL = "synthetic-channel";
const HUB = `agent:scopelybot:zoom:channel:${CHANNEL}`;
const USER = {
  id: 47,
  username: "ops-test-dormant",
  email: "dormant@example.invalid",
  first_name: "Renée",
  last_name: "同名",
  is_active: false,
  native_user_role: "admin",
  last_login: null,
  created_at: null,
  updated_at: null,
  organization_count: 1,
};
const UNSUPPORTED = ["legacy_role", "session_count", "recent_sessions", "lockout_state"];
const MAPPINGS = [
  [
    "scopely_list_users",
    "identity.users.list",
    {
      search: " Renée 同名 ",
      is_active: false,
      organization_id: 3,
      ordering: "last_login",
      limit: 50,
      offset: 0,
    },
  ],
  ["scopely_get_user", "identity.users.get", { user_id: 47, limit: 50, offset: 0 }],
  [
    "scopely_list_pricing_items",
    "pricing.defaults.list",
    {
      vendor_key: "zoom",
      scope_mode: "exact",
      scope_category: "",
      category: "Core",
      is_active: true,
      limit: 20,
      offset: 2,
    },
  ],
] as const;
let workspace: string;
let kernel: ReturnType<typeof mockKernel>;
const request = vi.fn();

function profile(local = false) {
  fs.writeFileSync(
    path.join(workspace, "scopelybot-backend.json"),
    JSON.stringify({
      env: local ? "local" : "prod",
      baseUrl: local ? "http://127.0.0.1:8100" : "https://api.vip.pscx.ai",
      allowedHosts: [local ? "127.0.0.1:8100" : "api.vip.pscx.ai"],
      authMode: "service-token",
      mode: local ? "read-write" : "read-only",
    }),
  );
  resetScopelyGuardForTest();
}
function tools() {
  const out = new Map<string, Tool>();
  const ctx = {
    agentId: "scopelybot",
    sessionKey: HUB,
    requesterSenderId: SENDER,
    requesterRunStartedAt: performance.now(),
  };
  const api = {
    registerTool: (factory: (ctx: unknown) => Tool | Tool[]) => {
      const built = factory(ctx);
      for (const tool of Array.isArray(built) ? built : [built]) {
        out.set(tool.name, tool);
      }
    },
    on: () => {},
    registerHook: () => {},
  } as never;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    plugin.register(api, { writeApproverIds: [] });
  } finally {
    log.mockRestore();
  }
  return out;
}
async function run(name: string, args: Record<string, unknown> = {}, built = tools()) {
  const result = await built.get(name)!.execute("discovery-call", args);
  return JSON.parse(result.content[0].text);
}
function useKernel(opts: Partial<Parameters<typeof mockKernel>[0]> = {}) {
  kernel = mockKernel({ token: TOKEN, users: [{ zoomId: SENDER, staff: true, id: 11 }], ...opts });
  request.mockImplementation(kernel.impl);
}
function reply(data: unknown) {
  return new Response(JSON.stringify({ ok: true, request_id: "discovery-result", data }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "discovery-result" },
  });
}
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "account-discovery-"));
  vi.stubEnv("OPENCLAW_WORKSPACE", workspace);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", CHANNEL);
  profile();
  fs.writeFileSync(path.join(workspace, "scopelybot-ops-token"), TOKEN, { mode: 0o600 });
  resetInboundSendersForTest();
  noteInboundSender(HUB, SENDER);
  request.mockReset();
  send.mockReset();
  send.mockResolvedValue(undefined);
  useKernel();
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  // Discard synthetic staged callbacks without executing any confirmation.
  for (const args of send.mock.calls) {
    const code = String(args[1]).match(/CONFIRM ([a-f0-9]{32})/)?.[1];
    if (code) {
      takePending(code, { conversationId: CHANNEL });
    }
  }
  resetInboundSendersForTest();
  resetScopelyGuardForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

it.each(MAPPINGS)(
  "%s invokes only %s with unchanged native arguments",
  async (name, capability, args) => {
    const result = await run(name, { ...args });
    expect(result).toMatchObject({ ok: true, capability });
    expect(request).toHaveBeenCalledTimes(1);
    expect(kernel.calls[0].body.args).toEqual(args);
    expect(new URL(kernel.calls[0].url).pathname).toBe("/api/spine/v1/ops/invoke/");
    expect(kernel.calls[0].headers["x-ops-requester-zoom-id"]).toBe(SENDER);
    expect(send).not.toHaveBeenCalled();
  },
);
it.each(MAPPINGS)(
  "%s refuses malformed whole arguments before host normalization",
  (name, _capability, base) => {
    const tool = tools().get(name)!;
    for (const invalid of [null, undefined, [], "", "{}", 0, false]) {
      expect(() => tool.prepareArguments?.(invalid)).toThrow(/must be an object/);
    }
    for (const args of [{ ...base }, { ...base, unknown_field: null }]) {
      expect(tool.prepareArguments?.(args)).toBe(args);
    }
    expect(request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);

// Host normalization removes TypeBox symbols. Exercise its resulting plain JSON
// schemas through the public validator; core tests cover the exact host wrapper.
function prepareAndValidate(tool: Tool, args: unknown) {
  const normalized = { ...tool, parameters: structuredClone(tool.parameters) };
  const prepared = normalized.prepareArguments?.(args);
  return validateToolArguments(normalized as never, {
    type: "toolCall",
    id: "native-schema-call",
    name: tool.name,
    arguments: prepared as Record<string, unknown>,
  }) as Record<string, unknown>;
}
it.each(MAPPINGS)(
  "%s rejects raw schema type coercions for every field",
  (name, _capability, base) => {
    const tool = tools().get(name)!;
    const byType: Record<string, unknown[]> = {
      string: [null, true, false, 0, 1, [], {}],
      boolean: [null, "true", "false", 0, 1, [], {}],
      integer: [null, "1", true, false, [], {}, 1.5, Number.NaN, Infinity, -Infinity],
    };
    for (const [field, rawSchema] of Object.entries(tool.parameters.properties)) {
      const schema = rawSchema as { type: string; minimum?: number; maximum?: number };
      const invalid = [...byType[schema.type]];
      if (schema.minimum !== undefined) {
        invalid.push(schema.minimum - 1);
      }
      if (schema.maximum !== undefined) {
        invalid.push(schema.maximum + 1);
      }
      for (const value of invalid) {
        const args: Record<string, unknown> = { ...base, [field]: value };
        expect(() => tool.prepareArguments?.(args), `${name}.${field}=${String(value)}`).toThrow(
          /schema/,
        );
        expect(() => prepareAndValidate(tool, args)).toThrow();
        expect(args[field]).toBe(value);
      }
    }
    expect(request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);
it.each(MAPPINGS)(
  "%s prepared native selectors survive validation and execution exactly",
  async (name, capability, base) => {
    const tool = tools().get(name)!;
    const args = { ...base };
    const validated = prepareAndValidate(tool, args);
    expect(validated).toEqual(args);
    const result = JSON.parse(
      (await tool.execute("native-schema-call", validated)).content[0].text,
    );
    expect(result).toMatchObject({ ok: true, capability });
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0].body.args).toEqual(args);
    expect(send).not.toHaveBeenCalled();
  },
);
it.each(MAPPINGS)(
  "%s prepared native unknown fields reach backend refusal unchanged",
  async (name, _capability, base) => {
    const tool = tools().get(name)!;
    const args = { ...base, unknown_field: null };
    const validated = prepareAndValidate(tool, args);
    expect(validated).toEqual(args);
    const result = JSON.parse(
      (await tool.execute("native-schema-unknown", validated)).content[0].text,
    );
    expect(result).toMatchObject({ ok: false, refusal: "invalid_args" });
    expect(kernel.calls).toHaveLength(1);
    expect(kernel.calls[0].body.args).toEqual(args);
  },
);
it("only the three discovery bindings preserve all args and none inject defaults", async () => {
  expect(
    registryTools()
      .filter((name) => opsBindingFor(name)?.strictArgs)
      .toSorted(),
  ).toEqual(MAPPINGS.map((row) => row[0]).toSorted());
  for (const [name] of MAPPINGS) {
    expect(opsBindingFor(name)?.defaults).toBeUndefined();
  }
  await run("scopely_list_pricing_defaults", { vendor_key: "zoom", unknown: true, limit: null });
  expect(kernel.calls[0].body.args).toEqual({ vendor_key: "zoom", limit: 20 });
});
it.each([
  ["scopely_get_user", {}],
  ["scopely_list_pricing_items", {}],
  ["scopely_list_users", { role: "admin" }],
  ["scopely_list_users", { native_role: "admin" }],
  ["scopely_list_users", { is_active: null }],
  ["scopely_list_users", { offset: 2147483648 }],
  ["scopely_get_user", { user_id: null }],
  ["scopely_get_user", { user_id: true }],
  ["scopely_get_user", { user_id: 1.5 }],
  ["scopely_get_user", { user_id: 47, email: "other@example.invalid" }],
  ["scopely_list_pricing_items", { vendor_key: "zoom", project_type_id: 1 }],
  ["scopely_list_pricing_items", { vendor_key: "zoom", id: 1 }],
  ["scopely_list_pricing_items", { vendor_key: "zoom", scope_category: null }],
  ["scopely_list_pricing_items", { vendor_key: "zoom", unknown: true }],
] as const)("%s retains invalid/missing args %j for backend refusal", async (name, args) => {
  const result = await run(name, { ...args });
  expect(result).toMatchObject({ ok: false, refusal: "invalid_args" });
  expect(kernel.calls).toHaveLength(1);
  expect(kernel.calls[0].body.args).toEqual(args);
  expect(
    readAuditRows(workspace).some(
      (row) =>
        row.event_type === "http_outcome" && JSON.stringify(row.result).includes("invalid_args"),
    ),
  ).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
it.each([null, [], "bad"])(
  "non-object arguments %j refuse at the transport without I/O",
  async (args) => {
    const result = await run("scopely_list_users", args as unknown as Record<string, unknown>);
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  },
);
it.each(["permission_denied", "audit_unavailable", "not_found"])(
  "account %s is reported without data or retry",
  async (code) => {
    useKernel({ refuse: { status: 403, code, detail: "No account data" } });
    const result = await run("scopely_get_user", { user_id: 47 });
    expect(result).toMatchObject({ ok: false, refusal: code });
    expect(result).not.toHaveProperty("data");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("unresolved trusted sender refuses before account I/O", async () => {
  noteInboundSender(HUB, undefined);
  expect((await run("scopely_list_users")).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it("multi-term empty search result does not trigger legacy token retries", async () => {
  await run("scopely_list_users", { search: "Renée Missing" });
  expect(kernel.calls).toHaveLength(1);
  expect(kernel.calls[0].body.args).toEqual({ search: "Renée Missing" });
});
it("new schemas disclose native keys and unsupported dossier fields", () => {
  const built = tools();
  expect(built.get("scopely_list_users")!.parameters.properties).not.toHaveProperty("role");
  expect(built.get("scopely_list_pricing_items")!.parameters.properties).not.toHaveProperty(
    "project_type_id",
  );
  expect(built.get("scopely_get_user")!.description).toContain("unsupported_fields");
});
it.each(["A", "界", "😀", '\\"\n\t'])(
  "budget-compliant %j account data preserves IDs, header and cursor",
  async (char) => {
    const data = {
      scope: "platform_support",
      user: USER,
      unsupported_fields: UNSUPPORTED,
      items: Array.from({ length: 20 }, (_, n) => ({
        organization_id: n + 1,
        name: char.repeat(12),
        slug: `org-${n}`,
        role: "standard",
        is_active: false,
        is_platform_org: false,
      })),
      total: 21,
      next_offset: 20,
      truncated: true,
    };
    const escaped = JSON.stringify(data).replace(
      /[\u007f-\uffff]/g,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    expect(Buffer.byteLength(escaped)).toBeLessThanOrEqual(12000);
    request.mockImplementation(async () => reply(data));
    const result = await run("scopely_get_user", { user_id: 47 });
    expect(result.untrusted).toContain("data");
    expect(result.output_cut).toBeUndefined();
    expect(result.data.user.id).toBe(47);
    expect(result.data.items).toEqual(data.items);
    expect(result.data.next_offset).toBe(20);
    expect(result.data.unsupported_fields).toEqual(UNSUPPORTED);
    expect(result.note).toContain("offset 20");
  },
);
it("unexpected oversized membership pages keep the user header and visit each ID once", async () => {
  const all = Array.from({ length: 61 }, (_, n) => ({
    organization_id: n + 1,
    name: "界😀".repeat(170),
  }));
  request.mockImplementation(async (_url, init) => {
    const { args } = JSON.parse(init.body);
    const items = all.slice(args.offset, args.offset + 50);
    const next = args.offset + items.length < all.length ? args.offset + items.length : null;
    return reply({
      user: USER,
      items,
      total: all.length,
      next_offset: next,
      truncated: next !== null,
      unsupported_fields: UNSUPPORTED,
    });
  });
  const seen: number[] = [];
  let offset: number | null = 0;
  for (let page = 0; offset !== null && page < 20; page++) {
    const result = await run("scopely_get_user", { user_id: 47, limit: 50, offset });
    expect(result.ok).toBe(true);
    expect(result.data.user.id).toBe(47);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(16000);
    seen.push(...result.data.items.map((row: { organization_id: number }) => row.organization_id));
    const next: number | null = result.data.next_offset;
    expect(next === null || next > offset).toBe(true);
    offset = next;
  }
  expect(offset).toBeNull();
  expect(seen).toEqual(all.map((row) => row.organization_id));
});
it("an oversized first membership omits a zero-progress cursor and preserves its user header", async () => {
  request.mockImplementation(async () =>
    reply({
      user: USER,
      items: [{ organization_id: 1, name: "x".repeat(17000) }],
      total: 1,
      next_offset: null,
      truncated: false,
    }),
  );
  const result = await run("scopely_get_user", { user_id: 47 });
  expect(result.data.user.id).toBe(47);
  expect(result.data.items).toEqual([]);
  expect(result.data).not.toHaveProperty("next_offset");
  expect(result.note).toContain("admin");
});
it("pricing alias follows the existing native page cursor without skipping rows", async () => {
  useKernel({ pricingRows: 61 });
  const seen: string[] = [];
  let offset: number | null = 0;
  for (let page = 0; offset !== null && page < 20; page++) {
    const result = await run("scopely_list_pricing_items", {
      vendor_key: "zoom",
      limit: 50,
      offset,
    });
    expect(result.capability).toBe("pricing.defaults.list");
    expect(result.caveat).toContain("VIP native rates");
    seen.push(...result.data.items.map((row: { pricing_key: string }) => row.pricing_key));
    const next: number | null = result.data.next_offset;
    expect(next === null || next > offset).toBe(true);
    offset = next;
  }
  expect(offset).toBeNull();
  expect(seen).toHaveLength(61);
  expect(new Set(seen).size).toBe(61);
});
it("pricing alias retains staff refusal and never invokes a write", async () => {
  useKernel({ users: [{ zoomId: SENDER, staff: false, id: 11 }] });
  expect(await run("scopely_list_pricing_items", { vendor_key: "zoom" })).toMatchObject({
    ok: false,
    refusal: "permission_denied",
  });
  expect(kernel.calls.map((call) => call.body.capability)).toEqual(["pricing.defaults.list"]);
});
it("native inactive ID flows from list to get to a local preview without confirmation", async () => {
  profile(true);
  const sent: { capability: string; args: Record<string, unknown> }[] = [];
  const pending = "12345678-1234-4234-9234-123456789abc";
  request.mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    if (body.capability === "identity.users.list") {
      return reply({ items: [USER], total: 1, next_offset: null, truncated: false });
    }
    if (body.capability === "identity.users.get") {
      return reply({ user: USER, items: [], total: 0, next_offset: null, truncated: false });
    }
    expect(body.capability).toBe("identity.users.set_active");
    return reply({
      state: "pending",
      confirmation_required: true,
      pending_action_id: pending,
      preview: JSON.stringify({ user_id: 47, before: false, after: true }),
    });
  });
  const built = tools();
  const id = (await run("scopely_list_users", { search: "Renée" }, built)).data.items[0].id;
  expect((await run("scopely_get_user", { user_id: id }, built)).data.user.is_active).toBe(false);
  const preview = await run("scopely_set_user_active", { user_id: id, is_active: true }, built);
  expect(preview.staged).toBe(true);
  expect(JSON.stringify(preview)).not.toContain(pending);
  expect(sent.map((row) => row.capability)).toEqual([
    "identity.users.list",
    "identity.users.get",
    "identity.users.set_active",
  ]);
  expect(sent[2].args).toEqual({ user_id: 47, is_active: true });
  expect(send).toHaveBeenCalledTimes(1);
  expect(USER.is_active).toBe(false);
});
