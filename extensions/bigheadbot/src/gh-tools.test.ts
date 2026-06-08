import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shell boundary so no real `gh` command ever runs and we can assert
// exactly when (stage vs confirm) a mutation would fire.
const execSyncMock = vi.fn();
vi.mock("child_process", () => ({ execSync: (...args: unknown[]) => execSyncMock(...args) }));

vi.mock("./bh-api.js", () => ({
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
}));

const sendBigheadTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendBigheadText: (...args: unknown[]) => sendBigheadTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
  BIGHEADBOT_CHANNEL: "bigheadbot-default@conference.xmpp.zoom.us",
}));

// Stakeholder/DM helpers are not under test here — stub to no-ops.
vi.mock("./stakeholders.js", () => ({
  buildStakeholderWorkPrefix: () => "",
  extractStakeholdersFromIssue: () => ({ stakeholders: [], reporter: undefined }),
  formatStakeholderBlock: () => "",
  parseIssueNumberFromUrl: () => 42,
  resolveStakeholderDmTarget: () => undefined,
  upsertStakeholderBlock: (body: string) => body,
}));
vi.mock("./zoom-dm.js", () => ({ sendStakeholderZoomDm: async () => ({ ok: true }) }));

import { tryExecuteConfirm } from "./confirm.js";
import { registerGhTools } from "./gh-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};
const CHANNEL = "bigheadbot@conference.xmpp.zoom.us";

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerGhTools(api, noopLogger as never, { bhRepos: ["cloudwarriors-ai/bighead"] });
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function codeFromDelivery(): string | undefined {
  const text = sendBigheadTextMock.mock.calls.at(-1)?.[1];
  return String(text ?? "").match(/CONFIRM (\d{4})/)?.[1];
}

describe("bigheadbot gh writes are confirm-gated", () => {
  beforeEach(() => {
    execSyncMock.mockReset();
    sendBigheadTextMock.mockReset();
    process.env.BIGHEADBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.BIGHEADBOT_ZOOM_CHANNEL;
  });

  it("create_issue stages — no gh shell-out, code-free result, prompt to channel", async () => {
    const tools = buildTools();
    const staged = parse(
      await tools.bh_gh_create_issue.execute("t", { title: "Crash on boot", body: "details" }),
    );

    expect(staged.staged).toBe(true);
    expect(staged.awaiting_confirmation).toBe(true);
    expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    expect(execSyncMock).not.toHaveBeenCalled(); // no mutation at stage time
    expect(sendBigheadTextMock).toHaveBeenCalledTimes(1);
    expect(sendBigheadTextMock.mock.calls[0][1]).toMatch(/CONFIRM \d{4}/);
  });

  it("create_issue runs `gh issue create` only after CONFIRM", async () => {
    const tools = buildTools();
    execSyncMock.mockReturnValue("https://github.com/cloudwarriors-ai/bighead/issues/42");
    await tools.bh_gh_create_issue.execute("t", { title: "Crash", body: "x" });
    expect(execSyncMock).not.toHaveBeenCalled();

    const code = codeFromDelivery();
    const reply = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      logger: noopLogger as never,
    });

    const createCalls = execSyncMock.mock.calls.filter((c) =>
      String(c[0]).includes("gh issue create"),
    );
    expect(createCalls.length).toBe(1);
    expect(reply).toMatch(/✅ Done/);
    expect(reply).toContain("https://github.com/cloudwarriors-ai/bighead/issues/42");
  });

  it("close_issue stages and does not close until CONFIRM", async () => {
    const tools = buildTools();
    execSyncMock.mockReturnValue("closed");
    await tools.bh_gh_close_issue.execute("t", { number: 7 });
    // Stage time: nothing shells out (not even the issue-view read inside the closure).
    expect(execSyncMock).not.toHaveBeenCalled();

    const code = codeFromDelivery();
    await tryExecuteConfirm({ text: `CONFIRM ${code}`, actor: "t", logger: noopLogger as never });
    const closeCalls = execSyncMock.mock.calls.filter((c) =>
      String(c[0]).includes("gh issue close"),
    );
    expect(closeCalls.length).toBe(1);
  });

  it("an unknown repo is rejected at stage time (no staging, no prompt)", async () => {
    const tools = buildTools();
    const res = parse(
      await tools.bh_gh_create_issue.execute("t", {
        repo: "evil/repo",
        title: "x",
        body: "y",
      }),
    );
    expect(res.ok).toBe(false);
    expect(sendBigheadTextMock).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalled();
  });
});
