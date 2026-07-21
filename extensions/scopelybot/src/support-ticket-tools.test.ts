// Support-ticket tool tests (support-ticket-tools.ts — Slice E §5). Cover:
// the UNGATED direct-create contract (no stageWrite — the one write end users
// may trigger), argv-only gh execution with the fixed repo/label (requester
// can never steer the destination), required-field validation, severity
// normalization, the best-effort triage post (failure never fails the
// ticket), and error fail-soft.

import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const sendScopelyTextMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
}));

vi.mock("./scopely-api.js", () => ({
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] }),
  errorResult: (err: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(err) }) }],
  }),
}));

import { registerSupportTicketTools } from "./support-ticket-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};

function buildTool(config: { scopelyRepos?: string[] } = {}): ToolDef {
  let tool: ToolDef | undefined;
  const api = {
    registerTool: (factory: () => ToolDef) => {
      tool = factory();
    },
  } as never;
  registerSupportTicketTools(api, noopLogger as never, config);
  if (!tool) throw new Error("tool not registered");
  return tool;
}

function parse(res: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

const PARAMS = {
  title: "Cannot see my SOW",
  description: "User asked why the SOW preview 404s; verified session 42 exists.",
  requester: "jane@customer.com",
};

beforeEach(() => {
  execFileSyncMock.mockReset().mockReturnValue("https://github.com/cloudwarriors-ai/scopely/issues/999\n");
  sendScopelyTextMock.mockClear();
  delete process.env.SCOPELYBOT_TRIAGE_CHANNEL;
});

describe("scopely_create_support_ticket", () => {
  it("creates DIRECTLY — no staging — via argv-only gh with fixed repo and label", async () => {
    const res = await buildTool().execute("id", PARAMS);
    const body = parse(res);
    expect(body).toMatchObject({ ok: true, status: 201 });
    expect((body.data as { url: string }).url).toContain("/issues/999");
    // Direct create: exactly one gh invocation happened during execute.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, argv, opts] = execFileSyncMock.mock.calls[0] as [
      string,
      string[],
      { input: string },
    ];
    expect(cmd).toBe("gh");
    expect(argv).toContain("--repo");
    expect(argv[argv.indexOf("--repo") + 1]).toBe("cloudwarriors-ai/scopely");
    expect(argv[argv.indexOf("--label") + 1]).toBe("support-ticket");
    expect(argv[argv.indexOf("--title") + 1]).toBe("[support] Cannot see my SOW");
    // Requester + severity land in the body, not the argv.
    expect(opts.input).toContain("Requester: jane@customer.com");
    expect(opts.input).toContain("Severity: normal");
  });

  it("the requester can never steer the destination repo", async () => {
    const res = await buildTool({ scopelyRepos: ["cloudwarriors-ai/scopely"] }).execute("id", {
      ...PARAMS,
      repo: "attacker/exfil", // not a declared parameter; must be ignored
    });
    expect(parse(res).ok).toBe(true);
    const argv = execFileSyncMock.mock.calls[0][1] as string[];
    expect(argv[argv.indexOf("--repo") + 1]).toBe("cloudwarriors-ai/scopely");
  });

  it("requires title, description, and requester", async () => {
    for (const missing of ["title", "description", "requester"]) {
      execFileSyncMock.mockClear();
      const res = await buildTool().execute("id", { ...PARAMS, [missing]: "" });
      expect(parse(res).ok).toBe(false);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    }
  });

  it("normalizes unknown severities to normal and honors valid ones", async () => {
    await buildTool().execute("id", { ...PARAMS, severity: "CRITICAL!!" });
    expect((execFileSyncMock.mock.calls[0][2] as { input: string }).input).toContain(
      "Severity: normal",
    );
    execFileSyncMock.mockClear();
    await buildTool().execute("id", { ...PARAMS, severity: "high" });
    expect((execFileSyncMock.mock.calls[0][2] as { input: string }).input).toContain(
      "Severity: high",
    );
  });

  it("posts a triage handoff when the channel is configured; its failure never fails the ticket", async () => {
    process.env.SCOPELYBOT_TRIAGE_CHANNEL = "triage@conference.xmpp.zoom.us";
    sendScopelyTextMock.mockRejectedValueOnce(new Error("zoom down"));
    const res = await buildTool().execute("id", PARAMS);
    expect(parse(res).ok).toBe(true);
    expect(sendScopelyTextMock).toHaveBeenCalledWith(
      "triage@conference.xmpp.zoom.us",
      expect.stringContaining("/issues/999"),
    );
  });

  it("no triage post without the channel env", async () => {
    await buildTool().execute("id", PARAMS);
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
  });

  it("gh failure returns a structured error", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh: auth required");
    });
    const res = await buildTool().execute("id", PARAMS);
    expect(parse(res).ok).toBe(false);
    expect(String(parse(res).error)).toContain("auth required");
  });
});
