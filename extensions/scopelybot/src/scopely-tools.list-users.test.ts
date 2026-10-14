// Native VIP/ZW owns AND search semantics. Forward one complete query; never
// broaden a miss into legacy per-token OR searches or retry a failed read.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, nativeRead } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  nativeRead: vi.fn(),
}));
vi.mock("./ops-client.js", () => ({ opsRead: nativeRead }));
vi.mock("./scopely-api.js", () => ({
  scopelyFetch: (...args: unknown[]) => fetchMock(...args),
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
  buildQuery: (params: Record<string, unknown>, keys: string[]) => {
    const qs = new URLSearchParams();
    for (const k of keys) {
      if (params[k] !== undefined) {
        qs.set(k, String(params[k]));
      }
    }
    const s = qs.toString();
    return s ? `?${s}` : "";
  },
}));

import { registerScopelyTools } from "./scopely-tools.js";

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
  registerScopelyTools(api, noopLogger as never);
  return tools;
}
const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);

describe("scopely_list_users", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    nativeRead.mockReset();
  });

  it.each([
    { search: "Jamie Jamison" },
    { search: "nomatch" },
    { search: "  Jamie   Jamison  ", is_active: false, offset: 25 },
    { organization_id: 42, limit: 10, ordering: "-last_login" },
    {},
  ])("forwards the complete native query exactly once: %j", async (query) => {
    const expected = { ok: true, data: { items: [], total: 0, next_offset: null } };
    nativeRead.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(expected) }] });
    const tools = buildTools();
    expect(parse(await tools.scopely_list_users.execute("id", query))).toEqual(expected);
    expect(nativeRead).toHaveBeenCalledExactlyOnceWith("id", query);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves native pagination and IDs without merging or reordering rows", async () => {
    const expected = {
      ok: true,
      data: {
        items: [{ id: 47, email: "jamie@example.invalid" }],
        total: 2,
        next_offset: 1,
        truncated: true,
      },
    };
    nativeRead.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(expected) }] });
    const tools = buildTools();
    expect(
      parse(await tools.scopely_list_users.execute("id", { search: "Jamie Jamison" })),
    ).toEqual(expected);
    expect(nativeRead).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a native refusal without retrying or falling back", async () => {
    const expected = { ok: false, error: "requester_not_authorized" };
    nativeRead.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(expected) }] });
    const tools = buildTools();
    expect(
      parse(await tools.scopely_list_users.execute("id", { search: "Jamie Jamison" })),
    ).toEqual(expected);
    expect(nativeRead).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
