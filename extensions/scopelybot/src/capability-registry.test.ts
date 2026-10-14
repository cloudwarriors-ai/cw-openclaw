// Capability-registry tests (capability-registry.ts + the index.ts wrapper,
// PK-7a). Pins AC-7.2 (every registered tool has a row, derived dynamically
// from register(), plus the manifest's tool contracts) and AC-7.4 (blocked
// tools and read-only staging answer from the registry with the family's
// tracking link and manual path, with no network call, no CONFIRM prompt and
// nothing in the pending store).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendScopelyTextMock = vi.fn();
vi.mock("./comfort.js", () => ({
  sendScopelyText: (...args: unknown[]) => sendScopelyTextMock(...args),
  getChannelThreadAnchor: () => undefined,
  rememberChannelThreadAnchor: () => {},
  resolveInboundThreadAnchor: () => undefined,
  sendComfortMessage: () => Promise.resolve(),
}));
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));
const putPendingMock = vi.fn();
const makeCodeMock = vi.fn(() => "1234");
vi.mock("./pending-confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pending-confirm.js")>()),
  putPending: (...args: unknown[]) => putPendingMock(...args),
  makeCode: () => makeCodeMock(),
}));

import plugin from "../index.js";
import { correlatedId, readAuditRows, testCall } from "./audit.test-helpers.js";
import { runInCall } from "./call-context.js";
import {
  applyCapabilityRegistry,
  capabilityFor,
  opsBindingFor,
  registryTools,
} from "./capability-registry.js";
import { stageWrite } from "./gated.js";
import { noteInboundSender } from "./ops-client.js";
import { type JsonSchema, SNAPSHOT, validate } from "./ops-kernel.test-helpers.js";
import { registerPassthroughTools } from "./passthrough-tools.js";
import { resetInboundSendersForTest } from "./requester-epoch.js";
import { OPS_READ_CAPABILITIES, resetScopelyGuardForTest } from "./scopely-api.js";

type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: { text: string }[] }>;
};

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const F7_LINK = "https://github.com/cloudwarriors-ai/cw-openclaw/issues/7007";
const DEV = {
  env: "dev",
  baseUrl: "http://100.114.142.100:8022",
  allowedHosts: ["100.114.142.100:8022"],
};
const fetchMock = vi.fn();
let workspace: string;

function writeProfile(body: Record<string, unknown>) {
  fs.writeFileSync(path.join(workspace, "scopelybot-backend.json"), JSON.stringify(body));
}

const REGISTRY_TOKEN = "zwops_00112233aabb_registry-test-token_0123456789abcdef";

