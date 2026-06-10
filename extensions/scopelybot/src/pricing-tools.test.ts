import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("./scopely-api.js", () => ({
  scopelyFetch: (...args: unknown[]) => fetchMock(...args),
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
  buildQuery: (params: Record<string, unknown>, keys: string[]) => {
    const qs = new URLSearchParams();
    for (const k of keys) if (params[k] !== undefined) qs.set(k, String(params[k]));
    const s = qs.toString();
    return s ? `?${s}` : "";
  },
}));

// Staging delivers the CONFIRM prompt (with the code) to the channel via
// sendScopelyText — never through the tool result. Spy on the delivery.
const sendScopelyTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
}));

import { registerPricingTools } from "./pricing-tools.js";
import { tryExecuteConfirm } from "./user-maintenance-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};
const noopLogger = () => {};
function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerPricingTools(api, noopLogger as never);
  return tools;
}
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const CHANNEL = "vipbot@conference.xmpp.zoom.us";
// codeOf(await stage(...)): the tool result is code-free by design; the code is
// read from the channel delivery spy (sendScopelyText prompt, arg index 1).
const codeOf = (_res: { content: { text: string }[] }) =>
  String(sendScopelyTextMock.mock.calls.at(-1)?.[1] ?? "").match(/CONFIRM (\d{4})/)?.[1];

const WRITE_TOOLS: Record<string, Record<string, unknown>> = {
  scopely_create_pricing_default: {
    scope_category: "ucaas",
    pricing_key: "k",
    display_name: "n",
    unit_price: "1.00",
    category: "c",
  },
  scopely_update_pricing_default: { id: 1, unit_price: "2.00" },
  scopely_delete_pricing_default: { id: 1 },
  scopely_create_pricing_item: {
    vendor_key: "zoom",
    project_type_id: 1,
    pricing_key: "k",
    display_name: "n",
    unit_price: "1.00",
    category: "c",
  },
  scopely_update_pricing_item: {
    vendor_key: "zoom",
    project_type_id: 1,
    id: 2,
    unit_price: "2.00",
  },
  scopely_delete_pricing_item: { vendor_key: "zoom", project_type_id: 1, id: 2 },
  scopely_create_currency: { code: "EUR", symbol: "€", name: "Euro" },
  scopely_update_currency: { id: 1, exchange_rate: "0.9" },
  scopely_delete_currency: { id: 1 },
  scopely_update_session_pricing_config: { additional_go_live_price: "2500.00" },
};

describe("pricing-tools", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sendScopelyTextMock.mockReset();
    process.env.SCOPELYBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
  });

  it("read tools hit the correct BFF paths immediately", async () => {
    const t = buildTools();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: [] });
    await t.scopely_list_pricing_defaults.execute("x", { scope_category: "ucaas" });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/pricing-defaults/?scope_category=ucaas");
    await t.scopely_get_pricing_default.execute("x", { id: 4 });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/pricing-defaults/4/");
    await t.scopely_list_pricing_items.execute("x", { vendor_key: "zoom", project_type_id: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/vendors/zoom/project-types/3/pricing-items/",
    );
    await t.scopely_list_currencies.execute("x", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/currencies/");
    await t.scopely_get_session_pricing_config.execute("x", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/session-pricing-config/");
  });

  // Core safety guarantee: every write stages, none touch prod during execute().
  it("ALL write tools STAGE only — execute() never calls scopelyFetch", async () => {
    const t = buildTools();
    for (const [name, args] of Object.entries(WRITE_TOOLS)) {
      const res = parse(await t[name].execute("x", args));
      expect(res.staged, `${name} must stage`).toBe(true);
    }
    expect(fetchMock, "no write tool may call scopelyFetch before CONFIRM").not.toHaveBeenCalled();
  });

  it("create_pricing_default confirms to POST with supplied fields", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_create_pricing_default.execute("x", {
        scope_category: "ucaas",
        pricing_key: "per_user",
        display_name: "Per User",
        unit_price: "15.00",
        category: "Base",
        deployment_types: ["autopilot"],
      }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/admin/pricing-defaults/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      scope_category: "ucaas",
      pricing_key: "per_user",
      display_name: "Per User",
      unit_price: "15.00",
      category: "Base",
      deployment_types: ["autopilot"],
    });
  });

  it("create_pricing_item confirms to the nested vendor/project-type path", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_create_pricing_item.execute("x", {
        vendor_key: "zoom",
        project_type_id: 7,
        pricing_key: "addon",
        display_name: "Addon",
        unit_price: "99.00",
        category: "Add-Ons",
      }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/admin/vendors/zoom/project-types/7/pricing-items/");
    expect(opts.method).toBe("POST");
    // project_type / vendor are path params, NOT body fields
    expect(JSON.parse(opts.body)).not.toHaveProperty("vendor_key");
    expect(JSON.parse(opts.body)).not.toHaveProperty("project_type_id");
  });

  it("update_pricing_item targets the nested item path and sends only changed fields", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_update_pricing_item.execute("x", {
        vendor_key: "zoom",
        project_type_id: 7,
        id: 42,
        unit_price: "120.00",
      }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/admin/vendors/zoom/project-types/7/pricing-items/42/");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ unit_price: "120.00" });
  });

  it("delete_currency confirms to DELETE", async () => {
    const t = buildTools();
    const code = codeOf(await t.scopely_delete_currency.execute("x", { id: 9 }));
    fetchMock.mockResolvedValue({ ok: true, status: 204, data: null });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/currencies/9/",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("registers all 15 pricing tools", () => {
    const t = buildTools();
    expect(Object.keys(t)).toHaveLength(15);
  });
});
