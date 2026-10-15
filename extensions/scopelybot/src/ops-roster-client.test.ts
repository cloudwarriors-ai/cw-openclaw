// Only this test module injects a reserved non-network origin into the real policy.
vi.mock("./ops-write-policy.js", async (original) => {
  const actual = await original<typeof import("./ops-write-policy.js")>();
  const origins = ["https://core-production.invalid:9443"];
  return {
    ...actual,
    isReviewedProductionOrigin: (origin: string) =>
      actual.isReviewedProductionOrigin(origin, origins),
    productionCoreEnabled: (profile: Parameters<typeof actual.productionCoreEnabled>[0]) =>
      actual.productionCoreEnabled(profile, origins),
    nativeWriteScope: (
      profile: Parameters<typeof actual.nativeWriteScope>[0],
      channel: string | undefined,
    ) => actual.nativeWriteScope(profile, channel, origins),
  };
});
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
const requester = vi.hoisted(() => vi.fn());
vi.mock("./scopely-api.js", async (original) => ({
  ...(await original<object>()),
  scopelyOpsInvoke: invoke,
}));
vi.mock("./ops-client.js", () => ({ currentWriteRequester: requester }));
import { type BackendProfile, setBackendProfileForTest } from "./backend-profile.js";
import { isCurrentApprover, opsRosterList } from "./ops-roster-client.js";
const profile: Partial<BackendProfile> = {
  env: "local",
  mode: "read-write",
  baseUrl: "http://127.0.0.1:8100",
  allowedHosts: ["127.0.0.1:8100"],
  authMode: "service-token",
};
function answer(data: unknown, capability = "ops.approvers.check") {
  return { ok: true, status: 200, data: { ok: true, capability, data } };
}
beforeEach(() => {
  setBackendProfileForTest(profile);
  vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "synthetic-channel");
  invoke.mockReset();
  requester.mockReset().mockReturnValue("synthetic-admin");
  invoke.mockResolvedValue(answer({ eligible: true, user_id: 7, scope_revision: 1 }));
});
afterEach(() => {
  setBackendProfileForTest(null);
  vi.unstubAllEnvs();
});
it("uses exact canonical inbound identity and rechecks every time without a positive cache", async () => {
  expect(await isCurrentApprover("SYNTHETIC-ADMIN")).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith({
    capability: "ops.approvers.check",
    args: {},
    requesterZoomId: "synthetic-admin",
  });
  invoke.mockResolvedValue(answer({ eligible: false, user_id: 7 }));
  expect(await isCurrentApprover("synthetic-admin")).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(2);
});
it.each([
  undefined,
  null,
  {},
  { eligible: "true", user_id: 7, scope_revision: 1 },
  { eligible: true, user_id: 0, scope_revision: 1 },
  { eligible: true, user_id: 7 },
  { eligible: true, user_id: 7, scope_revision: 1.5 },
])("refuses malformed eligibility %j", async (data) => {
  invoke.mockResolvedValue(answer(data));
  expect(await isCurrentApprover("synthetic-admin")).toBe(false);
});
it.each(["transport", "truncated", "wrong-capability", "http", "profile-change", "channel-change"])(
  "fails closed on %s",
  async (failure) => {
    invoke.mockImplementation(async () => {
      if (failure === "transport") {
        throw new Error("private arbitrary response");
      }
      if (failure === "profile-change") {
        setBackendProfileForTest({ ...profile, mode: "read-only" });
      }
      if (failure === "channel-change") {
        process.env.SCOPELYBOT_ZOOM_CHANNEL = "changed";
      }
      return {
        ...answer(
          { eligible: true, user_id: 7, scope_revision: 1 },
          failure === "wrong-capability" ? "system.health" : "ops.approvers.check",
        ),
        ok: failure !== "http",
        truncated: failure === "truncated",
      };
    });
    expect(await isCurrentApprover("synthetic-admin")).toBe(false);
  },
);
it.each([
  "",
  "bad@identity",
  "zwops_secret",
  "ghp_synthetic",
  "sk_synthetic",
  "xoxb-synthetic",
  "a".repeat(31) + "1",
  "a".repeat(65),
])("invalid sender never makes a request: %s", async (actor) => {
  expect(await isCurrentApprover(actor)).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
it("production/default profile and missing current requester refuse without transport", async () => {
  setBackendProfileForTest(null);
  expect(await isCurrentApprover("synthetic-admin")).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  setBackendProfileForTest(profile);
  requester.mockReturnValue(undefined);
  expect(JSON.parse((await opsRosterList({})).content[0].text).ok).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});
it("returns bounded public roster with intact next cursor; refuses malformed progress", async () => {
  const item = { user_id: 7, revision: 1, active: true, seeded: false };
  const data = { items: [item], total: 2, next_offset: 1, truncated: true };
  invoke.mockResolvedValue(answer(data, "ops.approvers.list"));
  expect(JSON.parse((await opsRosterList({ offset: 0 })).content[0].text)).toMatchObject({
    ok: true,
    untrusted_output: true,
    data,
  });
  for (const change of [
    { next_offset: 2 },
    { next_offset: 0 },
    { items: [] },
    { total: 0 },
    { truncated: false },
    { items: Array(51).fill(item) },
    { items: [{ ...item, user_id: "7" }] },
  ]) {
    invoke.mockResolvedValue(answer({ ...data, ...change }, "ops.approvers.list"));
    expect(JSON.parse((await opsRosterList({ offset: 0 })).content[0].text).ok).toBe(false);
  }
});

it("does not return a roster after its tool requester epoch becomes invalid during the read", async () => {
  invoke.mockImplementation(async () => {
    requester.mockReturnValue(undefined);
    return answer(
      { items: [], total: 0, next_offset: null, truncated: false },
      "ops.approvers.list",
    );
  });
  expect(JSON.parse((await opsRosterList({})).content[0].text).ok).toBe(false);
});

it.each(["eligible", "revoked", "scope-change"])(
  "production server roster stays authoritative: %s",
  async (caseName) => {
    const production = {
      env: "prod" as const,
      mode: "read-write" as const,
      authMode: "service-token" as const,
      productionCoreWrites: true,
      baseUrl: "https://core-production.invalid:9443",
      allowedHosts: ["core-production.invalid:9443"],
    };
    setBackendProfileForTest(production);
    vi.stubEnv("SCOPELYBOT_ZOOM_CHANNEL", "a".repeat(32) + "@conference.xmpp.zoom.us");
    invoke.mockImplementation(async () => {
      if (caseName === "scope-change") {
        setBackendProfileForTest({ ...production, mode: "read-only" });
      }
      return answer({ eligible: caseName !== "revoked", user_id: 7, scope_revision: 1 });
    });
    expect(await isCurrentApprover("synthetic-admin")).toBe(caseName === "eligible");
    expect(invoke).toHaveBeenCalledExactlyOnceWith({
      capability: "ops.approvers.check",
      requesterZoomId: "synthetic-admin",
      args: {},
    });
  },
);
