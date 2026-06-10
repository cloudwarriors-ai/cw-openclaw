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
import { registerScopingCardTools } from "./scoping-card-tools.js";

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
  registerScopingCardTools(api, noopLogger as never);
  return tools;
}
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const CHANNEL = "vipbot@conference.xmpp.zoom.us";
// codeOf(await stage(...)): the tool result is code-free by design; the code is
// read from the channel delivery spy (sendScopelyText prompt, arg index 1).
const codeOf = (_res: { content: { text: string }[] }) =>
  String(sendScopelyTextMock.mock.calls.at(-1)?.[1] ?? "").match(/CONFIRM (\d{4})/)?.[1];

describe("scoping-card-tools", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    sendScopelyTextMock.mockReset();
    process.env.SCOPELYBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
  });

  it("read tools hit the correct nested BFF paths immediately", async () => {
    const t = buildTools();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: [] });
    await t.scopely_list_scoping_cards.execute("x", { vendor_key: "zoom", project_type_id: 4 });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/vendors/zoom/project-types/4/cards/");
    await t.scopely_get_scoping_card.execute("x", {
      vendor_key: "zoom",
      project_type_id: 4,
      card_id: 11,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/vendors/zoom/project-types/4/cards/11/");
  });

  // Core safety guarantee: every write stages, none touch prod during execute().
  it("ALL write tools STAGE only — execute() never calls scopelyFetch", async () => {
    const t = buildTools();
    const writes: Record<string, Record<string, unknown>> = {
      scopely_create_scoping_card: { vendor_key: "zoom", project_type_id: 4, key: "k", title: "T" },
      scopely_update_scoping_card: {
        vendor_key: "zoom",
        project_type_id: 4,
        card_id: 11,
        title: "T2",
      },
      scopely_delete_scoping_card: { vendor_key: "zoom", project_type_id: 4, card_id: 11 },
    };
    for (const [name, args] of Object.entries(writes)) {
      const res = parse(await t[name].execute("x", args));
      expect(res.staged, `${name} must stage`).toBe(true);
    }
    expect(fetchMock, "no write tool may call scopelyFetch before CONFIRM").not.toHaveBeenCalled();
  });

  it("create card confirms to POST with nested fields/visibility preserved in body", async () => {
    const t = buildTools();
    const fields = [
      {
        key: "seat_count",
        label: "Seats",
        field_type: "number",
        pricing_key: "per_user",
        is_required: true,
        options: [{ value: "a", label: "A" }],
      },
    ];
    const visibility = { autopilot: "yes", bespoke: "skip" };
    const code = codeOf(
      await t.scopely_create_scoping_card.execute("x", {
        vendor_key: "zoom",
        project_type_id: 4,
        key: "seats",
        title: "Seat Count",
        fields,
        visibility,
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
    expect(path).toBe("/api/admin/vendors/zoom/project-types/4/cards/");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.fields).toEqual(fields);
    expect(body.visibility).toEqual(visibility);
    expect(body).not.toHaveProperty("vendor_key");
    expect(body).not.toHaveProperty("project_type_id");
  });

  it("update card flags full-set replacement in the confirm summary", async () => {
    const t = buildTools();
    const staged = parse(
      await t.scopely_update_scoping_card.execute("x", {
        vendor_key: "zoom",
        project_type_id: 4,
        card_id: 11,
        fields: [{ key: "a", label: "A", field_type: "boolean" }],
      }),
    );
    expect(staged.staged).toBe(true);
    // The replacement warning travels in the channel prompt, not the tool result.
    const prompt = String(sendScopelyTextMock.mock.calls.at(-1)?.[1] ?? "");
    expect(prompt).toContain("REPLACE fields (1 total)");
    const code = prompt.match(/CONFIRM (\d{4})/)?.[1];
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/admin/vendors/zoom/project-types/4/cards/11/",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("registers all 5 scoping-card tools", () => {
    const t = buildTools();
    expect(Object.keys(t)).toHaveLength(5);
  });
});
