// Bundled-confirm coalescing tests (gated.ts). Motivated by the live
// 2026-07-20 exchange: "Make Ring Central like 8x8" staged 6 mutations in one
// agent turn, producing SIX separate confirm prompts/codes — John Rudolph asked
// for "one message to confirm all intentions not broke apart". With
// SCOPELYBOT_CONFIRM_BUNDLE_MS > 0, staged writes within the window coalesce
// into ONE prompt with ONE code; unset/0 preserves the legacy one-prompt-per-
// write behavior exactly (every existing tool test runs on that path).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendScopelyTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
  getChannelThreadAnchor: () => "MSG-ANCHOR",
  rememberChannelThreadAnchor: () => {},
  sendComfortMessage: () => {},
}));

import { tryExecuteConfirm } from "./confirm.js";
import { flushStagedBundlesForTest, stageWrite } from "./gated.js";

const CHANNEL = "vipbot@conference.xmpp.zoom.us";
const APPROVER = "Mb4vcQ4YQUaQKJjoY4vntQ";
const noopLogger = () => {};

// The tool result is code-free by design; read the code from the delivery spy.
const lastPromptCode = () =>
  String(sendScopelyTextMock.mock.calls.at(-1)?.[1] ?? "").match(/CONFIRM (\d{4})/)?.[1];

async function confirmAs(code: string) {
  return tryExecuteConfirm({
    text: `CONFIRM ${code}`,
    actor: APPROVER,
    conversationId: CHANNEL,
    approverIds: [APPROVER],
    logger: noopLogger as never,
  });
}

describe("stageWrite bundling", () => {
  beforeEach(() => {
    sendScopelyTextMock.mockReset();
    process.env.SCOPELYBOT_ZOOM_CHANNEL = CHANNEL;
  });
  afterEach(async () => {
    await flushStagedBundlesForTest(); // never leak an open bundle across tests
    delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
    delete process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS;
  });

  it("legacy path (window unset): each stage posts its own prompt inline", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    await stageWrite("update card A", run);
    await stageWrite("delete card B", run);
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(2);
    const prompts = sendScopelyTextMock.mock.calls.map((c) => String(c[1]));
    expect(prompts[0]).toContain("⚠️ Confirm: update card A on PROD.");
    expect(prompts[1]).toContain("⚠️ Confirm: delete card B on PROD.");
    // Two distinct codes — unchanged legacy contract.
    const codes = prompts.map((p) => p.match(/CONFIRM (\d{4})/)?.[1]);
    expect(codes[0]).toBeDefined();
    expect(codes[0]).not.toEqual(codes[1]);
  });

  it("bundles N staged writes into ONE prompt with ONE code listing every change", async () => {
    process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS = "1500";
    const run = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    const results = await Promise.all([
      stageWrite("update scoping card 588 (notes)", run),
      stageWrite("update scoping card 584 (call routing)", run),
      stageWrite("delete scoping card 585", run),
    ]);
    // Every tool result is staged + code-free (model contract unchanged).
    for (const res of results) {
      const body = JSON.parse((res as { content: { text: string }[] }).content[0].text);
      expect(body.staged).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/\d{4}/);
    }
    expect(sendScopelyTextMock, "no prompt before the window flushes").not.toHaveBeenCalled();
    await flushStagedBundlesForTest();
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(1);
    const prompt = String(sendScopelyTextMock.mock.calls[0][1]);
    expect(prompt).toContain("⚠️ Confirm 3 changes on PROD:");
    expect(prompt).toContain("1. update scoping card 588 (notes)");
    expect(prompt).toContain("2. update scoping card 584 (call routing)");
    expect(prompt).toContain("3. delete scoping card 585");
    expect(prompt).toMatch(/apply ALL 3/);
    expect(prompt.match(/CONFIRM \d{4}/g)?.length, "exactly one code").toBe(1);
  });

  it("one CONFIRM executes every bundled run, in order, with the actor passed through", async () => {
    process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS = "1500";
    const order: string[] = [];
    const mk = (name: string) =>
      vi.fn().mockImplementation(async (ctx?: { actor?: string }) => {
        order.push(`${name}:${ctx?.actor}`);
        return { ok: true, status: 200, data: {} };
      });
    const [r1, r2] = [mk("first"), mk("second")];
    await stageWrite("first change", r1);
    await stageWrite("second change", r2);
    await flushStagedBundlesForTest();
    const reply = await confirmAs(lastPromptCode() as string);
    expect(reply).toContain("✅ Done: 2 changes: first change; second change");
    expect(order).toEqual([`first:${APPROVER}`, `second:${APPROVER}`]);
  });

  it("partial failure continues, reports per-item outcomes, and never hides what applied", async () => {
    process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS = "1500";
    await stageWrite(
      "update card ok",
      vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    );
    await stageWrite(
      "delete card broken",
      vi.fn().mockResolvedValue({ ok: false, status: 502, data: {} }),
    );
    await stageWrite(
      "update card also-ok",
      vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    );
    await flushStagedBundlesForTest();
    const reply = await confirmAs(lastPromptCode() as string);
    expect(reply).toContain("⚠️ Applied 2 of 3");
    expect(reply).toContain("✅ update card ok");
    expect(reply).toContain("❌ delete card broken (HTTP 502)");
    expect(reply).toContain("✅ update card also-ok");
  });

  it("a bundled code is single-use: second CONFIRM finds nothing", async () => {
    process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS = "1500";
    const run = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    await stageWrite("only change", run);
    await flushStagedBundlesForTest();
    const code = lastPromptCode() as string;
    await confirmAs(code);
    const second = await confirmAs(code);
    expect(second).toContain("No pending action");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a single staged write inside the window still renders the legacy prompt shape", async () => {
    process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS = "1500";
    const run = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    await stageWrite("reset password for user 47", run);
    await flushStagedBundlesForTest();
    const prompt = String(sendScopelyTextMock.mock.calls[0][1]);
    expect(prompt).toContain("⚠️ Confirm: reset password for user 47 on PROD.");
    const reply = await confirmAs(lastPromptCode() as string);
    expect(reply).toContain("✅ Done: reset password for user 47.");
  });

  it("writes staged after a flush start a NEW bundle with a new code", async () => {
    process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS = "1500";
    const run = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    await stageWrite("first wave", run);
    await flushStagedBundlesForTest();
    const firstCode = lastPromptCode();
    await stageWrite("second wave", run);
    await flushStagedBundlesForTest();
    const secondCode = lastPromptCode();
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(2);
    expect(firstCode).not.toEqual(secondCode);
  });

  it("fail-closed without a channel, even when bundling is enabled", async () => {
    process.env.SCOPELYBOT_CONFIRM_BUNDLE_MS = "1500";
    delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
    const res = await stageWrite(
      "anything",
      vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    );
    const body = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/SCOPELYBOT_ZOOM_CHANNEL/);
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
  });
});
