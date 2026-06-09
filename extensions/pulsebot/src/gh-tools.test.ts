import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process boundary so no real `gh` command ever runs and we can assert
// exactly when (stage vs confirm) a mutation fires AND that LLM-controlled values
// reach gh as literal argv elements (execFileSync = no shell), never a shell string.
const execFileSyncMock = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock("./pp-api.js", () => ({
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
}));

const sendPulseTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendPulseText: (...args: unknown[]) => sendPulseTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
  PULSEBOT_CHANNEL: "pulsebot-default@conference.xmpp.zoom.us",
}));

// Stakeholder/DM helpers are not under test here — stub to no-ops.
vi.mock("./stakeholders.js", () => ({
  buildStakeholderWorkPrefix: () => "",
  extractStakeholdersFromIssue: () => ({ stakeholders: [], reporter: undefined }),
  formatStakeholderBlock: () => "",
  parseIssueNumberFromUrl: () => 77,
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
const CHANNEL = "pulsebot@conference.xmpp.zoom.us";
const REPO = "cloudwarriors-ai/project-pulse";

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerGhTools(api, noopLogger as never, { ppRepos: [REPO] });
  return tools;
}

function parse(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

function codeFromDelivery(): string | undefined {
  const text = sendPulseTextMock.mock.calls.at(-1)?.[1];
  return String(text ?? "").match(/CONFIRM (\d{4})/)?.[1];
}

// All gh invocations go through execFileSync("gh", argv, opts). Find the call whose
// argv contains a given subcommand token.
function ghArgvContaining(token: string): string[] | undefined {
  const call = execFileSyncMock.mock.calls.find(
    (c) => Array.isArray(c[1]) && (c[1] as string[]).includes(token),
  );
  return call?.[1] as string[] | undefined;
}

describe("pulsebot gh reads", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    sendPulseTextMock.mockReset();
  });

  it("list_issues returns parsed issue data (no staging)", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue(
      JSON.stringify([{ number: 42, title: "OAuth login fails", state: "open" }]),
    );
    const payload = parse(await tools.gh_list_issues.execute("t", { state: "open", limit: 1 }));
    expect(payload.ok).toBe(true);
    expect((payload.data as Array<Record<string, unknown>>)[0]?.number).toBe(42);
    const argv = ghArgvContaining("list");
    expect(argv).toBeDefined();
    expect(argv).toContain("issue");
    expect(sendPulseTextMock).not.toHaveBeenCalled();
  });

  it("surfaces gh-not-found errors without throwing", async () => {
    const tools = buildTools();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("/bin/sh: 1: gh: not found");
    });
    const payload = parse(await tools.gh_search_issues.execute("t", { query: "oauth timeout" }));
    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("gh: not found");
  });

  it("blocks repositories outside the allowlist", async () => {
    const tools = buildTools();
    const payload = parse(
      await tools.gh_list_issues.execute("t", { repo: "other-org/other-repo" }),
    );
    expect(payload.ok).toBe(false);
    expect(String(payload.error)).toContain("not in allowed list");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("pulsebot gh writes are confirm-gated", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    sendPulseTextMock.mockReset();
    process.env.PULSEBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.PULSEBOT_ZOOM_CHANNEL;
  });

  it("create_issue stages — no gh shell-out, code-free result, prompt to channel", async () => {
    const tools = buildTools();
    const staged = parse(
      await tools.gh_create_issue.execute("t", { title: "Crash on boot", body: "details" }),
    );

    expect(staged.staged).toBe(true);
    expect(staged.awaiting_confirmation).toBe(true);
    expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    expect(execFileSyncMock).not.toHaveBeenCalled(); // no mutation at stage time
    expect(sendPulseTextMock).toHaveBeenCalledTimes(1);
    expect(sendPulseTextMock.mock.calls[0][1]).toMatch(/CONFIRM \d{4}/);
  });

  it("create_issue runs `gh issue create` only after CONFIRM", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("https://github.com/cloudwarriors-ai/project-pulse/issues/77");
    await tools.gh_create_issue.execute("t", { title: "Crash", body: "x" });
    expect(execFileSyncMock).not.toHaveBeenCalled();

    const code = codeFromDelivery();
    const reply = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "t",
      logger: noopLogger as never,
    });

    expect(ghArgvContaining("create")).toBeDefined();
    expect(reply).toMatch(/✅ Done/);
    expect(reply).toContain("https://github.com/cloudwarriors-ai/project-pulse/issues/77");
  });

  it("close_issue stages and does not close until CONFIRM", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("closed");
    await tools.gh_close_issue.execute("t", { number: 7 });
    // Stage time: nothing shells out (not even the issue-view read inside the closure).
    expect(execFileSyncMock).not.toHaveBeenCalled();

    const code = codeFromDelivery();
    await tryExecuteConfirm({ text: `CONFIRM ${code}`, actor: "t", logger: noopLogger as never });
    expect(ghArgvContaining("close")).toBeDefined();
  });

  it("an unknown repo is rejected at stage time (no staging, no prompt)", async () => {
    const tools = buildTools();
    const res = parse(
      await tools.gh_create_issue.execute("t", { repo: "evil/repo", title: "x", body: "y" }),
    );
    expect(res.ok).toBe(false);
    expect(sendPulseTextMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});

describe("pulsebot gh tools are injection-safe (execFileSync, no shell)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    sendPulseTextMock.mockReset();
    process.env.PULSEBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.PULSEBOT_ZOOM_CHANNEL;
  });

  it("every gh call passes argv to execFileSync, not a shell string", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("[]");
    await tools.gh_list_issues.execute("t", {});
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
    await tools.gh_search_issues.execute("t", { query: malicious });
    const argv = ghArgvContaining("issues");
    expect(argv).toBeDefined();
    // The query is a single argv element, passed verbatim — not escaped, not split,
    // not quote-wrapped. execFileSync gives it no shell, so it cannot be expanded.
    expect(argv).toContain(malicious);
  });

  it("get_issue rejects a non-integer issue number and never shells out", async () => {
    const tools = buildTools();
    const res = parse(await tools.gh_get_issue.execute("t", { number: "7 $(whoami)" }));
    expect(res.ok).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("list_issues rejects an invalid state value", async () => {
    const tools = buildTools();
    const res = parse(await tools.gh_list_issues.execute("t", { state: "open; rm -rf /" }));
    expect(res.ok).toBe(false);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("create passes a metachar title as a verbatim argv element after CONFIRM", async () => {
    const tools = buildTools();
    execFileSyncMock.mockReturnValue("https://github.com/cloudwarriors-ai/project-pulse/issues/77");
    const title = 'Crash "$(rm -rf /)" `id`';
    await tools.gh_create_issue.execute("t", { title, body: "x" });
    const code = codeFromDelivery();
    await tryExecuteConfirm({ text: `CONFIRM ${code}`, actor: "t", logger: noopLogger as never });
    const argv = ghArgvContaining("create");
    expect(argv).toBeDefined();
    expect(argv).toContain(title); // verbatim, unescaped
  });
});
