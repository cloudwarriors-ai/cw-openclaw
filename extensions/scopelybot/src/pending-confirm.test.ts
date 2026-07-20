/**
 * Pending-store scope tests: a CONFIRM consumes an action only when it provably
 * arrived where the action was staged — exact conversation match (channel root)
 * or the caller's own-zoom-surface proof (thread replies dispatch with the
 * thread id as conversationId; 2026-07-20 incident).
 */

import { describe, expect, it, vi } from "vitest";
import { putPending, takePending } from "./pending-confirm.js";

const CHANNEL = "feaf3140540745b9b0f9e82fdc26ebee@conference.xmpp.zoom.us";

function stage(code: string): void {
  putPending({
    code,
    conversationId: CHANNEL,
    summary: `test action ${code}`,
    run: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
  });
}

describe("takePending scope acceptance", () => {
  it("consumes on an exact conversation match (channel-root CONFIRM)", () => {
    stage("1111");
    const action = takePending("1111", { conversationId: CHANNEL });
    expect(action?.summary).toBe("test action 1111");
    // single-use: a second take must miss
    expect(takePending("1111", { conversationId: CHANNEL })).toBeUndefined();
  });

  it("rejects a mismatched conversation without consuming the action", () => {
    stage("2222");
    // Simulates another bot's channel or a forged conversation: no own-surface proof.
    expect(takePending("2222", { conversationId: "other-channel" })).toBeUndefined();
    // Not consumed — the rightful channel can still confirm.
    expect(takePending("2222", { conversationId: CHANNEL })?.summary).toBe("test action 2222");
  });

  it("consumes a thread-scoped CONFIRM carrying own-surface proof (2026-07-20 regression)", () => {
    stage("8248");
    // Thread replies dispatch with the thread id, never the channel JID.
    const action = takePending("8248", {
      conversationId: "554f6079-4d2e-4727-87db-1b1c482fff3d",
      fromOwnZoomSurface: true,
    });
    expect(action?.summary).toBe("test action 8248");
  });

  it("misses on an unknown code even with own-surface proof", () => {
    expect(
      takePending("9999", { conversationId: CHANNEL, fromOwnZoomSurface: true }),
    ).toBeUndefined();
  });
});
