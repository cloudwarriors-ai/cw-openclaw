import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process boundary so no real `gh` command ever runs and we can assert that
// LLM-controlled values reach gh as literal argv elements (execFileSync = no shell),
// never a shell string. Writes are staged and the captured closure is exercised
// separately so no command can run before confirmation.
const execFileSyncMock = vi.fn();
const stagedRuns: Array<() => Promise<unknown>> = [];
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock("./gated.js", () => ({
  stageWrite: (_summary: string, run: () => Promise<unknown>) => {
    stagedRuns.push(run);
    return Promise.resolve({
      content: [
        { type: "text", text: JSON.stringify({ staged: true, awaiting_confirmation: true }) },
      ],
    });
  },
}));

vi.mock("./scopely-api.js", () => ({
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
}));

import { registerGhTools } from "./gh-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};
const REPO = "cloudwarriors-ai/scopely";

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerGhTools(api, noopLogger as never, { scopelyRepos: [REPO] });
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

// All gh invocations go through execFileSync("gh", argv, opts). Find the call whose
// argv contains a given token.
function ghArgvContaining(token: string): string[] | undefined {
  const call = execFileSyncMock.mock.calls.find(
    (c) => Array.isArray(c[1]) && (c[1] as string[]).includes(token),
  );
  return call?.[1] as string[] | undefined;
}

describe("scopelybot gh tools are injection-safe (execFileSync, no shell)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    stagedRuns.length = 0;
  });

  it("every gh call passes argv to execFileSync, not a shell string", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("[]");
    await tools.scopely_gh_list_issues.execute("t", {});
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileSyncMock.mock.calls[0];
    expect(bin).toBe("gh");
    expect(Array.isArray(argv)).toBe(true);
    expect((argv as unknown[]).every((a) => typeof a === "string")).toBe(true);
  });

  it("search passes a shell-metachar query as ONE verbatim argv element", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("[]");
    const malicious = '"; rm -rf / #$(whoami)`id`';
    await tools.scopely_gh_search_issues.execute("t", { query: malicious });
    const argv = ghArgvContaining("issues");
    expect(argv).toBeDefined();
    expect(argv).toContain(malicious);
  });

  it("create stages first, then passes a metachar title as ONE verbatim argv element", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("https://github.com/cloudwarriors-ai/scopely/issues/9");
    const title = 'Crash "$(rm -rf /)" `id`';
    await tools.scopely_gh_create_issue.execute("t", { title, body: "x" });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(stagedRuns).toHaveLength(1);
    await stagedRuns[0]();
    const argv = ghArgvContaining("create");
    expect(argv).toBeDefined();
    expect(argv).toContain(title);
  });

  it("comment and close are separate staged writes", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("ok");
    await tools.scopely_gh_add_comment.execute("t", { number: 9, body: "QA" });
    await tools.scopely_gh_close_issue.execute("t", { number: 9, reason: "completed" });
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(stagedRuns).toHaveLength(2);
    await stagedRuns[0]();
    await stagedRuns[1]();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("get_issue rejects a non-integer issue number and never shells out", async () => {
    const tools = buildTools();
    const res = parse(await tools.scopely_gh_get_issue.execute("t", { number: "7 $(whoami)" }));
    expect(res.ok).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("list_issues rejects an invalid state value", async () => {
    const tools = buildTools();
    const res = parse(await tools.scopely_gh_list_issues.execute("t", { state: "open; rm -rf /" }));
    expect(res.ok).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("blocks repositories outside the allowlist (no shell-out)", async () => {
    const tools = buildTools();
    const res = parse(await tools.scopely_gh_list_issues.execute("t", { repo: "evil/repo" }));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("not in allowed list");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
