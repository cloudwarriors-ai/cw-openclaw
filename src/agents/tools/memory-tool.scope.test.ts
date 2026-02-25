import { beforeEach, describe, expect, it, vi } from "vitest";

let searchCalledWith: Record<string, unknown> | undefined;
let searchCallHistory: Array<Record<string, unknown> | undefined> = [];
const mockSessionStoreRef = vi.hoisted(() => ({
  value: {} as Record<string, Record<string, unknown>>,
}));

const stubManager = {
  search: vi.fn(async (_query: string, opts?: Record<string, unknown>) => {
    searchCalledWith = opts;
    searchCallHistory.push(opts);
    return [
      {
        path: "memory/customers/acme/notes.md",
        startLine: 1,
        endLine: 3,
        score: 0.85,
        snippet: "Acme uses 500 users on Teams",
        source: "memory" as const,
      },
    ];
  }),
  readFile: vi.fn(),
  status: () => ({
    backend: "builtin" as const,
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    dbPath: "/workspace/.memory/index.sqlite",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: async () => ({ manager: stubManager }),
}));

vi.mock("../../config/sessions/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/paths.js")>(
    "../../config/sessions/paths.js",
  );
  return {
    ...actual,
    resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  };
});

vi.mock("../../config/sessions/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/store.js")>(
    "../../config/sessions/store.js",
  );
  return {
    ...actual,
    loadSessionStore: vi.fn(() => mockSessionStoreRef.value),
  };
});

import { createMemorySearchTool } from "./memory-tool.js";

const baseCfg = { memory: { citations: "off" }, agents: { list: [{ id: "main", default: true }] } };

beforeEach(() => {
  vi.clearAllMocks();
  searchCalledWith = undefined;
  searchCallHistory = [];
  mockSessionStoreRef.value = {};
});

describe("memory_search scope policy", () => {
  it("defaults to global scope when no options", async () => {
    const tool = createMemorySearchTool({ config: baseCfg });
    expect(tool).toBeTruthy();
    const result = await tool!.execute("call1", { query: "test" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("global");
    expect(details.scopeDenied).toBe(false);
  });

  it("uses channel scope when isSupport with channelSlug", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: true,
      channelSlug: "acme-corp",
      defaultScope: "channel",
    });
    const result = await tool!.execute("call2", { query: "test" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("channel");
    expect(details.scopeDenied).toBe(false);
    expect(searchCalledWith?.scope).toBe("channel");
    expect(searchCalledWith?.channelSlug).toBe("acme-corp");
  });

  it("returns scopeDenied when channel scope has no slug", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: true,
      defaultScope: "channel",
      // no channelSlug
    });
    const result = await tool!.execute("call3", { query: "test" });
    const details = result.details as Record<string, unknown>;
    expect(details.scopeDenied).toBe(true);
    expect(details.results).toEqual([]);
    // Manager should NOT have been called
    expect(stubManager.search).not.toHaveBeenCalled();
  });

  it("downgrades all-customers to channel when not allowed", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: true,
      channelSlug: "acme-corp",
      defaultScope: "channel",
      allowAllCustomers: false,
    });
    const result = await tool!.execute("call4", { query: "test", scope: "all-customers" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("channel");
    expect(details.requestedScope).toBe("all-customers");
  });

  it("allows all-customers when explicitly allowed", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: true,
      channelSlug: "acme-corp",
      defaultScope: "channel",
      allowAllCustomers: true,
    });
    const result = await tool!.execute("call5", { query: "test", scope: "all-customers" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("all-customers");
    expect(searchCalledWith?.scope).toBe("all-customers");
  });

  it("allows channel scope for non-support sessions when channelSlug is present", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: false,
      channelSlug: "acme-corp",
    });
    const result = await tool!.execute("call6", { query: "test", scope: "channel" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("channel");
  });

  it("forces global for non-support sessions requesting channel without slug", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: false,
    });
    const result = await tool!.execute("call6b", { query: "test", scope: "channel" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("global");
  });

  it("derives channel slug from session metadata subject when not passed in options", async () => {
    const sessionKey = "agent:main:zoom:channel:a04c5d88@conference.xmpp.zoom.us";
    mockSessionStoreRef.value = {
      [sessionKey]: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        subject: "Test Customer",
      },
    };
    const tool = createMemorySearchTool({
      config: baseCfg,
      agentSessionKey: sessionKey,
      isSupport: false,
      defaultScope: "channel",
    });
    const result = await tool!.execute("call6c", { query: "test", scope: "channel" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("channel");
    expect(searchCalledWith?.channelSlug).toBe("test-customer");
  });

  it("forces global for non-support sessions requesting all-customers", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: false,
    });
    const result = await tool!.execute("call7", { query: "test", scope: "all-customers" });
    const details = result.details as Record<string, unknown>;
    expect(details.effectiveScope).toBe("global");
  });

  it("ignores invalid scope values", async () => {
    const tool = createMemorySearchTool({
      config: baseCfg,
      isSupport: true,
      channelSlug: "acme-corp",
      defaultScope: "channel",
    });
    const result = await tool!.execute("call8", { query: "test", scope: "bogus" });
    const details = result.details as Record<string, unknown>;
    // Falls back to defaultScope
    expect(details.effectiveScope).toBe("channel");
  });

  it("retries empty channel results with relaxed minScore when minScore is not explicit", async () => {
    stubManager.search.mockImplementation(async (_query: string, opts?: Record<string, unknown>) => {
      searchCalledWith = opts;
      searchCallHistory.push(opts);
      if (opts?.minScore === 0.2) {
        return [
          {
            path: "memory/customers/acme/notes.md",
            startLine: 1,
            endLine: 3,
            score: 0.31,
            snippet: "Acme asks for engineer call support",
            source: "memory" as const,
          },
        ];
      }
      return [];
    });

    const tool = createMemorySearchTool({
      config: baseCfg,
      channelSlug: "acme-corp",
      defaultScope: "channel",
    });
    const result = await tool!.execute("call9", { query: "engineer call", scope: "channel" });
    const details = result.details as Record<string, unknown>;
    const results = details.results as Array<Record<string, unknown>>;

    expect(searchCallHistory.length).toBe(2);
    expect(searchCallHistory[0]?.minScore).toBeUndefined();
    expect(searchCallHistory[1]?.minScore).toBe(0.2);
    expect(results.length).toBe(1);
    expect(details.relaxedMinScore).toBe(0.2);
  });
});
