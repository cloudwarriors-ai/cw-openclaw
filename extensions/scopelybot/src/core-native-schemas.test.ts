// Registered model schemas -> strict raw preparation -> public host validation ->
// native staging. Staging is mocked; native permission/ownership is backend proof.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const stage = vi.hoisted(() => vi.fn());
vi.mock("./ops-write-client.js", () => ({ opsStageWrite: stage }));
import { applyCapabilityRegistry } from "./capability-registry.js";
import { registerDeploymentConfigTools } from "./deployment-config-tools.js";
import { registerPricingTools } from "./pricing-tools.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";
import { registerScopingCardTools } from "./scoping-card-tools.js";
import { registerVendorConfigTools } from "./vendor-config-tools.js";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};
type Tool = {
  name: string;
  parameters: Schema;
  prepareArguments?: (args: unknown) => unknown;
  execute: (id: string, args: Record<string, unknown>) => Promise<unknown>;
};
const BASE = { vendor_key: "ops-test-canary", project_type: "rudy-a" };
const CASES = [
  [
    "scopely_create_pricing_item",
    "pricing.items.create",
    { vendor_key: BASE.vendor_key, pricing_key: "uat_seat", unit_price: "10.00" },
  ],
  [
    "scopely_update_pricing_item",
    "pricing.items.update",
    { vendor_key: BASE.vendor_key, pricing_key: "uat_seat", unit_price: "15.00" },
  ],
  [
    "scopely_create_scoping_card",
    "catalog.scoping_cards.create",
    { ...BASE, key: "uat_card", title: "UAT" },
  ],
  [
    "scopely_update_scoping_card",
    "catalog.scoping_cards.update",
    { ...BASE, card_key: "uat_card", title: "UAT changed" },
  ],
  [
    "scopely_delete_scoping_card",
    "catalog.scoping_cards.delete",
    { ...BASE, card_key: "uat_card" },
  ],
  ["scopely_update_project_type", "catalog.project_types.update", { ...BASE, label: "Rudy UAT A" }],
  [
    "scopely_update_deployment_type",
    "catalog.deployment_types.update",
    { ...BASE, deployment_type: "copilot", description: "Rudy UAT validated" },
  ],
] as const;
let workspace: string;
function tools() {
  const out = new Map<string, Tool>();
  const api = {
    registerTool(factory: unknown) {
      const wrapped = applyCapabilityRegistry(factory as never) as (ctx: unknown) => Tool;
      const tool = wrapped({
        agentId: "scopelybot",
        sessionKey: "agent:scopelybot:zoom:channel:native-test",
      });
      out.set(tool.name, tool);
    },
  };
  for (const register of [
    registerPricingTools,
    registerScopingCardTools,
    registerVendorConfigTools,
    registerDeploymentConfigTools,
  ]) {
    register(api as never, vi.fn());
  }
  return out;
}
function prepare(tool: Tool, args: unknown) {
  const normalized = { ...tool, parameters: structuredClone(tool.parameters) };
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return validateToolArguments(normalized as never, {
    type: "toolCall",
    id: "native",
    name: tool.name,
    arguments: prepared as Record<string, unknown>,
  }) as Record<string, unknown>;
}
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "native-core-schemas-"));
  vi.stubEnv("OPENCLAW_WORKSPACE", workspace);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "native-test");
  fs.writeFileSync(
    path.join(workspace, "scopelybot-backend.json"),
    JSON.stringify({
      env: "local",
      mode: "read-write",
      baseUrl: "http://127.0.0.1:8100",
      allowedHosts: ["127.0.0.1:8100"],
      authMode: "service-token",
    }),
  );
  resetScopelyGuardForTest();
  stage.mockReset();
  stage.mockResolvedValue({ content: [{ type: "text", text: '{"staged":true}' }] });
});
afterEach(() => {
  resetScopelyGuardForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});
