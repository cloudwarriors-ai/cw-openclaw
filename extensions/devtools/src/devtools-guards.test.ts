import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devtoolsFetch } from "./api-client.js";
import { assertReadOnlySql, registerTools } from "./tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerTools(api);
  return tools;
}

const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);

const fetchMock = vi.fn();

describe("devtools env contract (fail-closed)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.DEVTOOLS_API_URL;
    delete process.env.DEV_TOOLS_API;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEVTOOLS_API_URL;
    delete process.env.DEV_TOOLS_API;
  });

  it("refuses to call out when DEVTOOLS_API_URL is unset (no baked-in prod URL)", async () => {
    process.env.DEV_TOOLS_API = "tok";
    const res = await devtoolsFetch("/api/v1/containers");
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res.data)).toContain("DEVTOOLS_API_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to call out when DEV_TOOLS_API token is unset", async () => {
    process.env.DEVTOOLS_API_URL = "http://devtools-api:9100";
    const res = await devtoolsFetch("/api/v1/containers");
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res.data)).toContain("DEV_TOOLS_API");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the bearer token to the configured base when both are set", async () => {
    process.env.DEVTOOLS_API_URL = "http://devtools-api:9100";
    process.env.DEV_TOOLS_API = "tok";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ fine: true }),
    });
    const res = await devtoolsFetch("/api/v1/containers");
    expect(res.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://devtools-api:9100/api/v1/containers");
    expect(opts.headers.Authorization).toBe("Bearer tok");
  });
});

describe("assertReadOnlySql", () => {
  it("allows SELECT and WITH (tolerating one trailing semicolon)", () => {
    expect(assertReadOnlySql("SELECT * FROM users")).toBeUndefined();
    expect(assertReadOnlySql("  with x as (select 1) select * from x;  ")).toBeUndefined();
  });

  it("rejects non-read statements", () => {
    for (const sql of [
      "UPDATE users SET role='admin'",
      "DELETE FROM users",
      "INSERT INTO users VALUES (1)",
      "DROP TABLE users",
      "selecting", // word-boundary check: not a SELECT
    ]) {
      expect(assertReadOnlySql(sql), sql).toBeDefined();
    }
  });

  it("rejects stacked statements", () => {
    expect(assertReadOnlySql("SELECT 1; DROP TABLE users")).toBeDefined();
  });
});

describe("devtools_db_query client-side guard", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEVTOOLS_API_URL = "http://devtools-api:9100";
    process.env.DEV_TOOLS_API = "tok";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEVTOOLS_API_URL;
    delete process.env.DEV_TOOLS_API;
  });

  it("returns an error for a mutating statement WITHOUT forwarding it", async () => {
    const t = buildTools();
    const res = parse(await t.devtools_db_query.execute("x", { sql: "DROP TABLE users" }));
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a SELECT to the query endpoint", async () => {
    const t = buildTools();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ rows: [] }),
    });
    const res = parse(await t.devtools_db_query.execute("x", { sql: "SELECT 1" }));
    expect(res.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v1/db/query");
  });
});
