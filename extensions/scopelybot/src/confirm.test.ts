/**
 * Confirm authorization tests ensure shared-channel codes remain actor-bound,
 * and that a CONFIRM runs nothing unless the live backend profile is
 * read-write (PK-7a: the kill switch and read-only also stop staged actions).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const eligibilityMock = vi.hoisted(() => vi.fn());
vi.mock("./ops-roster-client.js", () => ({ isCurrentApprover: eligibilityMock }));
const takePendingMock = vi.fn();
vi.mock("./pending-confirm.js", () => ({
  takePending: (...args: unknown[]) => takePendingMock(...args),
}));

import { createAuditLogger } from "./audit.js";
import { readAuditRows } from "./audit.test-helpers.js";
import { setBackendProfileForTest } from "./backend-profile.js";
import { tryExecuteConfirm } from "./confirm.js";

// Most tests exercise the CONFIRM execution path, which only exists while the
// live backend profile is read-write (dev-only); the read-only block resets it.
setBackendProfileForTest({ mode: "read-write" });

const logger = vi.fn();
const approver = "Mb4vcQ4YQUaQKJjoY4vntQ";

describe("ScopelyBot confirmation actor gate", () => {
  beforeEach(() => {
    eligibilityMock
      .mockReset()
      .mockImplementation(async (actor: string) => actor.toLowerCase() === approver.toLowerCase());
    takePendingMock.mockReset();
    logger.mockReset();
  });

  it("server refusal cannot consume a code even for the formerly configured actor", async () => {
    eligibilityMock.mockResolvedValue(false);
    const result = await tryExecuteConfirm({
      text: `CONFIRM ${"a".repeat(32)}`,
      actor: approver,
      conversationId: "vipbot_prod",
      logger,
    });
    expect(result).toContain("not authorized");
    expect(takePendingMock).not.toHaveBeenCalled();
  });

  it("profile changes while awaiting eligibility cannot consume a code", async () => {
    eligibilityMock.mockImplementation(async () => {
      setBackendProfileForTest({ mode: "read-only" });
      return true;
    });
    try {
      expect(
        await tryExecuteConfirm({
          text: `CONFIRM ${"a".repeat(32)}`,
          actor: approver,
          conversationId: "vipbot_prod",
          logger,
        }),
      ).toContain("read-only");
      expect(takePendingMock).not.toHaveBeenCalled();
    } finally {
      setBackendProfileForTest({ mode: "read-write" });
    }
  });

  it("reports callback exceptions as unknown without logging arbitrary exception text", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unpatterned private customer detail"));
    takePendingMock.mockReturnValue({ summary: "unlock user 7", run });
    const result = await tryExecuteConfirm({
      text: "CONFIRM 12341234123412341234123412341234",
      actor: approver,
      conversationId: "vipbot_prod",
      logger,
    });
    expect(result).toMatch(/outcome unknown/i);
    expect(result).toMatch(/do not retry/i);
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("unpatterned private");
    expect(logger.mock.calls[0][0].resultSummary).toBe("outcome_unknown");
  });

  it.each([
    { ok: false, status: 503, data: {} },
    { ok: false, status: 409, data: { code: "outcome_unknown" } },
    {
      ok: false,
      status: 400,
      data: {
        bundle: true,
        applied: 1,
        results: [
          { ok: false, status: 400, summary: "refused" },
          { ok: false, status: 502, summary: "uncertain" },
          { ok: true, status: 200, summary: "applied" },
        ],
      },
    },
  ])(
    "persists returned uncertainty as a confirmation error through the real logger",
    async (response) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "confirm-audit-"));
      try {
        takePendingMock.mockReturnValue({
          summary: "synthetic change",
          run: vi.fn().mockResolvedValue(response),
        });
        await tryExecuteConfirm({
          text: "CONFIRM 12341234123412341234123412341234",
          actor: approver,
          conversationId: "vipbot_prod",
          logger: createAuditLogger(dir),
        });
        const event = readAuditRows(dir).at(-1)!;
        expect(event.event_type).toBe("confirm_error");
        expect(event.result.status).toBe("error");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("does not consume a valid code when the same-channel actor is unauthorized", async () => {
    const result = await tryExecuteConfirm({
      text: "CONFIRM 12341234123412341234123412341234",
      actor: "unauthorized-member-id",
      conversationId: "vipbot_prod",
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
      text: "CONFIRM 12341234123412341234123412341234",
      actor: approver,
      conversationId: "vipbot_prod",
      logger,
    });
    expect(takePendingMock).toHaveBeenCalledWith("12341234123412341234123412341234", {
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
      text: "CONFIRM 82488248824882488248824882488248",
      actor: approver,
      conversationId: "554f6079-4d2e-4727-87db-1b1c482fff3d",
      channelId: "zoom",
      sessionKey: "agent:scopelybot:zoom:channel:554f6079-4d2e-4727-87db-1b1c482fff3d",
      logger,
    });
    expect(takePendingMock).toHaveBeenCalledWith("82488248824882488248824882488248", {
      conversationId: "554f6079-4d2e-4727-87db-1b1c482fff3d",
      fromOwnZoomSurface: true,
    });
    expect(result).toContain("✅ Done");
  });

  it("does not treat another agent's zoom session as scopelybot's surface", async () => {
    takePendingMock.mockReturnValue(undefined);
    const result = await tryExecuteConfirm({
      text: "CONFIRM 43214321432143214321432143214321",
      actor: approver,
      conversationId: "some-thread-id",
      channelId: "zoom",
      sessionKey: "agent:pulsebot:zoom:channel:some-thread-id",
      logger,
    });
    expect(takePendingMock).toHaveBeenCalledWith("43214321432143214321432143214321", {
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
    eligibilityMock
      .mockReset()
      .mockImplementation(async (actor: string) => actor.toLowerCase() === approver.toLowerCase());
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
      text: "CONFIRM 12341234123412341234123412341234",
      actor: approver,
      conversationId: "vipbot_prod",
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
      text: "CONFIRM 12341234123412341234123412341234",
      actor: approver,
      conversationId: "vipbot_prod",
      logger,
    });
    expect(result).toContain("HTTP 404");
    expect(result).not.toContain("<html>");
  });
});

describe("read-only refusal before the pending store (INV-2, INV-8)", () => {
  const run = vi.fn();
  let workspace: string;

  beforeEach(() => {
    eligibilityMock
      .mockReset()
      .mockImplementation(async (actor: string) => actor.toLowerCase() === approver.toLowerCase());
    takePendingMock.mockReset();
    takePendingMock.mockReturnValue({ summary: "unlock user 7", run });
    run.mockReset();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "confirm-ro-"));
    process.env.OPENCLAW_WORKSPACE = workspace;
  });
  afterEach(() => {
    setBackendProfileForTest({ mode: "read-write" });
    delete process.env.OPENCLAW_WORKSPACE;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it.each([
    ["read-only", () => setBackendProfileForTest({ mode: "read-only" })],
    ["off (kill switch thrown after staging)", () => setBackendProfileForTest({ mode: "off" })],
    ["missing profile file (fail-closed default)", () => setBackendProfileForTest(null)],
  ])("profile %s: an approver's CONFIRM neither consumes nor runs the action", async (_l, set) => {
    set();
    const result = await tryExecuteConfirm({
      text: "CONFIRM 12341234123412341234123412341234",
      actor: approver,
      conversationId: "vipbot_prod",
      logger,
    });
    expect(result).toBe("Changes are paused: the bot is read-only, so nothing was run.");
    expect(takePendingMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    const rows = fs
      .readFileSync(path.join(workspace, "scopelybot", "audit-v2.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({
      event_type: "write_blocked_read_only",
      detail: { via: "confirm" },
    });
  });

  it("read-only refusal precedes remote eligibility for every actor", async () => {
    eligibilityMock.mockClear();
    setBackendProfileForTest({ mode: "read-only" });
    const result = await tryExecuteConfirm({
      text: "CONFIRM 12341234123412341234123412341234",
      actor: "someone-else",
      conversationId: "vipbot_prod",
      logger,
    });
    expect(result).toContain("read-only");
    expect(eligibilityMock).not.toHaveBeenCalled();
    expect(takePendingMock).not.toHaveBeenCalled();
  });
});
