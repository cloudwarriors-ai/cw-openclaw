// Tests for the health pair in scopely-tools.ts (Slice 2): the shared
// healthUrl derivation (API host, SCOPELY_HEALTH_URL override) and the new
// scopely_component_health tool. Scoped to the tools touched by the Slice 2
// change — the legacy read tools in this module predate the test discipline
// and are not retro-tested here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerScopelyTools } from "./scopely-tools.js";

type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

function buildTools() {
  const tools: Record<string, Tool> = {};
  const api = {
    registerTool: (factory: () => Tool) => {
      const tool = factory();
      tools[tool.name] = tool;
    },
  } as never;
  registerScopelyTools(api, (() => {}) as never);
  return tools;
}

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ status: "ok" }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SCOPELY_HEALTH_URL;
  delete process.env.SCOPELY_BASE_URL;
});

describe("health tools", () => {
  it("health_check hits the API host /health/ derived from the frontend base", async () => {
    process.env.SCOPELY_BASE_URL = "https://vip.pscx.ai";
    await buildTools().scopely_health_check.execute("x", {});
    expect(fetchMock).toHaveBeenCalledWith("https://api.vip.pscx.ai/health/");
  });

  it("component_health hits /health/components/ on the same base", async () => {
    process.env.SCOPELY_BASE_URL = "https://vip.pscx.ai";
    const result = parse(await buildTools().scopely_component_health.execute("x", {}));
    expect(fetchMock).toHaveBeenCalledWith("https://api.vip.pscx.ai/health/components/");
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ status: "ok" });
  });

  it("SCOPELY_HEALTH_URL override moves BOTH endpoints together", async () => {
    process.env.SCOPELY_HEALTH_URL = "https://dev.api.vip.pscx.ai/health/";
    const tools = buildTools();
    await tools.scopely_health_check.execute("x", {});
    await tools.scopely_component_health.execute("x", {});
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://dev.api.vip.pscx.ai/health/");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://dev.api.vip.pscx.ai/health/components/");
  });

  it("component_health surfaces a degraded rollup verbatim", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        status: "degraded",
        components: [{ name: "docusign", status: "degraded", reason: "token refresh failing" }],
      }),
    });
    const result = parse(await buildTools().scopely_component_health.execute("x", {}));
    expect(result.data.status).toBe("degraded");
    expect(result.data.components[0].name).toBe("docusign");
  });
});
