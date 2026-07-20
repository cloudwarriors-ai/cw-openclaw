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
    expect(takePendingMock).toHaveBeenCalledWith("1234", "vipbot_prod");
    expect(result).toContain("HTTP 502");
    expect(result).not.toContain("secret");
  });
});
