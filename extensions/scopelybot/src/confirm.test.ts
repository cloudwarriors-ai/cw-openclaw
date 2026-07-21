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

// Live gap 2026-07-21: a category-validation 400 ("UCaaS — Base" isn't a real
// category) surfaced as a bare "Failed (HTTP 400)" — the human had to read
// server code to learn why. 4xx bodies now surface redacted; 5xx stay hidden
// (the test above pins that).
describe("backend error detail on 4xx", () => {
  beforeEach(() => {
    takePendingMock.mockReset();
    logger.mockReset();
  });

  it("surfaces the DRF validation message on a 400 (the live pricing-item shape)", async () => {
    takePendingMock.mockReturnValue({
      summary: "create pricing item chad_test_price_item on goto/pt 9 @ 1.00",
      run: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        data: {
          category: [
            "Category must be one of: Core, Call Routing, Hardware & Paging, Porting, " +
              "SBC / PBX, SSO, Integrations, Training, Go-Live, T&M, Order Minimum. " +
              "Got 'UCaaS — Base'.",
          ],
        },
      }),
    });
    const result = await tryExecuteConfirm({
      text: "CONFIRM 1234",
      actor: approver,
      conversationId: "vipbot_prod",
      approverIds: [approver],
      logger,
    });
    expect(result).toContain("HTTP 400");
    expect(result).toContain("Category must be one of");
    expect(result).toContain("Got 'UCaaS — Base'");
  });

  it("drops HTML error pages instead of relaying markup", async () => {
    takePendingMock.mockReturnValue({
      summary: "update pricing item 5",
      run: vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, data: "<html><body>Not Found</body></html>" }),
    });
    const result = await tryExecuteConfirm({
      text: "CONFIRM 1234",
      actor: approver,
      conversationId: "vipbot_prod",
      approverIds: [approver],
      logger,
    });
    expect(result).toContain("HTTP 404");
    expect(result).not.toContain("<html>");
  });
});
