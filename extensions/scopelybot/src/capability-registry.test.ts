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
import {
  applyCapabilityRegistry,
  capabilityFor,
  registryTools,
  runInToolContext,
} from "./capability-registry.js";
import { stageWrite } from "./gated.js";
import { registerPassthroughTools } from "./passthrough-tools.js";
import { resetScopelyGuardForTest } from "./scopely-api.js";

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

// Register the real plugin and build every tool its factories produce: the
// tool list comes from registration itself, never from a hand-kept copy.
let banner = "";

function registeredTools(): { tools: Map<string, Tool>; optional: boolean[]; names: string[] } {
  const tools = new Map<string, Tool>();
  const names: string[] = [];
  const optional: boolean[] = [];
  const api = {
    registerTool: (factory: (ctx: unknown) => Tool | Tool[], opts?: { optional?: boolean }) => {
      optional.push(opts?.optional === true);
      const built = factory({});
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

function auditRows(): Array<{ resultSummary: string; params: Record<string, unknown> }> {
  return fs
    .readFileSync(path.join(workspace, "scopelybot", "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

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
    expect(banner).toContain("[scopelybot] Registered 121 tools (2 live/local on the new app;");
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

  it("only the health check and the local approver list run in M1; no write is live", () => {
    const runnable = registryTools().filter((t) => {
      const status = capabilityFor(t)?.status;
      return status === "live" || status === "local";
    });
    expect(runnable).toEqual(["scopely_health_check", "scopely_list_approvers"]);
    for (const tool of registryTools()) {
      const cap = capabilityFor(tool)!;
      if (cap.effect === "write") {
        expect(cap.status, tool).not.toMatch(/live|local/);
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
    // The anonymous catalog is a placeholder and staff reads need the bot's own
    // sign-in: both wait for a bot identity.
    for (const [tool, family] of [
      ["scopely_list_vendors", "F1"],
      ["scopely_list_sessions", "F5"],
      ["scopely_auth_status", "F5"],
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
    ["scopely_list_vendors", "F1", "the ZW2 wizard or staff catalog screens"],
    ["scopely_auth_status", "F5", "the ZW2 staff UI (All Orders)"],
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

  it("the live health check runs through the guard", async () => {
    const result = parse(
      await registeredTools().tools.get("scopely_health_check")!.execute("x", {}),
    );
    expect(result).toEqual({ ok: true, status: 200, data: { status: "ok" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.vip.pscx.ai/api/v1/health/");
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
      resultSummary: event,
      params: { tool, family, reason },
    });
  });

  it("audits an unregistered tool as not_available (tool_not_registered)", async () => {
    const wrapped = applyCapabilityRegistry(
      () => ({ name: "scopely_brand_new", execute: vi.fn() }) as never,
    );
    await (wrapped as (ctx: unknown) => Tool)({}).execute("x", {});
    expect(auditRows().at(-1)).toMatchObject({
      resultSummary: "not_available",
      params: { tool: "scopely_brand_new", family: null, reason: "tool_not_registered" },
    });
  });
});

describe("stageWrite read-only refusal (AC-7.4, INV-8)", () => {
  const run = vi.fn();

  it("refuses before a code, a pending action or a CONFIRM prompt exists", async () => {
    const result = parse(
      await runInToolContext("scopely_update_scoping_card", () => stageWrite("update card", run)),
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
      resultSummary: "write_blocked_read_only",
      params: {
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
