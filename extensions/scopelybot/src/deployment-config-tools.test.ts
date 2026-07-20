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
import { registerDeploymentConfigTools } from "./deployment-config-tools.js";

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
  registerDeploymentConfigTools(api, noopLogger as never);
  return tools;
}
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const CHANNEL = "vipbot@conference.xmpp.zoom.us";
// codeOf(await stage(...)): the tool result is code-free by design; the code is
// read from the channel delivery spy (sendScopelyText prompt, arg index 1).
const codeOf = (_res: { content: { text: string }[] }) =>
  String(sendScopelyTextMock.mock.calls.at(-1)?.[1] ?? "").match(/CONFIRM (\d{4})/)?.[1];

const WRITE_ARGS: Record<string, Record<string, unknown>> = {
  scopely_create_deployment_type: {
    vendor_key: "zoom",
    project_type_id: 4,
    key: "autopilot",
    label: "Autopilot",
  },
  scopely_update_deployment_type: {
    vendor_key: "zoom",
    project_type_id: 4,
    id: 8,
    label: "AutoPilot",
  },
  scopely_delete_deployment_type: { vendor_key: "zoom", project_type_id: 4, id: 8 },
  scopely_create_deployment_type_template: { key: "autopilot", label: "Autopilot" },
  scopely_update_deployment_type_template: { id: 2, sort_order: 5 },
  scopely_delete_deployment_type_template: { id: 2 },
};

describe("deployment-config-tools", () => {
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
    await t.scopely_list_deployment_types.execute("x", { vendor_key: "zoom", project_type_id: 4 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/vendors/zoom/project-types/4/deployment-types/",
    );
    await t.scopely_list_deployment_type_templates.execute("x", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/deployment-type-templates/");
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

  it("deployment-type writes confirm to the nested path with path params excluded from body", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_create_deployment_type.execute("x", {
        vendor_key: "zoom",
        project_type_id: 4,
        key: "autopilot",
        label: "Autopilot",
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
    expect(path).toBe("/api/admin/vendors/zoom/project-types/4/deployment-types/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ key: "autopilot", label: "Autopilot" });
  });

  it("template update PATCHes only supplied fields", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_update_deployment_type_template.execute("x", { id: 3, sort_order: 9 }),
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
    expect(path).toBe("/api/admin/deployment-type-templates/3/");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ sort_order: 9 });
  });

  it("registers all 8 deployment-config tools", () => {
    const t = buildTools();
    expect(Object.keys(t)).toHaveLength(8);
  });
});
