// Verifies scopely_list_users' multi-term name-search retry: the backend OR-matches
// the *whole* search string per field (icontains), so a two-word "Josh Rickerd" never
// hits separate first_name/last_name columns. This tool must retry per token and union
// the results instead of reporting a false "no user found".
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
  });

  it("returns the whole-phrase match as-is when the backend finds one", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, data: [{ id: 1, email: "a@b.com" }] });
    const tools = buildTools();
    const res = parse(await tools.scopely_list_users.execute("id", { search: "unified-team" }));
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([{ id: 1, email: "a@b.com" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries per name token and unions results when the full phrase misses", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, data: [] }) // "Josh Rickerd" — no hit
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: [{ id: 47, email: "jrickert@unified-team.com", first_name: "" }],
      }) // "Josh" token
      .mockResolvedValueOnce({ ok: true, status: 200, data: [] }); // "Rickerd" token
    const tools = buildTools();
    const res = parse(await tools.scopely_list_users.execute("id", { search: "Josh Rickerd" }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([{ id: 47, email: "jrickert@unified-team.com", first_name: "" }]);
    expect(res.note).toMatch(/individual name terms/);
  });

  it("dedupes when multiple tokens match the same user", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, data: [] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: [{ id: 9, email: "j@x.com" }] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: [{ id: 9, email: "j@x.com" }] });
    const tools = buildTools();
    const res = parse(await tools.scopely_list_users.execute("id", { search: "Jamie Jamison" }));
    expect(res.data).toEqual([{ id: 9, email: "j@x.com" }]);
  });

  it("reports a genuine no-match when no token hits either", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, data: [] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: [] })
      .mockResolvedValueOnce({ ok: true, status: 200, data: [] });
    const tools = buildTools();
    const res = parse(await tools.scopely_list_users.execute("id", { search: "Nobody Here" }));
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([]);
    expect(res.note).toBeUndefined();
  });

  it("does not retry a single-token search", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, data: [] });
    const tools = buildTools();
    const res = parse(await tools.scopely_list_users.execute("id", { search: "nomatch" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual([]);
  });
});
