import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { registerOrgTools } from "./org-tools.js";
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
  registerOrgTools(api, noopLogger as never);
  return tools;
}
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const codeOf = (res: { content: { text: string }[] }) =>
  parse(res).message.match(/CONFIRM (\d{4})/)?.[1];

const READ_TOOLS = ["scopely_list_orgs", "scopely_get_org", "scopely_list_org_domains"];
const WRITE_TOOLS = [
  "scopely_create_org",
  "scopely_update_org",
  "scopely_delete_org",
  "scopely_add_org_domain",
  "scopely_remove_org_domain",
];

describe("org-tools", () => {
  beforeEach(() => fetchMock.mockReset());

  it("read tools hit the correct BFF paths immediately", async () => {
    const t = buildTools();
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: [] });
    await t.scopely_list_orgs.execute("x", {});
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/orgs/");
    await t.scopely_get_org.execute("x", { org_id: 5 });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/orgs/5/");
    await t.scopely_list_org_domains.execute("x", { org_id: 5 });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/orgs/5/domains/");
  });

  // The core safety guarantee: NO write tool touches prod during execute().
  it("write tools STAGE only — execute() never calls scopelyFetch", async () => {
    const t = buildTools();
    const args: Record<string, Record<string, unknown>> = {
      scopely_create_org: { name: "Acme", slug: "acme" },
      scopely_update_org: { org_id: 3, name: "New" },
      scopely_delete_org: { org_id: 3 },
      scopely_add_org_domain: { org_id: 3, domain: "Acme.com" },
      scopely_remove_org_domain: { org_id: 3, domain_id: 9 },
    };
    for (const name of WRITE_TOOLS) {
      const res = parse(await t[name].execute("x", args[name]));
      expect(res.staged, `${name} must stage`).toBe(true);
    }
    expect(fetchMock, "no write tool may call scopelyFetch before CONFIRM").not.toHaveBeenCalled();
  });

  it("create_org confirms to POST /api/auth/orgs/ with only supplied fields", async () => {
    const t = buildTools();
    const staged = await t.scopely_create_org.execute("x", {
      name: "Acme",
      slug: "acme",
      is_active: true,
    });
    const code = codeOf(staged);
    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: "",
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/auth/orgs/");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "Acme", slug: "acme", is_active: true });
  });

  it("update_org sends only supplied fields and rejects empty updates", async () => {
    const t = buildTools();
    const empty = parse(await t.scopely_update_org.execute("x", { org_id: 3 }));
    expect(empty.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const staged = await t.scopely_update_org.execute("x", { org_id: 3, slug: "new-slug" });
    const code = codeOf(staged);
    fetchMock.mockResolvedValue({ ok: true, status: 200, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: "",
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/auth/orgs/3/");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ slug: "new-slug" });
  });

  it("delete_org confirms to DELETE (soft-delete)", async () => {
    const t = buildTools();
    const code = codeOf(await t.scopely_delete_org.execute("x", { org_id: 7 }));
    fetchMock.mockResolvedValue({ ok: true, status: 204, data: null });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: "",
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/orgs/7/",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("add_org_domain lowercases the domain and confirms to POST", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_add_org_domain.execute("x", { org_id: 7, domain: "Acme.COM" }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 201, data: {} });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: "",
      logger: noopLogger as never,
    });
    const [path, opts] = fetchMock.mock.calls.at(-1)!;
    expect(path).toBe("/api/auth/orgs/7/domains/");
    expect(JSON.parse(opts.body)).toEqual({ domain: "acme.com" });
  });

  it("remove_org_domain confirms to DELETE the nested domain path", async () => {
    const t = buildTools();
    const code = codeOf(
      await t.scopely_remove_org_domain.execute("x", { org_id: 7, domain_id: 12 }),
    );
    fetchMock.mockResolvedValue({ ok: true, status: 204, data: null });
    await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      conversationId: "",
      logger: noopLogger as never,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/orgs/7/domains/12/",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("registers exactly the expected read + write tools", () => {
    const t = buildTools();
    expect(Object.keys(t).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
  });
});
