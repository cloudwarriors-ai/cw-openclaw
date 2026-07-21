// Tests for scopely_activity_log (Slice 2): user activity stream reads with
// filter discovery. Scoped to the tool added by the Slice 2 change — the
// legacy admin read tools in this module predate the test discipline and are
// not retro-tested here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const scopelyFetchMock = vi.fn();
vi.mock("./scopely-api.js", async () => {
  const actual = await vi.importActual<typeof import("./scopely-api.js")>("./scopely-api.js");
  return { ...actual, scopelyFetch: (...args: unknown[]) => scopelyFetchMock(...args) };
});

import { registerAdminTools } from "./admin-tools.js";

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
  registerAdminTools(api, (() => {}) as never);
  return tools;
}

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("scopely_activity_log", () => {
  beforeEach(() => {
    scopelyFetchMock.mockReset();
    scopelyFetchMock.mockResolvedValue({ ok: true, status: 200, data: [] });
  });

  it("queries the activity endpoint with scalar filters", async () => {
    await buildTools().scopely_activity_log.execute("x", {
      user: 43,
      level: "warning",
      since: "2026-07-20T00:00:00Z",
      limit: 100,
    });
    const url = String(scopelyFetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/admin/activity/?");
    expect(url).toContain("user=43");
    expect(url).toContain("level=warning");
    expect(url).toContain("limit=100");
    expect(url).toContain("since=2026-07-20T00%3A00%3A00Z");
  });

  it("appends repeated event params (buildQuery skips arrays)", async () => {
    await buildTools().scopely_activity_log.execute("x", {
      event: ["auth.login_success", "request.failed"],
      limit: 10,
    });
    const url = String(scopelyFetchMock.mock.calls[0][0]);
    expect(url).toContain("event=auth.login_success");
    expect(url).toContain("event=request.failed");
    expect(url).toContain("limit=10");
    expect(url.indexOf("?")).toBe(url.lastIndexOf("?")); // exactly one ?
  });

  it("events-only call still forms a valid query string", async () => {
    await buildTools().scopely_activity_log.execute("x", { event: ["request.failed"] });
    expect(String(scopelyFetchMock.mock.calls[0][0])).toBe(
      "/api/admin/activity/?event=request.failed",
    );
  });

  it("discover_filters=true reads the filters endpoint instead of entries", async () => {
    scopelyFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { users: [{ id: 43 }], sessions: [] },
    });
    const result = parse(
      await buildTools().scopely_activity_log.execute("x", { discover_filters: true }),
    );
    expect(String(scopelyFetchMock.mock.calls[0][0])).toBe("/api/admin/activity/filters/");
    expect(result.data.users[0].id).toBe(43);
  });

  it("relays backend errors instead of fabricating data", async () => {
    scopelyFetchMock.mockResolvedValueOnce({ ok: false, status: 403, data: { detail: "nope" } });
    const result = parse(await buildTools().scopely_activity_log.execute("x", {}));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("HTTP 403");
  });
});
