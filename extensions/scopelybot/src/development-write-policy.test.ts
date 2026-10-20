import { describe, expect, it } from "vitest";
import { parseBackendProfile, type BackendProfile } from "./backend-profile.js";
import { nativeWriteScope } from "./ops-write-policy.js";

const channel = "575b23671d6b4b7f8c22b1924b6177fa@conference.xmpp.zoom.us";
const candidate = {
  profile: "zw2",
  env: "dev",
  mode: "read-write",
  authMode: "service-token",
  baseUrl: "http://vip-noob-bot-native:8000",
  allowedHosts: ["vip-noob-bot-native:8000"],
  developmentCoreWrites: true,
  digestEnabled: false,
  maxRequestsPerMinute: 60,
  issueLinks: {},
};
function admitted(change: Record<string, unknown> = {}) {
  const parsed = parseBackendProfile(JSON.stringify({ ...candidate, ...change }));
  return "profile" in parsed ? nativeWriteScope(parsed.profile, channel) : undefined;
}

describe("private Noob development bot admission", () => {
  it("admits the explicitly enabled private dev profile", () => {
    expect(admitted()).toBeTypeOf("string");
  });
  it.each([
    { developmentCoreWrites: false },
    { developmentCoreWrites: "true" },
    { env: "prod" },
    { env: "local" },
    { productionCoreWrites: true },
    { authMode: "anonymous" },
    { mode: "read-only" },
    { mode: "off" },
    { baseUrl: "https://dev.api.vip.pscx.ai", allowedHosts: ["dev.api.vip.pscx.ai"] },
    { baseUrl: "http://100.114.142.100:8022", allowedHosts: ["100.114.142.100:8022"] },
    { baseUrl: "http://vip-noob-bot-native:8000/api" },
    { allowedHosts: ["vip-noob-bot-native:8000", "100.114.142.100:8022"] },
    { hostHeader: "noob-root" },
  ])("refuses mismatched profile %j", (change) => expect(admitted(change)).toBeUndefined());
  it.each([undefined, "", "synthetic-channel", "other@xmpp.zoom.us", `${channel}\n`])(
    "refuses an invalid native Zoom channel %j",
    (wrong) => {
      const profile = candidate as unknown as BackendProfile;
      expect(nativeWriteScope(profile, wrong)).toBeUndefined();
    },
  );
  it("keeps development consent in the staged scope", () => {
    const parsed = parseBackendProfile(JSON.stringify(candidate));
    expect("profile" in parsed).toBe(true);
    if ("profile" in parsed) {
      expect(nativeWriteScope(parsed.profile, channel)).not.toBe(
        nativeWriteScope(
          { ...parsed.profile, developmentCoreWrites: false } as BackendProfile,
          channel,
        ),
      );
    }
  });
});
