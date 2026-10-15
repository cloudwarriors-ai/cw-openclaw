vi.mock("./ops-roster-client.js", () => ({ isCurrentApprover: async () => true }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { setBackendProfileForTest } from "./backend-profile.js";
import { isConfirmCommand, tryExecuteConfirm } from "./confirm.js";
import { formatNativePreview } from "./confirmation-preview.js";
import { putPending, takePending } from "./pending-confirm.js";

afterEach(() => setBackendProfileForTest(null));

describe("release confirmation boundary", () => {
  it.each([
    "Confirm the current seat price",
    "confirm pricing is correct",
    "CONFIRM",
    "CONFIRM 1234",
    "CONFIRM 23456789 trailing",
  ])("keeps ordinary or malformed prose out of deterministic code execution: %s", (text) => {
    expect(isConfirmCommand(text)).toBe(false);
  });
  it.each(["CONFIRM 23456789", "confirm abcdefgh", `CONFIRM ${"a".repeat(32)}`])(
    "recognizes an exact supported confirmation: %s",
    (text) => {
      expect(isConfirmCommand(text)).toBe(true);
    },
  );
  it("cannot use another channel with the same bot session prefix to consume a code", async () => {
    setBackendProfileForTest({ mode: "read-write" });
    const code = "23456789";
    const run = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    putPending({ code, conversationId: "allowed-channel", summary: "exact change", run });
    expect(
      await tryExecuteConfirm({
        text: `CONFIRM ${code}`,
        actor: "human",
        channelId: "zoom",
        sessionKey: "agent:scopelybot:zoom:channel:other",
        conversationId: "other-channel",
        logger: vi.fn(),
      }),
    ).toContain("No pending action");
    expect(run).not.toHaveBeenCalled();
    expect(takePending(code, { conversationId: "allowed-channel" })?.run).toBe(run);
  });
  it("shows native project/deployment target identities with readable labels", () => {
    const display = formatNativePreview(
      JSON.stringify({
        vendor_key: "vendor-a",
        project_type: "project-a",
        project_label: "Project A",
        key: "remote",
        label: "Remote",
        changes: { sort_order: { before: 1, after: 2 } },
      }),
    );
    expect(display).toContain('Project type: "project-a"');
    expect(display).toContain('Project label: "Project A"');
    expect(display).toContain('Key: "remote"');
    expect(display).toContain('Label: "Remote"');
  });
});