// The prod profile with the operator layer's service token, and a kernel
// envelope as every answer.
function useServiceToken() {
  writeProfile({
    env: "prod",
    baseUrl: "https://api.vip.pscx.ai",
    allowedHosts: ["api.vip.pscx.ai"],
    authMode: "service-token",
  });
  fs.writeFileSync(path.join(workspace, "scopelybot-ops-token"), REGISTRY_TOKEN, { mode: 0o600 });
  fetchMock.mockImplementation(
    async () =>
      new Response('{"ok":true,"request_id":"r1","data":{"status":"ok"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

// Register the real plugin and build every tool its factories produce: the
// tool list comes from registration itself, never from a hand-kept copy.
let banner = "";

const DEFAULT_CTX = {
  agentId: "scopelybot",
  sessionKey: "agent:scopelybot:zoom:x",
  requesterSenderId: "operator_123",
};

function registeredTools(ctx: unknown = DEFAULT_CTX): {
  tools: Map<string, Tool>;
  optional: boolean[];
  names: string[];
} {
  const toolContext = { requesterRunStartedAt: performance.now(), ...(ctx as object) };
  const tools = new Map<string, Tool>();
  const names: string[] = [];
  const optional: boolean[] = [];
  const api = {
    registerTool: (factory: (ctx: unknown) => Tool | Tool[], opts?: { optional?: boolean }) => {
      optional.push(opts?.optional === true);
      const built = factory(toolContext);
      for (const tool of Array.isArray(built) ? built : [built]) {
        names.push(tool.name);
        tools.set(tool.name, tool);
      }
    },
    on: () => {},
    registerHook: () => {},
  } as never;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    plugin.register(api, { writeApproverIds: [] });
    banner = log.mock.calls.map((args) => String(args[0])).join("\n");
  } finally {
    log.mockRestore();
  }
  return { tools, optional, names };
}

const auditRows = () => readAuditRows(workspace);

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capability-registry-"));
  process.env.OPENCLAW_WORKSPACE = workspace;
  process.env.SCOPELYBOT_ZOOM_CHANNEL = "chan@conference.xmpp.zoom.us";
  writeProfile({
    env: "prod",
    baseUrl: "https://api.vip.pscx.ai",
    allowedHosts: ["api.vip.pscx.ai"],
    issueLinks: { F7: F7_LINK },
  });
  resetScopelyGuardForTest();
  resetInboundSendersForTest();
  noteInboundSender(DEFAULT_CTX.sessionKey, DEFAULT_CTX.requesterSenderId);
  for (const mock of [
    sendScopelyTextMock,
    execFileSyncMock,
    putPendingMock,
    makeCodeMock,
    fetchMock,
  ]) {
    mock.mockClear();
  }
  fetchMock.mockImplementation(
    async () =>
      new Response('{"status":"ok"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCLAW_WORKSPACE;
  delete process.env.SCOPELYBOT_ZOOM_CHANNEL;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("registry completeness (AC-7.2)", () => {
  it("every registered tool and every manifest contract has exactly one row, and no row is stale", () => {
    const { tools, optional, names } = registeredTools();
    const registered = [...tools.keys()];
    // A name registered twice would inherit the first row's live/local status
    // for a different implementation, and the Map above would hide it.
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const rows = registryTools();
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "openclaw.plugin.json"), "utf8"))
      .contracts.tools as string[];

    expect(registered.length).toBe(121);
    expect(optional.every(Boolean)).toBe(true);
    // The startup banner (deploy runbooks grep "Registered .* tools") counts
    // the registry, not a hand-kept number.
    expect(banner).toContain("[scopelybot] Registered 121 tools (13 live/local on the new app;");
    expect(new Set(rows).size).toBe(rows.length); // no tool in two families
    expect(registered.filter((t) => !capabilityFor(t))).toEqual([]);
    expect(manifest.filter((t) => !capabilityFor(t))).toEqual([]);
    expect(rows.filter((t) => !tools.has(t))).toEqual([]);
    // The manifest is a subset of the registry; its one known gap (pre-existing,
    // INV-7 keeps the manifest untouched here) is pinned so new drift fails.
    expect(manifest.filter((t) => !tools.has(t))).toEqual([]);
    expect(registered.filter((t) => !manifest.includes(t)).toSorted()).toEqual([
      "scopely_get_org_destination_lock",
      "scopely_set_org_destination_lock",
    ]);
  });

  // Family effects hide mixed-risk tools: these change GitHub or the approver
  // file (not the app), so they carry a per-tool write effect and fall under
  // the "no write is live" rule below like every app write.
  it("mixed-risk tools carry a per-tool write effect; their read siblings keep the family's", () => {
    for (const tool of [
      "scopely_gh_create_issue",
      "scopely_gh_add_comment",
      "scopely_gh_close_issue",
      "scopely_create_support_ticket",
      "scopely_grant_approver",
      "scopely_revoke_approver",
    ]) {
      expect(capabilityFor(tool)?.effect, tool).toBe("write");
    }
    for (const tool of ["scopely_gh_list_issues", "scopely_list_approvers", "scopely_trace_logs"]) {
      expect(capabilityFor(tool)?.effect, tool).toBe("non-api");
    }
  });

  // M13 slice 1: the app tools that run are exactly the slice-1 reads, each a
  // pure read bound to one read capability of the kernel snapshot.
  it("only the slice-1 operator-layer reads and the local approver list run; no write is live", () => {
    const runnable = registryTools().filter((t) => {
      const status = capabilityFor(t)?.status;
      return status === "live" || status === "local";
    });
    expect(runnable).toEqual([
      "scopely_list_project_types",
      "scopely_list_scoping_cards",
      "scopely_get_scoping_card",
      "scopely_list_deployment_types",
      "scopely_list_vendors",
      "scopely_get_vendor",
      "scopely_vendor_config",
      "scopely_health_check",
      "scopely_auth_status",
      "scopely_list_sessions",
      "scopely_get_session",
      "scopely_list_pricing_defaults",
      "scopely_list_approvers",
    ]);
    const snapshot = new Map(SNAPSHOT.capabilities.map((c) => [c.name, c]));
    for (const tool of runnable.filter((t) => t !== "scopely_list_approvers")) {
      const binding = opsBindingFor(tool);
      expect(capabilityFor(tool), tool).toMatchObject({ effect: "pure-read", status: "live" });
      expect(OPS_READ_CAPABILITIES, tool).toContain(binding?.capability);
      const cap = snapshot.get(binding!.capability);
      expect(cap?.effect, tool).toBe("read");
      // Every arg key the binding passes is one the capability's schema accepts.
      expect(Object.keys(cap!.input_schema.properties ?? {}), tool).toEqual(
        expect.arrayContaining([...binding!.args]),
      );
    }
    expect(capabilityFor("scopely_list_approvers")?.status).toBe("local");
    expect(opsBindingFor("scopely_list_approvers")).toBeUndefined();
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(opsBindingFor(name), name).toBeUndefined();
    }
    for (const tool of registryTools()) {
      const cap = capabilityFor(tool)!;
      if (cap.effect === "write") {
        expect(cap.status, tool).not.toMatch(/live|local/);
        expect(opsBindingFor(tool), tool).toBeUndefined();
      }
    }
  });

  it("statuses follow the rollout; the exceptions are listed here", () => {
    // Exceptions to "every non-health, non-local row is not_available":
    const notPorted = registryTools().filter((t) => capabilityFor(t)?.status === "not_ported");
    expect(notPorted).toEqual([
      // F11: approvals were removed in ZW2 (parity says gap-missing-endpoint).
      "scopely_request_session_approval",
      "scopely_approve_session",
      "scopely_reject_session",
      "scopely_add_session_discount",
      "scopely_remove_session_discount",
      // F12: the legacy passthrough runner is retired for the new app.
      "scopely_passthrough_status",
      "scopely_passthrough_run_now",
    ]);
    // The slice-1 reads are live through the operator layer; the rest of
    // their families still wait (no capability yet).
    for (const [tool, family] of [
      ["scopely_list_vendors", "F1"],
      ["scopely_list_sessions", "F5"],
      ["scopely_auth_status", "F5"],
    ]) {
      expect(capabilityFor(tool), tool).toMatchObject({
        family,
        enablement: "read-live-on-prod",
        status: "live",
      });
    }
    for (const [tool, family] of [
      ["scopely_list_users", "F5"],
      ["scopely_search", "F5"],
    ]) {
      expect(capabilityFor(tool), tool).toMatchObject({
        family,
        enablement: "blocked-on-identity",
        status: "not_available",
      });
    }
  });
});

