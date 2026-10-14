import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("./comfort.js", () => ({ sendScopelyText: send, getChannelThreadAnchor: () => undefined }));
import { setBackendProfileForTest } from "./backend-profile.js";
import { runInCall, type CallContext } from "./call-context.js";
import { tryExecuteConfirm } from "./confirm.js";
import { noteInboundSender, resetInboundSendersForTest } from "./ops-client.js";
import { opsStageWrite } from "./ops-write-client.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";
const HUB = "agent:scopelybot:zoom:channel:synthetic-channel";
const PENDING = "12345678-1234-4234-9234-123456789abc";
const preview = '{"id":1,"changes":{"label":{"before":"Before","after":"After"}}}';
const context: CallContext = {
  tool: "scopely_update_project_type",
  trigger: "tool",
  requester: { resolved: true, zoom_operator_id: "synthetic-member", source: "ctx", reason: null },
  openclaw: { agent_id: "scopelybot", session_key: HUB, tool_call_id: "local-test" },
  action: {
    tool: "scopely_update_project_type",
    family: "catalog",
    op_class: "write",
    registry_status: "local",
  },
};
const request = vi.fn();
let workspace: string;
let state: string;
function body(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}
function stage() {
  return runInCall(context, () =>
    opsStageWrite("catalog.project_types.update", {
      vendor_key: "ops-test-canary",
      project_type_id: 1,
      label: "After",
    }),
  );
}
function code() {
  return String(send.mock.calls.at(-1)?.[1]).match(/CONFIRM (\d{4})/)![1];
}
function confirm(value = code(), actor = "synthetic-admin", channel = "synthetic-channel") {
  return tryExecuteConfirm({
    text: `CONFIRM ${value}`,
    actor,
    conversationId: channel,
    approverIds: ["synthetic-admin"],
    logger: vi.fn(),
  });
}
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ops-write-"));
  vi.stubEnv("OPENCLAW_WORKSPACE", workspace);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "synthetic-channel");
  setBackendProfileForTest({
    env: "local",
    baseUrl: "http://127.0.0.1:8100",
    allowedHosts: ["127.0.0.1:8100"],
    authMode: "service-token",
    mode: "read-write",
  });
  fs.writeFileSync(
    path.join(workspace, "scopelybot-ops-token"),
    "zwops_0123456789ab_Synthetic_0123456789abcdefABCDEF_xyz",
    { mode: 0o600 },
  );
  resetScopelyGuardForTest();
  resetInboundSendersForTest();
  noteInboundSender(HUB, "synthetic-member");
  state = "succeeded";
  send.mockReset();
  send.mockResolvedValue(undefined);
  request.mockReset();
  request.mockImplementation(async (_url, options) => {
    const input = JSON.parse(options.body);
    return new Response(
      JSON.stringify({
        ok: true,
        data:
          input.capability === "ops.confirm"
            ? {
                state,
                result: { changed: { label: "After" } },
                reconcile_required: state === "claimed",
              }
            : {
                state: "pending",
                confirmation_required: true,
                pending_action_id: PENDING,
                preview,
              },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  setBackendProfileForTest(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(workspace, { recursive: true, force: true });
});
it("stages exact preview then uses trusted confirmer with no replay", async () => {
  const result = body(await stage());
  expect(result.staged, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(PENDING);
  expect(JSON.stringify(result)).not.toContain(code());
  expect(send.mock.calls[0][1]).toContain(preview);
  expect(send.mock.calls[0][1]).toContain("LOCAL SYNTHETIC DATA");
  expect(request).toHaveBeenCalledTimes(1);
  const confirmation = code();
  expect(await confirm(confirmation)).toContain("✅ Done");
  const opts = request.mock.calls[1][1];
  expect(new Headers(opts.headers).get("x-ops-requester-zoom-id")).toBe("synthetic-admin");
  expect(new Headers(opts.headers).get("x-ops-surface")).toBe("synthetic-channel");
  expect(JSON.parse(opts.body).args).toEqual({ pending_action_id: PENDING });
  expect(await confirm(confirmation)).toContain("No pending action");
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(["failed", "claimed", "pending", "cancelled"])(
  "does not report HTTP200 %s as success",
  async (value) => {
    state = value;
    await stage();
    const result = await confirm();
    expect(result).not.toContain("✅ Done");
    if (value === "claimed") {
      expect(result).toContain("reconcile");
    }
    expect(request).toHaveBeenCalledTimes(2);
  },
);
it.each(["sender", "channel", "readonly", "prod", "dev"])(
  "refuses %s before network",
  async (reason) => {
    if (reason === "sender") {
      noteInboundSender(HUB, "different-sender");
    }
    if (reason === "channel") {
      vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "");
    }
    if (reason === "readonly") {
      setBackendProfileForTest({
        env: "local",
        baseUrl: "http://127.0.0.1:8100",
        allowedHosts: ["127.0.0.1:8100"],
        mode: "read-only",
      });
    }
    if (reason === "prod") {
      setBackendProfileForTest({
        env: "prod",
        baseUrl: "https://api.vip.pscx.ai",
        allowedHosts: ["api.vip.pscx.ai"],
        mode: "read-only",
      });
    }
    if (reason === "dev") {
      setBackendProfileForTest({ mode: "read-write" });
    }
    expect(body(await stage()).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);
it("refuses unauthorized and wrong-channel confirmations without consuming", async () => {
  await stage();
  const c = code();
  expect(await confirm(c, "outsider")).toContain("not authorized");
  expect(await confirm(c, "synthetic-admin", "different-channel")).toContain("No pending action");
  expect(request).toHaveBeenCalledTimes(1);
  expect(await confirm(c)).toContain("✅ Done");
});
it("invalidates an ambiguously delivered prompt without claiming staging or retrying", async () => {
  send.mockRejectedValueOnce(new Error("delivery unknown"));
  expect(body(await stage()).ok).toBe(false);
  expect(await confirm()).toContain("No pending action");
  expect(request).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});
it("channel drift after staging cannot confirm", async () => {
  await stage();
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "different-channel");
  expect(await confirm()).not.toContain("✅ Done");
  expect(request).toHaveBeenCalledTimes(1);
});
