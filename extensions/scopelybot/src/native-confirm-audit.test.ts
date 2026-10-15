import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyChain } from "../scripts/verify-audit-chain.mjs";
const send = vi.hoisted(() => vi.fn());
vi.mock("./comfort.js", () => ({ sendScopelyText: send, getChannelThreadAnchor: () => undefined }));
vi.mock("./ops-roster-client.js", () => ({ isCurrentApprover: async () => true }));
import { createAuditLogger } from "./audit.js";
import { readAuditRows, auditFile } from "./audit.test-helpers.js";
import { setBackendProfileForTest, readBackendProfile } from "./backend-profile.js";
import { tryExecuteConfirm } from "./confirm.js";
import { stageWrite } from "./gated.js";
import { nativeWriteScope } from "./ops-write-policy.js";
let workspace: string;
beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-confirm-audit-")));
  const codes = path.join(workspace, "codes");
  fs.mkdirSync(codes, { mode: 0o700 });
  vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", codes);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "synthetic-channel");
  setBackendProfileForTest({
    env: "local",
    mode: "read-write",
    baseUrl: "http://127.0.0.1:8100",
    allowedHosts: ["127.0.0.1:8100"],
    authMode: "service-token",
  });
  send.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  setBackendProfileForTest(null);
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});
it.each(["success", "refused", "unknown", "throws"])(
  "stored %s confirmation retains exact backend action and preview digest",
  async (outcome) => {
    const previews = ["first", "second"].map((suffix) =>
      JSON.stringify({
        vendor_key: "canary",
        description: "ordinary words ".repeat(24) + suffix,
        changes: { unit_amount: { before: "10.00", after: "15.00" } },
      }),
    );
    expect(previews[0].slice(0, 256)).toBe(previews[1].slice(0, 256));
    const run = vi.fn(async () => {
      if (outcome === "throws") {
        throw new Error("synthetic transport failure");
      }
      return {
        ok: outcome === "success",
        status: outcome === "success" ? 200 : outcome === "refused" ? 403 : 503,
        data: {},
      };
    });
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    for (let i = 0; i < previews.length; i++) {
      const scope = nativeWriteScope(readBackendProfile(), "synthetic-channel")!;
      await stageWrite(previews[i], run, { scope, pendingActionId: ids[i] });
      const prompt = String(send.mock.calls.at(-1)?.[1]);
      const code = prompt.match(/CONFIRM ([2-9A-HJKMNP-Z]{8})/)![1];
      await tryExecuteConfirm({
        text: `CONFIRM ${code}`,
        actor: "synthetic-human",
        conversationId: "synthetic-channel",
        logger: createAuditLogger(workspace),
      });
    }
    const rows = readAuditRows(workspace).filter(
      (row) => row.event_type === "confirm_ok" || row.event_type === "confirm_error",
    );
    expect(rows).toHaveLength(2);
    rows.forEach((row, i) =>
      expect(row.action).toMatchObject({
        pending_action_id: ids[i],
        preview_sha256: createHash("sha256").update(previews[i]).digest("hex"),
      }),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(verifyChain(fs.readFileSync(auditFile(workspace), "utf8")).ok).toBe(true);
  },
);