describe("registry gating through the index.ts wrapper (AC-7.4)", () => {
  it("a write tool answers 'paused' with the profile's F7 link and manual path, and never runs", async () => {
    const tool = registeredTools().tools.get("scopely_update_scoping_card")!;
    const result = parse(await tool.execute("x", { vendor_key: "zoom", card_id: "c", name: "n" }));
    expect(result).toMatchObject({ ok: false, outcome: "blocked_read_only", family: "F7" });
    expect(result.error).toContain("paused");
    expect(result.error).toContain(F7_LINK);
    expect(result.error).toContain("Manual path: the ZW2 Django admin (catalog configuration)");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
    expect(putPendingMock).not.toHaveBeenCalled();
  });

  // No issue is filed for these families yet, so the answer makes no tracking
  // claim at all (a search URL is not a tracker); the manual path still shows.
  it.each([
    ["scopely_list_orgs", "F6", "the ZW2 Django admin"],
    ["scopely_list_users", "F5", "the ZW2 staff UI (All Orders)"],
    ["scopely_get_pricing_default", "F5", "the ZW2 staff UI (All Orders)"],
    ["scopely_component_health", "F2", "ask the ZW2 team to check the app's health"],
  ])(
    "gap read %s answers 'not available on the new app yet' (%s) with no tracking claim",
    async (name, family, manualPath) => {
      const result = parse(await registeredTools().tools.get(name)!.execute("x", {}));
      expect(result).toMatchObject({ ok: false, outcome: "not_available", family, issue: null });
      expect(result.error).toContain("not available on the new app yet");
      expect(result.error).toContain(`Manual path: ${manualPath}.`);
      expect(result.error).not.toMatch(/Tracked in|https?:/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("GitHub and log tools never shell out, even with GH_TOKEN set", async () => {
    const { tools } = registeredTools();
    process.env.GH_TOKEN = "dummy-not-a-token";
    try {
      for (const name of [
        "scopely_gh_list_issues",
        "scopely_gh_create_issue",
        "scopely_gh_close_issue",
        "scopely_correlate_errors",
        "scopely_create_support_ticket",
      ]) {
        const result = parse(
          await tools.get(name)!.execute("x", { query: "q", title: "t", body: "b" }),
        );
        expect(result.ok, name).toBe(false);
      }
    } finally {
      delete process.env.GH_TOKEN;
    }
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // read-write lets the guard pass a write (dev only), but no write tool is
  // live/local in M1, so the registry still answers every one of them.
  it("on a dev read-write profile every write tool is still refused by the registry", async () => {
    writeProfile({ ...DEV, mode: "read-write" });
    const { tools } = registeredTools();
    const writes = [...tools.keys()].filter((t) => capabilityFor(t)?.effect === "write");
    expect(writes.length).toBe(65); // F7-F11 plus the six per-tool overrides
    const params = {
      id: "1",
      user_id: "1",
      vendor_key: "zoom",
      card_id: "c",
      title: "t",
      body: "b",
    };
    for (const name of writes) {
      const result = parse(await tools.get(name)!.execute("x", params));
      expect(result.ok, name).toBe(false);
      expect(["not_available", "not_ported"], name).toContain(result.outcome);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(putPendingMock).not.toHaveBeenCalled();
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
  });

  // The legacy runner is deleted; both tools stay registered (INV-7) and are
  // refused in code, so they stay inert even without the registry wrapper.
  it("both passthrough tools are code-refused without the wrapper", async () => {
    const tools = new Map<string, Tool>();
    const api = {
      registerTool: (factory: () => Tool) => {
        const tool = factory();
        tools.set(tool.name, tool);
      },
    } as never;
    registerPassthroughTools(api, () => {});
    expect([...tools.keys()]).toEqual([
      "scopely_passthrough_status",
      "scopely_passthrough_run_now",
    ]);
    for (const [name, tool] of tools) {
      const result = parse(await tool.execute("x", {}));
      expect(result, name).toMatchObject({ ok: false, outcome: "not_ported", family: "F12" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("passthrough run-now is refused as not ported", async () => {
    const result = parse(
      await registeredTools().tools.get("scopely_passthrough_run_now")!.execute("x", {}),
    );
    expect(result).toMatchObject({ ok: false, outcome: "not_ported", family: "F12" });
  });

  it("the live health check runs through the guard as one operator-layer invoke", async () => {
    useServiceToken();
    const result = parse(
      await registeredTools().tools.get("scopely_health_check")!.execute("x", {}),
    );
    expect(result).toMatchObject({ ok: true, capability: "system.health", data: { status: "ok" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    correlatedId(fetchMock.mock.calls[0][0], "https://api.vip.pscx.ai/api/spine/v1/ops/invoke/");
  });

  it("under authMode anonymous a live read sends nothing and says why", async () => {
    const result = parse(
      await registeredTools().tools.get("scopely_list_vendors")!.execute("x", {}),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatch(/no service token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a tool missing from the registry is refused (deny by default)", async () => {
    const execute = vi.fn();
    const wrapped = applyCapabilityRegistry(
      () => ({ name: "scopely_brand_new", execute }) as never,
    );
    const tool = (wrapped as (ctx: unknown) => Tool)({});
    const result = parse(await tool.execute("x", {}));
    expect(result).toMatchObject({ ok: false, outcome: "not_registered" });
    expect(execute).not.toHaveBeenCalled();
  });

  // Event names follow the plan's audit vocabulary (backend-profile.ts lists
  // the full set); the registry outcome is kept as a sub-reason.
  it.each([
    ["scopely_list_orgs", "not_available", "F6", "tool_not_available"],
    ["scopely_approve_session", "not_available", "F11", "tool_not_ported"],
    ["scopely_update_scoping_card", "write_blocked_read_only", "F7", "tool_blocked_read_only"],
  ])("audits the refusal of %s as %s", async (tool, event, family, reason) => {
    await registeredTools().tools.get(tool)!.execute("x", {});
    expect(auditRows().at(-1)).toMatchObject({
      event_type: event,
      detail: { tool, family, reason },
    });
  });

  it("audits an unregistered tool as not_available (tool_not_registered)", async () => {
    const wrapped = applyCapabilityRegistry(
      () => ({ name: "scopely_brand_new", execute: vi.fn() }) as never,
    );
    await (wrapped as (ctx: unknown) => Tool)({}).execute("x", {});
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "not_available",
      detail: { tool: "scopely_brand_new", family: null, reason: "tool_not_registered" },
    });
  });
});

describe("stageWrite read-only refusal (AC-7.4, INV-8)", () => {
  const run = vi.fn();

  it("refuses before a code, a pending action or a CONFIRM prompt exists", async () => {
    const result = parse(
      await runInCall(testCall("scopely_update_scoping_card"), () =>
        stageWrite("update card", run),
      ),
    );
    expect(result).toMatchObject({ ok: false, outcome: "blocked_read_only", family: "F7" });
    expect(result.error).toContain("paused");
    expect(result.issue).toBe(F7_LINK);
    expect(result.manual_path).toBe("the ZW2 Django admin (catalog configuration)");
    expect(makeCodeMock).not.toHaveBeenCalled();
    expect(putPendingMock).not.toHaveBeenCalled();
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "write_blocked_read_only",
      detail: {
        tool: "scopely_update_scoping_card",
        family: "F7",
        reason: "tool_blocked_read_only",
      },
    });
  });

  it("also refuses with no profile file at all (fail-closed default)", async () => {
    fs.rmSync(path.join(workspace, "scopelybot-backend.json"));
    const result = parse(await stageWrite("update card", run));
    expect(result).toMatchObject({ ok: false, outcome: "blocked_read_only" });
    expect(result.error).toContain("paused");
    expect(putPendingMock).not.toHaveBeenCalled();
    expect(sendScopelyTextMock).not.toHaveBeenCalled();
  });

  it("stages normally only when the live profile says read-write (dev-only)", async () => {
    writeProfile({ ...DEV, mode: "read-write" });
    const result = parse(await stageWrite("update card", run));
    expect(result).toMatchObject({ staged: true });
    expect(putPendingMock).toHaveBeenCalledTimes(1);
    expect(sendScopelyTextMock).toHaveBeenCalledTimes(1);
  });
});

// PK-7b-1: the requester of every row a call writes comes from the trusted
// tool-factory ctx of the coordinator's own run; anything else is unresolved.
describe("requester attribution from the tool-factory ctx (PK-7b-1)", () => {
  beforeEach(useServiceToken);
  const HUB = "agent:scopelybot:zoom:channel:room-1";
  const missing = { resolved: false, zoom_operator_id: null, source: "none", reason: "missing" };
  it.each([
    [
      "a human-triggered coordinator run",
      { agentId: "scopelybot", sessionKey: HUB, requesterSenderId: "op_123" },
      { resolved: true, zoom_operator_id: "op_123", source: "ctx", reason: null },
    ],
    [
      "a coordinator announce run (no sender)",
      { agentId: "scopelybot", sessionKey: HUB },
      { resolved: false, zoom_operator_id: null, source: "none", reason: "announce_run" },
    ],
    [
      "a spoke the coordinator spawned in its own agent, even with a sender",
      {
        agentId: "scopelybot",
        sessionKey: "agent:scopelybot:subagent:7c9e6679",
        requesterSenderId: "op_999",
      },
      missing,
    ],
    [
      // call-context.ts COORDINATOR_SESSION: a subagent nested under a channel
      // session (and a subagent of a subagent) is not the coordinator either.
      "a subagent nested under a coordinator channel session",
      {
        agentId: "scopelybot",
        sessionKey: "agent:scopelybot:zoom:channel:x:subagent:7c9e6679",
        requesterSenderId: "op_999",
      },
      missing,
    ],
    [
      "a subagent of a subagent",
      {
        agentId: "scopelybot",
        sessionKey: "agent:scopelybot:zoom:channel:x:subagent:a:subagent:b",
        requesterSenderId: "op_999",
      },
      missing,
    ],
    [
      "a spoke, even if its ctx carried a sender",
      {
        agentId: "scopely-catalog",
        sessionKey: "agent:scopely-catalog:subagent:0f8fad5b",
        requesterSenderId: "op_999",
      },
      missing,
    ],
    [
      "another agent's session",
      {
        agentId: "pulsebot",
        sessionKey: "agent:pulsebot:zoom:channel:x",
        requesterSenderId: "op_777",
      },
      missing,
    ],
    ["no ctx at all", {}, missing],
  ])("%s", async (_label, ctx, requester) => {
    const health = registeredTools(ctx).tools.get("scopely_auth_status")!;
    await health.execute("call-7", { requester: "op_evil", actor: "op_evil" });
    const rows = auditRows().filter((r) =>
      ["http_intent", "http_outcome", "tool_call"].includes(r.event_type),
    );
    expect(rows.map((r) => r.event_type)).toEqual(["http_intent", "http_outcome", "tool_call"]);
    for (const row of rows) {
      expect(row.requester).toEqual(requester); // params never name the requester
      expect(row.openclaw).toEqual({
        agent_id: (ctx as { agentId?: string }).agentId ?? null,
        session_key: (ctx as { sessionKey?: string }).sessionKey ?? null,
        tool_call_id: "call-7",
      });
    }
    expect(auditRows().map((r) => r.requester.zoom_operator_id)).not.toContain("scopelybot");
  });

  it("host-supplied ids are bounded: a 20,000-character tool call id or sender still audits and sends", async () => {
    const long = (c: string) => c.repeat(20_000);
    const tools = registeredTools({
      agentId: long("a"),
      sessionKey: `${HUB}:${long("s")}`,
      requesterSenderId: long("u"),
    }).tools;
    await tools.get("scopely_auth_status")!.execute(long("t"), {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = auditRows().filter((r) =>
      ["http_intent", "http_outcome", "tool_call"].includes(r.event_type),
    );
    expect(rows.map((r) => r.event_type)).toEqual(["http_intent", "http_outcome", "tool_call"]);
    for (const row of rows) {
      for (const value of [
        row.requester.zoom_operator_id,
        ...Object.values(row.openclaw as Record<string, unknown>),
      ]) {
        expect(String(value).length).toBeLessThanOrEqual(253);
        expect(String(value)).toMatch(/~[0-9a-f]{12}$/);
      }
    }
  });

  it("a refused tool's row carries the requester too", async () => {
    const tools = registeredTools({ sessionKey: HUB, requesterSenderId: "op_123" }).tools;
    await tools.get("scopely_list_orgs")!.execute("call-8", {});
    expect(auditRows().at(-1)).toMatchObject({
      event_type: "not_available",
      requester: { resolved: true, zoom_operator_id: "op_123" },
      action: { tool: "scopely_list_orgs", family: "F6", op_class: "read" },
    });
  });

  it("a tool registered as a plain object (no factory ctx) resolves missing", async () => {
    const wrapped = applyCapabilityRegistry({
      name: "scopely_list_orgs",
      execute: vi.fn(),
    } as never) as unknown as Tool;
    await wrapped.execute("call-9", {});
    expect(auditRows().at(-1)?.requester).toEqual(missing);
  });
});

// The bindings against the REAL kernel snapshot (fixtures/ops-capabilities.
// snapshot.json, zoomwarriors_2 301b1c0e): every capability exists and is a
// read, each tool's parameter schema offers exactly its binding's args with
// the capability's types and required keys, and the args the tools actually
// send for representative params validate against the capability's schema.
describe("bindings against the kernel snapshot", () => {
  const snapshot = new Map(SNAPSHOT.capabilities.map((c) => [c.name, c]));
  const opsTools = registryTools().filter((t) => opsBindingFor(t));
  type ToolSchema = { properties?: Record<string, JsonSchema>; required?: string[] };

  it("every allow-listed capability is a read in the snapshot", () => {
    for (const name of OPS_READ_CAPABILITIES) {
      expect(snapshot.get(name)?.effect, name).toBe("read");
    }
  });

  it("each tool's parameters are exactly its binding's args, typed and required like the capability", () => {
    const { tools } = registeredTools();
    for (const name of opsTools) {
      const binding = opsBindingFor(name)!;
      const schema = snapshot.get(binding.capability)?.input_schema;
      expect(schema, name).toBeDefined();
      const params = (tools.get(name) as unknown as { parameters: ToolSchema }).parameters;
      expect(Object.keys(params.properties ?? {}).toSorted(), name).toEqual(
        [...binding.args].toSorted(),
      );
      for (const key of binding.args) {
        const want = schema!.properties?.[key];
        const got = params.properties![key];
        expect(want, `${name}.${key} is not in ${binding.capability}`).toBeDefined();
        expect(got.type, `${name}.${key} type`).toBe(want!.type);
        expect(got.items?.enum, `${name}.${key} enum`).toEqual(want!.items?.enum);
      }
      for (const key of schema!.required ?? []) {
        expect(params.required ?? [], `${name} must require ${key}`).toContain(key);
      }
    }
  });

  // About 30 sessions rows fill the 16,000-character output limit (ops-client.ts
  // boundData): a larger advertised page would be cut with its tail unreachable.
  it("the page size the bot advertises fits its output limit", () => {
    const params = (
      registeredTools().tools.get("scopely_list_sessions") as unknown as {
        parameters: { properties: Record<string, { maximum?: number; minimum?: number }> };
      }
    ).parameters;
    expect(params.properties.page_size).toMatchObject({ minimum: 1, maximum: 30 });
    // About 665 bytes a pricing row: 20 rows fit; the bot asks for 20 by default.
    const pricing = (
      registeredTools().tools.get("scopely_list_pricing_defaults") as unknown as {
        parameters: { properties: Record<string, { maximum?: number; minimum?: number }> };
      }
    ).parameters;
    expect(pricing.properties.limit).toMatchObject({ minimum: 1, maximum: 20 });
    expect(pricing.properties.offset).toMatchObject({ minimum: 0 });
    expect(opsBindingFor("scopely_list_pricing_defaults")?.defaults).toEqual({ limit: 20 });
  });

  // Representative valid params per tool (every ops tool must have a row).
  const SAMPLES: Record<string, Record<string, unknown>[]> = {
    scopely_health_check: [{}],
    scopely_auth_status: [{}],
    scopely_list_vendors: [{}],
    scopely_get_vendor: [{ vendor_key: "zoom" }],
    scopely_vendor_config: [{ vendor_key: "ring-central_2" }],
    scopely_list_project_types: [{ vendor_key: "zoom" }],
    scopely_list_deployment_types: [{ vendor_key: "zoom", project_type: "ucaas" }],
    scopely_list_scoping_cards: [{ vendor_key: "zoom", project_type: "ucaas" }],
    scopely_get_scoping_card: [{ vendor_key: "zoom", project_type: "ucaas", card_key: "sites" }],
    scopely_list_pricing_defaults: [
      { vendor_key: "zoom" },
      { vendor_key: "zoom", scope_category: "ccaas" },
    ],
    scopely_list_sessions: [
      {},
      {
        status: ["signed", "sow_sent"],
        search: "acme",
        organization_id: 3,
        page: 2,
        page_size: 100,
      },
    ],
    scopely_get_session: [{ session_id: 42 }, { order_number: "PS-0000123" }],
  };

  it("the args each tool sends for valid params pass the capability's real input schema", async () => {
    useServiceToken();
    expect(Object.keys(SAMPLES).toSorted()).toEqual([...opsTools].toSorted());
    const { tools } = registeredTools({
      sessionKey: "agent:scopelybot:zoom:x",
      requesterSenderId: "operator_123",
    });
    for (const [name, samples] of Object.entries(SAMPLES)) {
      for (const params of samples) {
        fetchMock.mockClear();
        resetScopelyGuardForTest();
        await tools.get(name)!.execute("x", { ...params, stray: "dropped" });
        expect(fetchMock, name).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const schema = snapshot.get(body.capability)!.input_schema;
        expect(validate(schema, body.args), `${name} ${JSON.stringify(params)}`).toEqual([]);
      }
    }
  });

  // The validator is load-bearing above: it must reject what the kernel rejects.
  it.each([
    ["sessions.list", { status: "signed" }],
    ["sessions.list", { status: ["generated"] }],
    ["sessions.list", { page_size: 101 }],
    ["sessions.list", { vendor: "zoom" }],
    ["sessions.get", {}],
    ["sessions.get", { session_id: 1, order_number: "PS-1" }],
    ["sessions.get", { session_id: "42" }],
    ["sessions.get", { order_number: "1234" }],
    ["pricing.defaults.list", { scope_category: "ucaas" }],
    ["catalog.vendors.get", { vendor_key: "zoom/x" }],
    ["catalog.vendors.get", { vendor_key: "" }],
    ["catalog.deployment_types.list", { vendor_key: "zoom" }],
  ])("the snapshot schema of %s rejects %j", (name, args) => {
    expect(validate(snapshot.get(name)!.input_schema, args)).not.toEqual([]);
  });
});
