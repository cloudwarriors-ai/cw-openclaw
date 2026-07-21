import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("./scopely-api.js", () => ({
  scopelyFetch: (...args: unknown[]) => fetchMock(...args),
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
  buildQuery: () => "",
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

import { tryExecuteConfirm } from "./confirm.js";
import { registerVendorConfigTools } from "./vendor-config-tools.js";

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
  registerVendorConfigTools(api, noopLogger as never);
  return tools;
}
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const CHANNEL = "vipbot@conference.xmpp.zoom.us";
// codeOf(await stage(...)): the tool result is code-free by design; the code is
// read from the channel delivery spy (sendScopelyText prompt, arg index 1).
const codeOf = (_res: { content: { text: string }[] }) =>
  String(sendScopelyTextMock.mock.calls.at(-1)?.[1] ?? "").match(/CONFIRM (\d{4})/)?.[1];

const WRITE_ARGS: Record<string, Record<string, unknown>> = {
  scopely_create_vendor: { key: "dialpad", display_name: "Dialpad" },
  scopely_update_vendor: { vendor_key: "dialpad", status: "inactive" },
  scopely_delete_vendor: { vendor_key: "dialpad" },
  scopely_create_project_type: { vendor_key: "zoom", key: "ucaas", label: "UCaaS" },
  scopely_update_project_type: { vendor_key: "zoom", project_type_id: 4, enabled: true },
  scopely_delete_project_type: { vendor_key: "zoom", project_type_id: 4 },
  scopely_create_vendor_term: {
    vendor_key: "zoom",
    scope: "field",
    key: "seats",
    label: "Licenses",
  },
  scopely_update_vendor_term: { vendor_key: "zoom", term_id: 2, label: "Users" },
  scopely_delete_vendor_term: { vendor_key: "zoom", term_id: 2 },
};

describe("vendor-config-tools", () => {
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
    await t.scopely_list_vendors.execute("x", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/vendors/");
    await t.scopely_get_vendor.execute("x", { vendor_key: "zoom" });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/vendors/zoom/");
    await t.scopely_list_project_types.execute("x", { vendor_key: "zoom" });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/vendors/zoom/project-types/");
    await t.scopely_list_vendor_terms.execute("x", { vendor_key: "zoom" });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/vendors/zoom/terms/");
  });

  // Core safety guarantee: every write stages, none touch prod during execute().
  it("ALL write tools STAGE only — execute() never calls scopelyFetch", async () => {
    const t = buildTools();
    for (const [name, args] of Object.entries(WRITE_ARGS)) {
      const res = parse(await t[name].execute("x", args));
      expect(res.staged, `${name} must stage`).toBe(true);
    }
    expect(fetchMock, "no write tool may call scopelyFetch before CONFIRM").not.toHaveBeenCalled();
  });

  it("create_vendor confirms to POST /api/admin/vendors/", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_create_vendor.execute("x", {
        key: "dialpad",
        display_name: "Dialpad",
        is_source: true,
      }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      approverIds: ["t"],
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/admin/vendors/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({
      key: "dialpad",
      display_name: "Dialpad",
      is_source: true,
    });
  });

  it("update_vendor PATCHes by vendor key with only supplied fields", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_update_vendor.execute("x", { vendor_key: "zoom", status: "inactive" }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      approverIds: ["t"],
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/admin/vendors/zoom/");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ status: "inactive" });
    // vendor_key is a path param, never a body field
    expect(JSON.parse(opts.body)).not.toHaveProperty("vendor_key");
  });

  it("project-type writes target the nested vendor path", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_create_project_type.execute("x", {
        vendor_key: "zoom",
        key: "ucaas",
        label: "UCaaS",
      }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      approverIds: ["t"],
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/vendors/zoom/project-types/",
      expect.objectContaining({ method: "POST" }),
    );

    const delCode = codeOf(
      await t.scopely_delete_project_type.execute("x", { vendor_key: "zoom", project_type_id: 4 }),
    );
    await tryExecuteConfirm({
      text: `CONFIRM ${delCode}`,
      actor: "t",
      approverIds: ["t"],
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/vendors/zoom/project-types/4/",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("vendor-term writes target the nested terms path", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_create_vendor_term.execute("x", {
        vendor_key: "zoom",
        scope: "field",
        key: "seats",
        label: "Licenses",
      }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      approverIds: ["t"],
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/admin/vendors/zoom/terms/");
    expect(JSON.parse(opts.body)).toEqual({ scope: "field", key: "seats", label: "Licenses" });
  });

  it("registers all 13 vendor-config tools", () => {
    const t = buildTools();
    expect(Object.keys(t)).toHaveLength(13);
  });
});
