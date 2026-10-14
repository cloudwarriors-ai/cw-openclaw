// This domain fixture supplies explicit server eligibility; roster authority is tested separately.
vi.mock("./ops-roster-client.js", () => ({
  isCurrentApprover: async (actor: string) => ["synthetic-admin"].includes(actor),
}));
// Real plugin/registry/audit/Zoom confirmation with a mocked HTTP boundary.
// Native reference, money and transaction behavior is tested on PostgreSQL.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("./comfort.js", () => ({
  sendScopelyText: send,
  getChannelThreadAnchor: () => undefined,
  rememberChannelThreadAnchor: () => {},
  resolveInboundThreadAnchor: () => undefined,
  sendComfortMessage: () => Promise.resolve(),
}));
import plugin from "../index.js";
import { tryExecuteConfirm } from "./confirm.js";
import { noteInboundSender } from "./ops-client.js";
import { takePending } from "./pending-confirm.js";
import { resetInboundSendersForTest } from "./requester-epoch.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";

type Tool = {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};
const CHANNEL = "synthetic-channel";
const HUB = `agent:scopelybot:zoom:channel:${CHANNEL}`;
const PENDING = "12345678-1234-4234-9234-123456789abc";
const NATIVE = { vendor_key: "ops-test-canary", pricing_key: "ops_test_discard" };
const PREVIEW = JSON.stringify({
  operation: "remove_from_successor",
  removed: NATIVE,
  history_retained: true,
});
const request = vi.fn();
let workspace: string;
function profile(env = "local", mode = "read-write") {
  fs.writeFileSync(
    path.join(workspace, "scopelybot-backend.json"),
    JSON.stringify({
      env,
      mode,
      baseUrl: "http://127.0.0.1:8100",
      allowedHosts: ["127.0.0.1:8100"],
      authMode: "service-token",
    }),
  );
  resetScopelyGuardForTest();
}
function tools() {
  const built = new Map<string, Tool>();
  const ctx = {
    agentId: "scopelybot",
    sessionKey: HUB,
    requesterSenderId: "synthetic-admin",
    requesterRunStartedAt: performance.now(),
  };
  const api = {
    registerTool: (factory: (ctx: unknown) => Tool | Tool[]) => {
      const result = factory(ctx);
      for (const tool of Array.isArray(result) ? result : [result]) {
        built.set(tool.name, tool);
      }
    },
    on: () => {},
    registerHook: () => {},
  } as never;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    plugin.register(api, { writeApproverIds: ["synthetic-admin"] });
  } finally {
    log.mockRestore();
  }
  return built;
}
async function run(name: string, args: Record<string, unknown>, built = tools()) {
  return JSON.parse((await built.get(name)!.execute("pricing-delete", args)).content[0].text);
}
function code() {
  return String(send.mock.calls.at(-1)?.[1])
    .match(/CONFIRM ([a-f0-9]{32}|[2-9a-hjkmnp-z]{8})\b/i)![1]
    .toLowerCase();
}
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-delete-"));
  const codeDir = path.join(fs.realpathSync(workspace), "confirmation-codes");
  fs.mkdirSync(codeDir, { mode: 0o700 });
  vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", codeDir);
  vi.stubEnv("OPENCLAW_WORKSPACE", workspace);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", CHANNEL);
  profile();
  fs.writeFileSync(
    path.join(workspace, "scopelybot-ops-token"),
    "zwops_0123456789ab_Delete_0123456789abcdefABCDEF_xyz",
    { mode: 0o600 },
  );
  resetInboundSendersForTest();
  noteInboundSender(HUB, "synthetic-admin");
  send.mockReset();
  send.mockResolvedValue(undefined);
  request.mockReset();
  request.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    const data =
      body.capability === "pricing.defaults.list"
        ? { items: [NATIVE] }
        : body.capability === "ops.confirm"
          ? {
              state: "succeeded",
              reconcile_required: false,
              result: { version: 2, history_retained: true },
            }
          : {
              state: "pending",
              confirmation_required: true,
              pending_action_id: PENDING,
              preview: PREVIEW,
            };
    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  for (const args of send.mock.calls) {
    const value = String(args[1])
      .match(/CONFIRM ([a-f0-9]{32}|[2-9a-hjkmnp-z]{8})\b/i)?.[1]
      ?.toLowerCase();
    if (value) {
      takePending(value, { conversationId: CHANNEL });
    }
  }
  resetInboundSendersForTest();
  resetScopelyGuardForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});
it("discovers the native key, previews, refuses outsider confirmation, then confirms once", async () => {
  const built = tools();
  const listed = await run(
    "scopely_list_pricing_items",
    { vendor_key: NATIVE.vendor_key, scope_mode: "all" },
    built,
  );
  expect(JSON.stringify(listed)).toContain(NATIVE.pricing_key);
  const staged = await run("scopely_delete_pricing_item", NATIVE, built);
  expect(staged.staged).toBe(true);
  expect(JSON.parse(request.mock.calls[1][1].body)).toMatchObject({
    capability: "pricing.items.delete",
    args: NATIVE,
  });
  for (const value of Object.values(JSON.parse(PREVIEW))) {
    expect(send.mock.calls.at(-1)?.[1]).toContain(JSON.stringify(value));
  }
  expect(JSON.stringify(staged)).not.toContain(code());
  const text = `CONFIRM ${code()}`;
  const params = {
    text,
    actor: "outsider",
    conversationId: CHANNEL,
    logger: vi.fn(),
  };
  expect(await tryExecuteConfirm(params)).toContain("not authorized");
  expect(request).toHaveBeenCalledTimes(2);
  expect(await tryExecuteConfirm({ ...params, actor: "synthetic-admin" })).toContain("✅ Done");
  expect(await tryExecuteConfirm({ ...params, actor: "synthetic-admin" })).toContain(
    "No pending action",
  );
  expect(request).toHaveBeenCalledTimes(3);
  expect(
    request.mock.calls.every(
      ([url]) => new URL(String(url)).pathname.replace(/\/$/, "") === "/api/spine/v1/ops/invoke",
    ),
  ).toBe(true);
});
it.each(["prod", "dev"])("%s profile refuses deletion before any request", async (env) => {
  profile(env, "read-only");
  expect((await run("scopely_delete_pricing_item", NATIVE)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it("passes unsupported old IDs intact for native refusal without a legacy DELETE fallback", async () => {
  request.mockResolvedValue(
    new Response(JSON.stringify({ ok: false, error: { code: "invalid_args" } }), { status: 400 }),
  );
  const args = { ...NATIVE, project_type_id: 3, id: 8 };
  expect((await run("scopely_delete_pricing_item", args)).ok).toBe(false);
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
    capability: "pricing.items.delete",
    args,
  });
  expect(request).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
});
