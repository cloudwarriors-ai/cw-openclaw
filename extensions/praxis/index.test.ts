import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

function mockResponse(opts: { ok: boolean; status: number; body: unknown }): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    headers: {
      get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => opts.body,
    text: async () => JSON.stringify(opts.body),
  } as unknown as Response;
}

function buildTools(): { tools: Record<string, ToolDef>; opts: Record<string, unknown>[] } {
  const tools: Record<string, ToolDef> = {};
  const opts: Record<string, unknown>[] = [];
  const api = {
    registerTool: (factory: () => ToolDef, opt?: unknown) => {
      const t = factory();
      tools[t.name] = t;
      opts.push((opt ?? {}) as Record<string, unknown>);
    },
  } as never;
  plugin.register(api);
  return { tools, opts };
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("PRAXIS_API_TOKEN", "test-token");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("praxis plugin registration", () => {
  it("registers all five read tools", () => {
    const { tools } = buildTools();
    expect(Object.keys(tools).toSorted()).toEqual([
      "praxis_diagnose_issue",
      "praxis_get_issue",
      "praxis_health",
      "praxis_list_events",
      "praxis_list_issues",
    ]);
  });

  it("registers every tool as optional so per-agent allowlists scope them", () => {
    const { opts } = buildTools();
    expect(opts).toHaveLength(5);
    expect(opts.every((o) => o.optional === true)).toBe(true);
  });
});

describe("praxis tool handlers", () => {
  it("praxis_diagnose_issue returns the redacted diagnosis body", async () => {
    const diagnosis = { id: 5, state: "blocked", fuses: { resolver: { at_cap: true } } };
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: diagnosis }));

    const { tools } = buildTools();
    const out = parse(await tools.praxis_diagnose_issue.execute("call-1", { issue_id: 5 }));

    expect(out).toEqual(diagnosis);
    expect(fetchMock.mock.calls[0][0]).toBe("http://praxis:8000/api/v1/issues/5/diagnose");
  });

  it("praxis_list_issues forwards repo + state filters into the query", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: true, status: 200, body: { issues: [] } }));

    const { tools } = buildTools();
    await tools.praxis_list_issues.execute("call-2", {
      repo: "cloudwarriors-ai/scopely",
      state: "blocked",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://praxis:8000/api/v1/issues?repo=cloudwarriors-ai%2Fscopely&state=blocked",
    );
  });

  it("returns a normalized error result on a non-2xx response (no throw)", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 404, body: { detail: "x" } }));

    const { tools } = buildTools();
    const out = parse(await tools.praxis_get_issue.execute("call-3", { issue_id: 999 }));

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Praxis API 404/);
  });
});
