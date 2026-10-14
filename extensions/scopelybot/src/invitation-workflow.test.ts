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
import { capabilityFor } from "./capability-registry.js";
import { tryExecuteConfirm } from "./confirm.js";
import { noteInboundSender } from "./ops-client.js";
import { takePending } from "./pending-confirm.js";
import { resetInboundSendersForTest } from "./requester-epoch.js";
import { OPS_LOCAL_WRITE_CAPABILITIES } from "./scopely-api.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";

type Tool = {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};
const CHANNEL = "synthetic-channel";
const HUB = `agent:scopelybot:zoom:channel:${CHANNEL}`;
const PENDING = "12345678-1234-4234-9234-123456789abc";
const NATIVE = {
  email: "ops-test-invite@example.invalid",
  first_name: "Synthetic",
  last_name: "Invitee",
  role: "standard",
  organization: 8,
  inviter_user_id: 47,
  surface_key: "vip",
};
const PREVIEW = JSON.stringify({
  inviter_user_id: NATIVE.inviter_user_id,
  organization: NATIVE.organization,
  role: "standard",
  recipient: "[REDACTED_EMAIL]",
  recipient_visibility: "Address hidden; complete current address bound internally",
  effect:
    "Queue one local synthetic invitation; native seven-day lifetime; no inbox delivery or administrator copy",
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
  return JSON.parse((await built.get(name)!.execute("invitation-workflow", args)).content[0].text);
}
function code() {
  return String(send.mock.calls.at(-1)?.[1]).match(/CONFIRM ([a-f0-9]{32})/)![1];
}
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "invitation-workflow-"));
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
      body.capability === "ops.approvers.check"
        ? {
            eligible: options.headers["x-ops-requester-zoom-id"] === "synthetic-admin",
            user_id: 47,
            scope_revision: 1,
          }
        : body.capability === "ops.confirm"
          ? {
              state: "succeeded",
              reconcile_required: false,
              result: { status: "queued", delivery: "local_fake_only" },
            }
          : {
              state: "pending",
              confirmation_required: true,
              pending_action_id: PENDING,
              preview: PREVIEW,
            };
    return new Response(JSON.stringify({ ok: true, capability: body.capability, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  for (const args of send.mock.calls) {
    const value = String(args[1]).match(/CONFIRM ([a-f0-9]{32})/)?.[1];
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

const calls = (capability: string) =>
  request.mock.calls.filter(([, options]) => JSON.parse(options.body).capability === capability);
it("stages exact native invitation args and uses current server roster before one confirmation", async () => {
  const staged = await run("scopely_create_invite", NATIVE);
  expect(staged.staged, JSON.stringify(staged)).toBe(true);
  expect(JSON.parse(calls("identity.invites.create")[0][1].body).args).toEqual(NATIVE);
  expect(send.mock.calls.at(-1)?.[1]).toContain(PREVIEW);
  expect(send.mock.calls.at(-1)?.[1]).not.toContain(NATIVE.email);
  const text = `CONFIRM ${code()}`;
  expect(JSON.stringify(staged)).not.toContain(code());
  const params = { text, actor: "outsider", conversationId: CHANNEL, logger: vi.fn() };
  expect(await tryExecuteConfirm(params)).toContain("not authorized");
  expect(calls("ops.confirm")).toHaveLength(0);
  expect(await tryExecuteConfirm({ ...params, actor: "synthetic-admin" })).toContain("✅ Done");
  expect(await tryExecuteConfirm({ ...params, actor: "synthetic-admin" })).toContain(
    "No pending action",
  );
  expect(calls("ops.confirm")).toHaveLength(1);
  expect(calls("ops.approvers.check").length).toBeGreaterThanOrEqual(2);
  expect(
    request.mock.calls.every(
      ([url]) => new URL(String(url)).pathname.replace(/\/$/, "") === "/api/spine/v1/ops/invoke",
    ),
  ).toBe(true);
  const audit = fs.readFileSync(path.join(workspace, "scopelybot", "audit-v2.jsonl"), "utf8");
  expect(audit).toContain("scopely_create_invite");
  expect(audit).not.toContain(NATIVE.email);
  expect(audit).not.toContain(text);
});
it.each(["prod", "dev"])("%s refuses invitation before transport or prompt", async (env) => {
  profile(env, "read-only");
  expect((await run("scopely_create_invite", NATIVE)).ok).toBe(false);
  expect(request).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it.each(["user", "org_admin", "admin", "staff"])(
  "forwards unsupported %s unchanged for backend refusal, with no legacy fallback",
  async (role) => {
    request.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { code: "invalid_args" } }), { status: 400 }),
    );
    const args = { ...NATIVE, role, confirmed_action_id: "forged" };
    expect((await run("scopely_create_invite", args)).ok).toBe(false);
    expect(JSON.parse(calls("identity.invites.create")[0][1].body).args).toEqual(args);
    expect(request).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  },
);
it("declares local status and exact native transport capability", () => {
  expect(capabilityFor("scopely_create_invite")?.status).toBe("local");
  expect(OPS_LOCAL_WRITE_CAPABILITIES).toContain("identity.invites.create");
});
it("rejects unsafe recipient preview without weakening redaction", async () => {
  request.mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        data: {
          state: "pending",
          confirmation_required: true,
          pending_action_id: PENDING,
          preview: JSON.stringify({ recipient: NATIVE.email }),
        },
      }),
      { status: 200 },
    ),
  );
  expect((await run("scopely_create_invite", NATIVE)).ok).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
it("preserves unknown-outcome reconciliation and never retries confirmation", async () => {
  expect((await run("scopely_create_invite", NATIVE)).staged).toBe(true);
  const text = `CONFIRM ${code()}`;
  const normal = request.getMockImplementation()!;
  request.mockImplementation(async (url, options) =>
    JSON.parse(options.body).capability === "ops.confirm"
      ? new Response("unavailable", { status: 503 })
      : normal(url, options),
  );
  const params = { text, actor: "synthetic-admin", conversationId: CHANNEL, logger: vi.fn() };
  expect(await tryExecuteConfirm(params)).toContain("reconcile");
  expect(await tryExecuteConfirm(params)).toContain("No pending action");
  expect(calls("ops.confirm")).toHaveLength(1);
});