it.each(CASES)(
  "%s accepts native key selectors through the host and forwards exactly",
  async (name, capability, base) => {
    const tool = tools().get(name)!;
    expect(tool.prepareArguments).toBeTypeOf("function");
    const args = structuredClone(base);
    const validated = prepare(tool, args);
    expect(validated).toEqual(args);
    await tool.execute("native", validated);
    expect(stage).toHaveBeenCalledExactlyOnceWith(capability, args);
  },
);
it.each(CASES)(
  "%s refuses malformed raw calls and known property coercion",
  (name, _capability, base) => {
    const tool = tools().get(name)!;
    for (const args of [null, undefined, [], "{}", false, 0]) {
      expect(() => tool.prepareArguments?.(args)).toThrow();
    }
    const wrong: Record<string, unknown[]> = {
      string: [null, true, 0, [], {}],
      boolean: [null, "false", 0, [], {}],
      integer: [null, "1", false, 1.5, Number.NaN, Infinity, -Infinity, [], {}],
      array: [null, "", false, 0, {}],
      object: [null, [], "", false, 0],
    };
    for (const [field, schema] of Object.entries(tool.parameters.properties!)) {
      const invalid = [...(wrong[schema.type ?? ""] ?? [])];
      if (schema.minimum !== undefined) {
        invalid.push(schema.minimum - 1);
      }
      if (schema.maximum !== undefined) {
        invalid.push(schema.maximum + 1);
      }
      if (schema.minLength) {
        invalid.push("");
      }
      if (schema.maxLength) {
        invalid.push("x".repeat(schema.maxLength + 1));
      }
      for (const value of invalid) {
        expect(
          () => prepare(tool, { ...base, [field]: value }),
          `${name}.${field}=${String(value)}`,
        ).toThrow();
      }
    }
    expect(stage).not.toHaveBeenCalled();
  },
);
it.each(CASES)(
  "%s preserves unknown/obsolete fields for audited backend refusal",
  async (name, capability, base) => {
    const tool = tools().get(name)!;
    const args = { ...base, project_type_id: 0, legacy_unknown: null };
    const validated = prepare(tool, args);
    expect(validated).toEqual(args);
    await tool.execute("native", validated);
    expect(stage).toHaveBeenCalledExactlyOnceWith(capability, args);
  },
);
it.each([
  ["scopely_create_scoping_card", ["project_type_id", "visibility_condition"]],
  ["scopely_update_scoping_card", ["project_type_id", "card_id", "key", "visibility_condition"]],
  ["scopely_delete_scoping_card", ["project_type_id", "card_id"]],
  ["scopely_update_project_type", ["project_type_id", "key", "scope_category", "catalog_seeded"]],
  ["scopely_update_deployment_type", ["project_type_id", "id", "key", "is_active"]],
] as const)("%s stops advertising the observed invalid UAT arguments", (name, unsupported) => {
  const schema = tools().get(name)!.parameters;
  expect(schema.required).toContain("project_type");
  for (const key of unsupported) {
    expect(schema.properties).not.toHaveProperty(key);
  }
});
it("native read keys supply all selectors for the three failed UAT operations", () => {
  // Synthetic fixture values verified by parent; transcript *** redaction alone
  // is not wire evidence. No invented numeric IDs are necessary.
  const read = {
    vendor_key: "ops-test-canary",
    project_type: "rudy-a",
    cards: [{ key: "uat_card" }],
    deployments: [{ key: "copilot" }],
  };
  const built = tools();
  const selectors = { vendor_key: read.vendor_key, project_type: read.project_type };
  for (const [name, args] of [
    ["scopely_delete_scoping_card", { ...selectors, card_key: read.cards[0].key }],
    ["scopely_update_project_type", { ...selectors, label: "Rudy UAT A" }],
    [
      "scopely_update_deployment_type",
      { ...selectors, deployment_type: read.deployments[0].key, description: "Rudy UAT validated" },
    ],
  ] as const) {
    expect(prepare(built.get(name)!, args)).toEqual(args);
  }
});
it("card replacement preserves nested unknown fields for native rejection", async () => {
  const tool = tools().get("scopely_update_scoping_card")!;
  const args = {
    ...BASE,
    card_key: "uat_card",
    fields: [
      {
        key: "q",
        label: "Q",
        field_type: "select",
        hidden_metadata: null,
        options: [{ value: "a", label: "A", unknown_option: true }],
      },
    ],
  };
  const original = structuredClone(args);
  const validated = prepare(tool, args);
  expect(args).toEqual(original);
  expect(validated).toEqual(original);
  await tool.execute("nested", validated);
  expect(stage).toHaveBeenCalledExactlyOnceWith("catalog.scoping_cards.update", original);
});
it("card replacement rejects nested coercion and collection boundaries before staging", () => {
  const tool = tools().get("scopely_update_scoping_card")!;
  const field = { key: "q", label: "Q", field_type: "number" };
  const args = { ...BASE, card_key: "uat_card", fields: [field] };
  for (const [key, invalid] of Object.entries({
    is_required: [null, "false", 0],
    is_offered: [null, "true", 1],
    sort_order: [-1, 1.5, "1", 2147483648],
    min_value: [null, "1", Number.NaN, Infinity],
    max_value: [null, "1", Number.NaN, Infinity],
    default_value: [null, "1", Number.NaN, Infinity],
    field_type: [null, "unknown"],
    options: [null, {}, ""],
  })) {
    for (const value of invalid) {
      expect(() => prepare(tool, { ...args, fields: [{ ...field, [key]: value }] })).toThrow();
    }
  }
  for (const fields of [
    Array.from({ length: 51 }, () => field),
    [{ ...field, options: Array.from({ length: 26 }, () => ({ value: "a", label: "A" })) }],
  ]) {
    expect(() => prepare(tool, { ...args, fields })).toThrow();
  }
  for (const visibility of [
    { copilot: null },
    { copilot: true },
    { copilot: "unsupported" },
    Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`d${i}`, "yes"])),
  ]) {
    expect(() => prepare(tool, { ...args, visibility })).toThrow();
  }
  expect(stage).not.toHaveBeenCalled();
});
it.each(["scopely_create_pricing_item", "scopely_update_pricing_item"])(
  "%s enforces money and collection constraints before host coercion",
  (name) => {
    const tool = tools().get(name)!;
    const args = { vendor_key: BASE.vendor_key, pricing_key: "seat", unit_price: "15.00" };
    for (const value of [
      15,
      null,
      false,
      "15.001",
      "NaN",
      "Infinity",
      "10000000000.00",
      " 15",
      "15 ",
    ]) {
      expect(() => prepare(tool, { ...args, unit_price: value })).toThrow();
    }
    for (const value of ["0", "-9999999999.99", "9999999999.99", "15.00"]) {
      expect(prepare(tool, { ...args, unit_price: value }).unit_price).toBe(value);
    }
    for (const deployment_types of [
      [""],
      ["a", "a"],
      Array.from({ length: 51 }, (_, i) => `d${i}`),
    ]) {
      expect(() => prepare(tool, { ...args, deployment_types })).toThrow();
    }
    for (const unit_price_by_deployment of [
      { copilot: null },
      { copilot: 1 },
      { copilot: "1.001" },
      Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`d${i}`, "1"])),
    ]) {
      expect(() => prepare(tool, { ...args, unit_price_by_deployment })).toThrow();
    }
    expect(() => prepare(tool, { ...args, is_active: false })).toThrow();
    expect(stage).not.toHaveBeenCalled();
  },
);
