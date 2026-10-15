// This domain fixture supplies explicit server eligibility; roster authority is tested separately.
vi.mock("./ops-roster-client.js", () => ({
  isCurrentApprover: async (actor: string) => ["synthetic-approver"].includes(actor),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => send(...args),
  getChannelThreadAnchor: () => "synthetic-thread",
}));

import { setBackendProfileForTest } from "./backend-profile.js";
import { tryExecuteConfirm } from "./confirm.js";
import { stageWrite } from "./gated.js";
import { makeCode, putPending, takePending } from "./pending-confirm.js";

const CHANNEL = "synthetic-channel";
const ACTOR = "synthetic-approver";
const logger = vi.fn();
const confirm = (text: string, actor = ACTOR, conversationId = CHANNEL) =>
  tryExecuteConfirm({ text, actor, conversationId, logger });
const promptCode = () => String(send.mock.calls.at(-1)?.[1]).match(/CONFIRM ([a-f0-9]{32})\b/)?.[1];
const run = () => vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  setBackendProfileForTest({ mode: "read-write" });
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", CHANNEL);
  send.mockReset();
  logger.mockReset();
});
afterEach(() => {
  vi.advanceTimersByTime(300_000);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setBackendProfileForTest(null);
});

describe("ScopelyBot confirmation replay boundary", () => {
  it("generates full-length per-action tokens instead of recyclable four-digit codes", () => {
    expect(makeCode()).toMatch(/^[a-f0-9]{32}$/);
  });

  it("does not replace an outstanding action when the same code is inserted twice", () => {
    const code = makeCode();
    const first = run();
    putPending({ code, conversationId: CHANNEL, summary: "first", run: first });
    expect(() =>
      putPending({ code, conversationId: CHANNEL, summary: "second", run: run() }),
    ).toThrow();
    expect(takePending(code, { conversationId: CHANNEL })?.run).toBe(first);
  });

  it("copies a human-only prompt, consumes once under concurrency and cannot approve the next action", async () => {
    const first = run();
    const result = await stageWrite("first synthetic change", first);
    const old = promptCode();
    expect(old).toBeDefined();
    expect(JSON.stringify(result)).not.toContain(old!);
    expect(await confirm(`CONFIRM ${old}`, "other-actor")).toContain("not authorized");
    expect(await confirm(`CONFIRM ${old}`, ACTOR, "other-channel")).toContain("No pending action");
    const replies = await Promise.all([confirm(`CONFIRM ${old}`), confirm(`CONFIRM ${old}`)]);
    expect(replies.filter((r) => r?.includes("Done"))).toHaveLength(1);
    expect(first).toHaveBeenCalledTimes(1);
    const second = run();
    await stageWrite("second synthetic change", second);
    const next = promptCode();
    expect(next).toBeDefined();
    expect(next).not.toBe(old);
    expect(await confirm(`CONFIRM ${old}`)).toContain("No pending action");
    expect(second).not.toHaveBeenCalled();
    expect(await confirm(`confirm ${next!.toUpperCase()}`)).toContain("Done");
    expect(second).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(old!);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(next!);
  });

  it.each([
    "CONFIRM",
    "CONFIRM 1234",
    `CONFIRM ${"a".repeat(32)} trailing`,
    `CONFIRM ${"a".repeat(33)}`,
  ])("refuses malformed command %s without consuming or running a pending action", async (text) => {
    const action = run();
    const code = "a".repeat(32);
    putPending({ code, conversationId: CHANNEL, summary: "untouched", run: action });
    expect(await confirm(text)).toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(takePending(code, { conversationId: CHANNEL })?.run).toBe(action);
  });

  it.each([299_999, 300_000, 300_001])("expires at exactly five minutes: %dms", async (age) => {
    const action = run();
    await stageWrite("expires", action);
    const code = promptCode();
    expect(code).toBeDefined();
    vi.advanceTimersByTime(age);
    await confirm(`CONFIRM ${code}`);
    expect(action).toHaveBeenCalledTimes(age < 300_000 ? 1 : 0);
  });

  it("a fresh module/store after restart does not accept the old token for a new action", async () => {
    const old = makeCode();
    putPending({ code: old, conversationId: CHANNEL, summary: "before restart", run: run() });
    vi.resetModules();
    const fresh = await import("./pending-confirm.js");
    const code = fresh.makeCode();
    expect(code).toMatch(/^[a-f0-9]{32}$/);
    expect(code).not.toBe(old);
    fresh.putPending({ code, conversationId: CHANNEL, summary: "after restart", run: run() });
    expect(fresh.takePending(old, { conversationId: CHANNEL })).toBeUndefined();
    expect(fresh.takePending(code, { conversationId: CHANNEL })?.summary).toBe("after restart");
    takePending(old, { conversationId: CHANNEL });
  });
});
