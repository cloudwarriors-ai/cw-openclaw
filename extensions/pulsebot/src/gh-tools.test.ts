import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogger } from "./audit.js";
import { registerGhTools } from "./gh-tools.js";

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: execSyncMock,
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

describe("pulsebot gh tools", () => {
  const logger: AuditLogger = vi.fn();

  beforeEach(() => {
    execSyncMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("returns issue data when gh is available", async () => {
    const { api, tools } = createMockApi();
    registerGhTools(api as never, logger, { ppRepos: ["cloudwarriors-ai/project-pulse"] });

    execSyncMock.mockReturnValue(
      JSON.stringify([{ number: 42, title: "OAuth login fails", state: "open" }]),
    );

    const tool = tools.find((entry) => entry.name === "gh_list_issues");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call1", { state: "open", limit: 1 });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.data)).toBe(true);
    expect((payload.data as Array<Record<string, unknown>>)[0]?.number).toBe(42);
    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(String(execSyncMock.mock.calls[0]?.[0])).toContain("gh issue list");
  });

  it("surfaces gh-not-found errors without throwing", async () => {
    const { api, tools } = createMockApi();
    registerGhTools(api as never, logger, { ppRepos: ["cloudwarriors-ai/project-pulse"] });

    execSyncMock.mockImplementation(() => {
      throw new Error("/bin/sh: 1: gh: not found");
    });

    const tool = tools.find((entry) => entry.name === "gh_search_issues");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call2", { query: "oauth timeout" });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("gh: not found");
    expect(execSyncMock).toHaveBeenCalledOnce();
  });

  it("blocks repositories outside the allowlist", async () => {
    const { api, tools } = createMockApi();
    registerGhTools(api as never, logger, { ppRepos: ["cloudwarriors-ai/project-pulse"] });

    const tool = tools.find((entry) => entry.name === "gh_list_issues");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call3", { repo: "other-org/other-repo" });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("not in allowed list");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("persists stakeholder metadata on issue creation", async () => {
    const { api, tools } = createMockApi();
    registerGhTools(api as never, logger, { ppRepos: ["cloudwarriors-ai/project-pulse"] });

    execSyncMock
      .mockReturnValueOnce("https://github.com/cloudwarriors-ai/project-pulse/issues/77")
      .mockReturnValueOnce("https://github.com/cloudwarriors-ai/project-pulse/issues/77#issuecomment-1");

    const tool = tools.find((entry) => entry.name === "gh_create_issue");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call4", {
      title: "Webhook timeout",
      body: "Customer reported a timeout while saving.",
      reporter: "doug.ruby@cloudwarriors.ai",
      stakeholders: ["@voipin", "trent.mitchell@cloudwarriors.ai"],
    });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(payload.issueNumber).toBe(77);
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(String(execSyncMock.mock.calls[1]?.[0])).toContain("gh issue comment 77");
    const commentInput = String(execSyncMock.mock.calls[1]?.[1]?.input ?? "");
    expect(commentInput).toContain("Reporter: doug.ruby@cloudwarriors.ai");
    expect(commentInput).toContain("Stakeholders:");
  });

  it("closes issues, comments with stakeholders, and reports dm notifications", async () => {
    const { api, tools } = createMockApi();
    registerGhTools(api as never, logger, { ppRepos: ["cloudwarriors-ai/project-pulse"] });

    execSyncMock
      .mockReturnValueOnce(
        JSON.stringify({
          number: 88,
          title: "Fix DM delivery",
          body: [
            "<!-- pulsebot:stakeholders:start -->",
            "Reporter: doug.ruby@cloudwarriors.ai",
            "Stakeholders: @voipin, trent.mitchell@cloudwarriors.ai",
            "<!-- pulsebot:stakeholders:end -->",
          ].join("\n"),
          comments: [],
          assignees: [],
        }),
      )
      .mockReturnValueOnce("commented")
      .mockReturnValueOnce("closed");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "token", expires_in: 3600 }),
        } as Response;
      }
      return {
        ok: true,
        text: async () => "",
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    process.env.ZOOM_REPORT_CLIENT_ID = "cid";
    process.env.ZOOM_REPORT_CLIENT_SECRET = "secret";
    process.env.ZOOM_REPORT_ACCOUNT_ID = "acct";
    process.env.ZOOM_REPORT_USER = "doug.ruby@cloudwarriors.ai";
    process.env.PULSEBOT_STAKEHOLDER_MAP = "voipin=doug.ruby@cloudwarriors.ai";

    const tool = tools.find((entry) => entry.name === "gh_close_issue");
    expect(tool).toBeDefined();

    const result = await tool!.execute("call5", {
      number: 88,
      comment: "Fix deployed to production.",
    });
    const payload = parseToolJson(result);

    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.notified)).toBe(true);
    expect((payload.notified as string[]).length).toBeGreaterThan(0);
    expect(execSyncMock).toHaveBeenCalledTimes(3);
    expect(String(execSyncMock.mock.calls[2]?.[0])).toContain("gh issue close 88");
  });
});
