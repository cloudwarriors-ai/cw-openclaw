import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the process boundary so no real CLI ever runs. The gate's core guarantee:
// a gated tool's execute() must NOT invoke the EOA CLI — only a human CONFIRM
// (via tryExecuteConfirm) may fire the staged run closure.
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

// Staging delivers the CONFIRM prompt (with the code) to the channel via
// sendEoaText — never through the tool result. Spy on the delivery.
const sendEoaTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  EOA_CHANNEL: "eoa-fallback-channel@conference.xmpp.zoom.us",
  sendEoaText: (...args: unknown[]) => sendEoaTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
}));

import { tryExecuteConfirm } from "./confirm.js";
import { registerEoaCliTools } from "./eoa-cli-tools.js";

type ToolDef = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const noopLogger = () => {};
const CHANNEL = "eoa-test-channel@conference.xmpp.zoom.us";

function buildTools(): Record<string, ToolDef> {
  const tools: Record<string, ToolDef> = {};
  const api = {
    registerTool: (factory: () => ToolDef) => {
      const t = factory();
      tools[t.name] = t;
    },
  } as never;
  registerEoaCliTools(api, noopLogger as never);
  return tools;
}

const parse = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
// The confirm code travels ONLY through the deterministic channel send, never
// through the tool's return value. Pull it from the latest sendEoaText call.
const codeFromDelivery = () =>
  String(sendEoaTextMock.mock.calls.at(-1)?.[1] ?? "").match(/CONFIRM (\d{4})/)?.[1];

const GATED: Record<string, Record<string, unknown>> = {
  eoa_run_execute: { issueMirrorId: "mirror-uuid-1" },
  eoa_run_resume: { runId: "run-uuid-2" },
  eoa_smoke_test: { releasePath: "rel.json", onboardingPath: "onb.yaml", issueNumber: 7 },
  eoa_onboard_project: { releasePath: "rel.json", onboardingPath: "onb.yaml" },
};

describe("eoa-cli-tools confirm gate", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    sendEoaTextMock.mockReset();
    process.env.EOA_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(() => {
    delete process.env.EOA_ZOOM_CHANNEL;
  });

  it("ALL gated tools STAGE only — execute() never runs the CLI, result is code-free", async () => {
    const t = buildTools();
    for (const [name, args] of Object.entries(GATED)) {
      const res = parse(await t[name].execute("x", args));
      expect(res.staged, `${name} must stage`).toBe(true);
      expect(JSON.stringify(res), `${name} result must be code-free`).not.toMatch(/CONFIRM \d{4}/);
    }
    expect(execFileSyncMock, "no gated tool may run the CLI before CONFIRM").not.toHaveBeenCalled();
  });

  it("read/validate tools execute the CLI immediately (not gated)", async () => {
    const t = buildTools();
    execFileSyncMock.mockReturnValue('{"ok":true}');
    await t.eoa_doctor.execute("x", { customerRepoId: "repo-uuid" });
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = execFileSyncMock.mock.calls[0];
    expect(bin).toBe("npx");
    expect(argv).toEqual(["tsx", "src/cli.ts", "customer", "doctor", "repo-uuid"]);
  });

  it("a CONFIRM from the EOA channel fires the staged run with literal argv", async () => {
    const t = buildTools();
    await t.eoa_run_execute.execute("x", { issueMirrorId: "mirror-uuid-1" });
    const code = codeFromDelivery();
    expect(code).toBeTruthy();

    execFileSyncMock.mockReturnValue('{"run":{"id":"r1"},"evidenceBundleId":"e1"}');
    const reply = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "tester",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(reply).toMatch(/✅ Done/);
    const [bin, argv] = execFileSyncMock.mock.calls[0];
    expect(bin).toBe("npx");
    expect(argv).toEqual(["tsx", "src/cli.ts", "run", "execute", "mirror-uuid-1", "--detach"]);
  });

  it("a CONFIRM from a DIFFERENT channel cannot fire the staged run", async () => {
    const t = buildTools();
    await t.eoa_run_resume.execute("x", { runId: "run-uuid-2" });
    const code = codeFromDelivery();

    const wrong = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "attacker",
      conversationId: "someone-elses-channel@conference.xmpp.zoom.us",
      logger: noopLogger as never,
    });
    expect(wrong).toMatch(/different channel|expired|already been used/);
    expect(execFileSyncMock).not.toHaveBeenCalled();

    // Right channel: the action is still there and fires.
    execFileSyncMock.mockReturnValue('{"run":{"id":"r2"}}');
    const right = await tryExecuteConfirm({
      text: `CONFIRM ${code}`,
      actor: "tester",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(right).toMatch(/✅ Done/);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it("a wrong/expired code executes nothing (fail-closed)", async () => {
    buildTools();
    const reply = await tryExecuteConfirm({
      text: "CONFIRM 0000",
      actor: "tester",
      conversationId: CHANNEL,
      logger: noopLogger as never,
    });
    expect(reply).toMatch(/No pending action/i);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("unset or compose-injected empty channel env fails closed (no inline prompt, nothing staged)", async () => {
    const stageWithBrokenEnv = async () => {
      const t = buildTools();
      return parse(await t.eoa_run_execute.execute("x", { issueMirrorId: "mirror-uuid-1" }));
    };
    // Compose passes `EOA_ZOOM_CHANNEL=${EOA_ZOOM_CHANNEL}`: an unset host
    // var arrives as "" in the container. Both "" and unset must refuse to stage.
    process.env.EOA_ZOOM_CHANNEL = "";
    const emptyStaged = await stageWithBrokenEnv();
    delete process.env.EOA_ZOOM_CHANNEL;
    const unsetStaged = await stageWithBrokenEnv();
    for (const staged of [emptyStaged, unsetStaged]) {
      expect(staged.ok).toBe(false);
      expect(String(staged.error)).toContain("EOA_ZOOM_CHANNEL");
      expect(JSON.stringify(staged)).not.toMatch(/CONFIRM \d{4}/);
    }
    expect(sendEoaTextMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
