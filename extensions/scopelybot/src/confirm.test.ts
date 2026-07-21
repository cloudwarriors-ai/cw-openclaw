/** Confirm authorization tests ensure shared-channel codes remain actor-bound. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const takePendingMock = vi.fn();
vi.mock("./pending-confirm.js", () => ({
  takePending: (...args: unknown[]) => takePendingMock(...args),
}));

import { isApprovedWriteActor, tryExecuteConfirm } from "./confirm.js";

const logger = vi.fn();
const approver = "Mb4vcQ4YQUaQKJjoY4vntQ";

describe("ScopelyBot confirmation actor gate", () => {
  beforeEach(() => {
    takePendingMock.mockReset();
    logger.mockReset();
  });

  it("normalizes exact opaque sender ids", () => {
    expect(isApprovedWriteActor(approver, [approver.toLowerCase()])).toBe(true);
    expect(isApprovedWriteActor("other", [approver])).toBe(false);
    expect(isApprovedWriteActor(approver, [])).toBe(false);
  });

  it("does not consume a valid code when the same-channel actor is unauthorized", async () => {
    const result = await tryExecuteConfirm({
      text: "CONFIRM 1234",
      actor: "unauthorized-member-id",
      conversationId: "vipbot_prod",
      approverIds: [approver],
      logger,
    });
    expect(result).toContain("not authorized");
    expect(takePendingMock).not.toHaveBeenCalled();
  });

  it("executes once for an approved actor and hides backend failure bodies", async () => {
    takePendingMock.mockReturnValue({
      summary: "unlock user 7",
      run: vi.fn().mockResolvedValue({ ok: false, status: 502, data: { token: "secret" } }),
    });
    const result = await tryExecuteConfirm({
      text: "CONFIRM 1234",
      actor: approver,
      conversationId: "vipbot_prod",
      approverIds: [approver],
      logger,
    });
    expect(takePendingMock).toHaveBeenCalledWith("1234", {
      conversationId: "vipbot_prod",
      fromOwnZoomSurface: false,
    });
    expect(result).toContain("HTTP 502");
    expect(result).not.toContain("secret");
  });

  // Regression for the 2026-07-20 incident: a CONFIRM sent inside a Zoom thread
  // dispatches with the THREAD id as conversationId (never matching the
  // channel-JID-bound pending), but the scopelybot session key proves it arrived
  // through the bot's own Zoom binding — takePending must receive that proof.
  it("marks a threaded CONFIRM from scopelybot's own zoom session as own-surface", async () => {
    takePendingMock.mockReturnValue({
      summary: "reset password for user 47",
      run: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
    });
    const result = await tryExecuteConfirm({
      text: "CONFIRM 8248",
      actor: approver,
      conversationId: "554f6079-4d2e-4727-87db-1b1c482fff3d",
      channelId: "zoom",
      sessionKey: "agent:scopelybot:zoom:channel:554f6079-4d2e-4727-87db-1b1c482fff3d",
      approverIds: [approver],
      logger,
    });
    expect(takePendingMock).toHaveBeenCalledWith("8248", {
      conversationId: "554f6079-4d2e-4727-87db-1b1c482fff3d",
      fromOwnZoomSurface: true,
    });
    expect(result).toContain("✅ Done");
  });

  it("does not treat another agent's zoom session as scopelybot's surface", async () => {
    takePendingMock.mockReturnValue(undefined);
    const result = await tryExecuteConfirm({
      text: "CONFIRM 4321",
      actor: approver,
      conversationId: "some-thread-id",
      channelId: "zoom",
      sessionKey: "agent:pulsebot:zoom:channel:some-thread-id",
      approverIds: [approver],
      logger,
    });
    expect(takePendingMock).toHaveBeenCalledWith("4321", {
      conversationId: "some-thread-id",
      fromOwnZoomSurface: false,
    });
    expect(result).toContain("No pending action");
  });
});
