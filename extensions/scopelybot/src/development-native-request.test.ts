import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PRODUCTION_CORE_TOOLS, PRODUCTION_SUPPORT } from "./ops-write-policy.js";
import {
  OPS_READ_CAPABILITIES,
  type OpsCapability,
  resetScopelyGuardForTest,
  scopelyFetch,
  scopelyOpsInvoke,
} from "./scopely-api.js";

const channel = "575b23671d6b4b7f8c22b1924b6177fa@conference.xmpp.zoom.us";
const origin = "http://vip-noob-bot-native:8000";
const token = `zwops_${"a".repeat(12)}_${"b".repeat(40)}`;
const profile = {
  env: "dev",
  mode: "read-write",
  authMode: "service-token",
  baseUrl: origin,
  allowedHosts: ["vip-noob-bot-native:8000"],
  developmentCoreWrites: true,
};
const network = vi.fn();
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "noob-bot-native-"));
  writeFileSync(join(workspace, "scopelybot-backend.json"), JSON.stringify(profile));
  writeFileSync(join(workspace, "scopelybot-ops-token"), token, { mode: 0o600 });
  vi.stubEnv("OPENCLAW_WORKSPACE", workspace);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", channel);
  vi.stubEnv("SCOPELY_BASE_URL", "https://legacy.invalid");
  network.mockReset().mockImplementation(
    async () =>
      new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", network);
  resetScopelyGuardForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});

it.each([...OPS_READ_CAPABILITIES, ...Object.values(PRODUCTION_CORE_TOOLS), ...PRODUCTION_SUPPORT])(
  "routes %s exactly once to the private native app",
  async (capability) => {
    await scopelyOpsInvoke({ capability, requesterZoomId: "provider-user32", args: {} });
    expect(network).toHaveBeenCalledTimes(1);
    const [url, options] = network.mock.calls[0];
    expect(new URL(url).origin).toBe(origin);
    expect(new URL(url).pathname).toBe("/api/spine/v1/ops/invoke/");
    expect(options.headers.authorization).toBe(`Bearer ${token}`);
    expect(options.headers.host).toBe("vip-noob-bot-native");
    expect(options.headers["x-ops-requester-zoom-id"]).toBe("provider-user32");
    if (!OPS_READ_CAPABILITIES.includes(capability as (typeof OPS_READ_CAPABILITIES)[number])) {
      expect(options.headers["x-ops-surface"]).toBe(channel);
    }
  },
);
it.each([
  "ops.approvers.grant",
  "sessions.archive",
  "identity.invites.create",
  "pricing.items.delete",
])("refuses deferred capability %s before networking", async (capability) => {
  await expect(
    scopelyOpsInvoke({
      capability: capability as OpsCapability,
      requesterZoomId: "provider-user32",
      args: {},
    }),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
it("refuses a raw legacy mutation and forged authentication header", async () => {
  await expect(scopelyFetch("/api/auth/login/", { method: "POST", body: "{}" })).rejects.toThrow();
  await expect(
    scopelyFetch("/api/v1/health/", { headers: { authorization: "forged" } }),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});
it("does not retry a write or fall back after a private backend failure", async () => {
  network.mockRejectedValue(new TypeError("connection lost"));
  await expect(
    scopelyOpsInvoke({
      capability: "pricing.items.create",
      requesterZoomId: "provider-user32",
      args: {},
    }),
  ).rejects.toThrow();
  expect(network).toHaveBeenCalledTimes(1);
  expect(new URL(network.mock.calls[0][0]).origin).toBe(origin);
});

it("keeps native reads working after the operator switches to read-only", async () => {
  writeFileSync(
    join(workspace, "scopelybot-backend.json"),
    JSON.stringify({ ...profile, mode: "read-only" }),
  );
  await scopelyOpsInvoke({
    capability: "system.whoami",
    requesterZoomId: "provider-user32",
    args: {},
  });
  expect(network).toHaveBeenCalledTimes(1);
  expect(network.mock.calls[0][1].headers.host).toBe("vip-noob-bot-native");
  await expect(
    scopelyOpsInvoke({
      capability: "pricing.items.create",
      requesterZoomId: "provider-user32",
      args: {},
    }),
  ).rejects.toThrow();
  expect(network).toHaveBeenCalledTimes(1);
});
