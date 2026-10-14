// Actual registration, guarded HTTP, awaited human hook and audit; fake server only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("./comfort.js", () => ({
  sendScopelyText: send,
  getChannelThreadAnchor: () => undefined,
  rememberChannelThreadAnchor: () => {},
  resolveInboundThreadAnchor: () => undefined,
  sendComfortMessage: async () => {},
}));
import plugin from "../index.js";
import { readAuditRows } from "./audit.test-helpers.js";
import { noteInboundSender } from "./ops-client.js";
import { takePending } from "./pending-confirm.js";
import { resetInboundSendersForTest } from "./requester-epoch.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";
type Tool = {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};
type Hook = (
  event: { content: string },
  ctx: Record<string, string>,
) => Promise<{ handled: boolean; text?: string } | undefined>;
const CHANNEL = "synthetic-channel";
const SESSION = `agent:scopelybot:zoom:channel:${CHANNEL}`;
const ADMIN = "synthetic-admin",
  OTHER = "synthetic-other";
let workspace: string;
const request = vi.fn();
const approvals = new Set<string>();
const pending = new Map<string, string>();
let businessEffects = 0;
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
function registered(actor = ADMIN) {
  noteInboundSender(SESSION, actor);
  const built = new Map<string, Tool>(),
    hooks: Hook[] = [];
  const context = {
    agentId: "scopelybot",
    sessionKey: SESSION,
    requesterSenderId: actor,
    requesterRunStartedAt: performance.now(),
  };
  plugin.register(
    {
      registerTool: (factory: (ctx: unknown) => Tool | Tool[]) => {
        const result = factory(context);
        for (const tool of Array.isArray(result) ? result : [result]) {
          built.set(tool.name, tool);
        }
      },
      on: (name: string, fn: Hook) => {
        if (name === "before_dispatch") {
          hooks.push(fn);
        }
      },
      registerHook: () => {},
    } as never,
    { writeApproverIds: [OTHER] },
  ); // Deliberately obsolete and contradictory.
  return {
    built,
    async confirm(actorId: string, text: string) {
      for (const hook of hooks) {
        const result = await hook(
          { content: text },
          { channelId: "zoom", conversationId: CHANNEL, sessionKey: SESSION, senderId: actorId },
        );
        if (result?.handled) {
          return result.text;
        }
      }
      throw new Error("CONFIRM not claimed");
    },
  };
}
async function run(name: string, args: Record<string, unknown>, r = registered()) {
  return JSON.parse((await r.built.get(name)!.execute("roster-call", args)).content[0].text);
}
function code() {
  return String(send.mock.calls.at(-1)?.[1])
    .match(/CONFIRM ([a-f0-9]{32}|[2-9a-hjkmnp-z]{8})\b/i)![1]
    .toLowerCase();
}
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "roster-tools-"));
  const codeDir = path.join(fs.realpathSync(workspace), "confirmation-codes");
  fs.mkdirSync(codeDir, { mode: 0o700 });
  vi.stubEnv("SCOPELYBOT_CONFIRM_CODE_DIR", codeDir);
  vi.stubEnv("OPENCLAW_WORKSPACE", workspace);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", CHANNEL);
  profile();
  fs.writeFileSync(
    path.join(workspace, "scopelybot-ops-token"),
    "zwops_0123456789ab_Roster_0123456789abcdefABCDEF_xyz",
    { mode: 0o600 },
  );
  resetInboundSendersForTest();
  send.mockReset().mockResolvedValue(undefined);
  approvals.clear();
  approvals.add(ADMIN);
  pending.clear();
  businessEffects = 0;
  request.mockReset().mockImplementation(async (_url, options) => {
    const { capability, args } = JSON.parse(options.body);
    const actor = new Headers(options.headers).get("x-ops-requester-zoom-id")!;
    let data: unknown;
    if (capability === "ops.approvers.check") {
      data = {
        eligible: approvals.has(actor),
        user_id: actor === ADMIN ? 1 : 2,
        scope_revision: 1,
      };
    } else if (capability === "ops.approvers.list") {
      data = {
        items: [...approvals].map((id) => ({
          user_id: id === ADMIN ? 1 : 2,
          seeded: id === ADMIN,
          active: true,
          revision: 1,
        })),
        total: approvals.size,
        next_offset: null,
        truncated: false,
      };
    } else if (capability === "ops.confirm") {
      if (!approvals.has(actor)) {
        return new Response(JSON.stringify({ ok: false }), { status: 403 });
      }
      const operation = pending.get(args.pending_action_id);
      if (operation === "ops.approvers.grant") {
        approvals.add(OTHER);
      } else if (operation === "ops.approvers.revoke") {
        approvals.delete(OTHER);
      } else {
        businessEffects++;
      }
      pending.delete(args.pending_action_id);
      data = { state: "succeeded", reconcile_required: false, result: { changed: true } };
    } else {
      if (
        capability.startsWith("ops.approvers.") &&
        (args.email !== "other@example.invalid" || Object.keys(args).length !== 1)
      ) {
        return new Response(JSON.stringify({ ok: false }), { status: 400 });
      }
      const id = `12345678-1234-4234-9234-${String(request.mock.calls.length).padStart(12, "0")}`;
      pending.set(id, capability);
      data = {
        state: "pending",
        confirmation_required: true,
        pending_action_id: id,
        preview: JSON.stringify({
          capability,
          user_id: 2,
          zoom_id: OTHER,
          effect: "Approval eligibility only; no application roles",
        }),
      };
    }
    return new Response(JSON.stringify({ ok: true, capability, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", request);
  vi.spyOn(console, "log").mockImplementation(() => {});
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
it("grant, real human hook, business confirmation, revoke and immediate refusal preserve codes and audit", async () => {
  let r = registered();
  const staged = await run("scopely_grant_approver", { email: "other@example.invalid" }, r);
  expect(staged.staged).toBe(true);
  expect(approvals.has(OTHER)).toBe(false);
  const text = `CONFIRM ${code()}`;
  expect(JSON.stringify(staged)).not.toContain(code());
  expect(await r.confirm(OTHER, text)).toContain("not authorized");
  expect(await r.confirm(ADMIN, text)).toContain("✅ Done");
  expect(approvals.has(OTHER)).toBe(true);
  r = registered(OTHER);
  expect((await run("scopely_unlock_user", { user_id: 2 }, r)).staged).toBe(true);
  expect(await r.confirm(OTHER, `CONFIRM ${code()}`)).toContain("✅ Done");
  expect(businessEffects).toBe(1);
  r = registered();
  await run("scopely_revoke_approver", { email: "other@example.invalid" }, r);
  expect(await r.confirm(ADMIN, `CONFIRM ${code()}`)).toContain("✅ Done");
  await run("scopely_unlock_user", { user_id: 2 }, r);
  const businessCode = `CONFIRM ${code()}`;
  expect(await r.confirm(OTHER, businessCode)).toContain("not authorized");
  expect(await r.confirm(ADMIN, businessCode)).toContain("✅ Done");
  expect(businessEffects).toBe(2);
  const rows = readAuditRows(workspace);
  expect(rows.some((row) => row.trigger === "confirm")).toBe(true);
  const confirms = request.mock.calls.filter(
    ([, o]) => JSON.parse(o.body).capability === "ops.confirm",
  );
  expect(confirms).toHaveLength(4);
  for (const [, o] of confirms) {
    expect(new Headers(o.headers).get("x-ops-bot-audit-id")).toBeTruthy();
  }
});
it("native roster listing is server data; model-selected scope/identity fields remain rejected intact", async () => {
  expect((await run("scopely_list_approvers", {})).data.items).toEqual([
    { user_id: 1, seeded: true, active: true, revision: 1 },
  ]);
  const args = { email: "other@example.invalid", principal_id: 999, actor: OTHER };
  expect((await run("scopely_grant_approver", args)).ok).toBe(false);
  expect(JSON.parse(request.mock.calls.at(-1)![1].body).args).toEqual(args);
  expect(send).not.toHaveBeenCalled();
});
it.each(["prod", "dev"])("%s refuses all roster tools before transport", async (env) => {
  profile(env, "read-only");
  const r = registered();
  for (const tool of [
    "scopely_list_approvers",
    "scopely_grant_approver",
    "scopely_revoke_approver",
  ]) {
    expect((await run(tool, { email: "other@example.invalid" }, r)).ok).toBe(false);
  }
  expect(request).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
