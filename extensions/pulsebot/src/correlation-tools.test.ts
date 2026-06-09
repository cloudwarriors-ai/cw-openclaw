import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditLogger } from "./audit.js";
import { registerCorrelationTools } from "./correlation-tools.js";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

type TextToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

type RegisteredTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<TextToolResult>;
};

function createMockApi() {
  const tools: RegisteredTool[] = [];
  const api = {
    registerTool(factory: () => RegisteredTool) {
      tools.push(factory());
    },
  };
  return { api, tools };
}

function parseToolJson(result: TextToolResult) {
  const raw = result.content[0]?.text ?? "{}";
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("pulsebot correlation tool", () => {
  const logger: AuditLogger = vi.fn();
  const fetchMock = vi.fn();

  beforeEach(() => {
    execFileSyncMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.DEV_TOOLS_API = "test-token";
    process.env.DEVTOOLS_API_URL = "https://devtools.example";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEV_TOOLS_API;
    delete process.env.DEVTOOLS_API_URL;
  });

  it("returns combined log + GitHub correlations", async () => {
    const { api, tools } = createMockApi();
    registerCorrelationTools(api as never, logger, {
      ppRepos: ["cloudwarriors-ai/project-pulse"],
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ logs: "start\nerror timeout in worker\ndone" }),
    });
    execFileSyncMock.mockReturnValue(
      JSON.stringify([{ number: 77, title: "Timeout in worker pool", state: "open" }]),
    );

    const tool = tools.find((entry) => entry.name === "pp_correlate_logs");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call1", { pattern: "timeout", tail: 10 });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect((payload.logMatches as { count: number }).count).toBe(1);
    expect(Array.isArray(payload.ghIssues)).toBe(true);
    expect((payload.ghIssues as Array<Record<string, unknown>>)[0]?.number).toBe(77);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(execFileSyncMock).toHaveBeenCalledOnce();
  });

  it("continues when gh search fails", async () => {
    const { api, tools } = createMockApi();
    registerCorrelationTools(api as never, logger, {
      ppRepos: ["cloudwarriors-ai/project-pulse"],
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ logs: "timeout\ntimeout\nok" }),
    });
    execFileSyncMock.mockImplementation(() => {
      throw new Error("/bin/sh: 1: gh: not found");
    });

    const tool = tools.find((entry) => entry.name === "pp_correlate_logs");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call2", { pattern: "timeout" });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect((payload.logMatches as { count: number }).count).toBe(2);
    expect(payload.ghIssues).toEqual([]);
  });
});
