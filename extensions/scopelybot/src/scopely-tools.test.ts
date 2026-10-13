// Tests for the health pair in scopely-tools.ts. PK-7a moved them off a bare
// fetch() to an env-derived API host and onto the guarded scopelyFetch: the
// host is the live backend profile's (prod: api.vip.pscx.ai) and the path is
// the new app's GET /api/v1/health/ — the only app request M1 makes. The
// legacy read tools in this module predate the test discipline and are not
// retro-tested here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { correlatedId } from "./audit.test-helpers.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";
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
let workspace: string;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function writeProfile(body: Record<string, unknown>) {
  fs.writeFileSync(path.join(workspace, "scopelybot-backend.json"), JSON.stringify(body));
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scopely-tools-"));
  process.env.OPENCLAW_WORKSPACE = workspace;
  writeProfile({
    env: "prod",
    baseUrl: "https://api.vip.pscx.ai",
    allowedHosts: ["api.vip.pscx.ai"],
  });
  resetScopelyGuardForTest();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () => jsonResponse(200, { status: "ok" }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCLAW_WORKSPACE;
  delete process.env.SCOPELY_HEALTH_URL;
  delete process.env.SCOPELY_BASE_URL;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("health tools", () => {
  it("health_check GETs /api/v1/health/ on the prod profile's API host through the guard", async () => {
    const result = parse(await buildTools().scopely_health_check.execute("x", {}));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    correlatedId(fetchMock.mock.calls[0][0], "https://api.vip.pscx.ai/api/v1/health/");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(result).toEqual({ ok: true, status: 200, data: { status: "ok" } });
  });

  it("ignores the legacy env overrides (no env fallback for the host)", async () => {
    process.env.SCOPELY_BASE_URL = "https://vip.pscx.ai";
    process.env.SCOPELY_HEALTH_URL = "https://dev.api.vip.pscx.ai/health/";
    await buildTools().scopely_health_check.execute("x", {});
    correlatedId(fetchMock.mock.calls[0][0], "https://api.vip.pscx.ai/api/v1/health/");
  });

  it("without a valid profile the health check makes no request and reports the refusal", async () => {
    fs.rmSync(path.join(workspace, "scopelybot-backend.json"));
    const result = parse(await buildTools().scopely_health_check.execute("x", {}));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no valid backend profile/);
  });

  it("surfaces a degraded health body verbatim", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { status: "degraded", database: "down" }));
    const result = parse(await buildTools().scopely_health_check.execute("x", {}));
    expect(result).toEqual({
      ok: false,
      status: 503,
      data: { status: "degraded", database: "down" },
    });
  });

  it("echoes at most about 1 KB of a non-JSON health body (e.g. a Django debug page)", async () => {
    const page = `<html>${"x".repeat(80 * 1024)}</html>`;
    fetchMock.mockResolvedValueOnce(
      new Response(page, { status: 500, headers: { "content-type": "text/html" } }),
    );
    const result = parse(await buildTools().scopely_health_check.execute("x", {}));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(result.data).toBe(`${page.slice(0, 1024)}...[truncated]`);
  });

  it("reports a 200 whose body was cut at 64 KB as not ok, never as a healthy answer", async () => {
    const body = JSON.stringify({ status: "ok", pad: "x".repeat(80 * 1024) });
    fetchMock.mockResolvedValueOnce(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const result = parse(await buildTools().scopely_health_check.execute("x", {}));
    expect(result).toEqual({
      ok: false,
      status: 200,
      data: `${body.slice(0, 1024)}...[truncated]`,
    });
  });
});
