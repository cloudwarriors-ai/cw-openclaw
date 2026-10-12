// The last gate in scopelyFetch: after the URL is built and before any request,
// its host must be one of the profile's allowedHosts and it must carry no
// userinfo. parseBackendProfile already guarantees both for a real file, so the
// profile is mocked here to model the drift the gate exists for (URL assembly,
// baseUrl handling or profile validation changing later).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendProfile } from "./backend-profile.js";
import { resetScopelyGuardForTest, scopelyFetch } from "./scopely-api.js";

const holder = vi.hoisted(() => ({ profile: undefined as unknown }));
vi.mock("./backend-profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend-profile.js")>()),
  readBackendProfile: () => holder.profile,
}));

const BASE: BackendProfile = {
  profile: "zw2",
  env: "prod",
  baseUrl: "https://api.vip.pscx.ai",
  allowedHosts: ["api.vip.pscx.ai"],
  authMode: "anonymous",
  mode: "read-only",
  digestEnabled: false,
  maxRequestsPerMinute: 20,
  issueLinks: {},
};
const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
let workspace: string;

function lastAuditRow(): { resultSummary: string; params: Record<string, unknown> } {
  const raw = fs.readFileSync(path.join(workspace, "scopelybot", "audit.jsonl"), "utf8");
  return JSON.parse(raw.trim().split("\n").at(-1) ?? "{}");
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scopely-origin-"));
  process.env.OPENCLAW_WORKSPACE = workspace;
  resetScopelyGuardForTest();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCLAW_WORKSPACE;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("last-gate host check (the built URL against allowedHosts)", () => {
  it("a consistent profile still fetches", async () => {
    holder.profile = BASE;
    await scopelyFetch("/api/v1/health/");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["baseUrl drifted off allowedHosts", "https://evil.test", "evil.test"],
    ["baseUrl with a username and password", "https://u:p@api.vip.pscx.ai", "api.vip.pscx.ai"],
    ["baseUrl with a password only", "https://:p@api.vip.pscx.ai", "api.vip.pscx.ai"],
    ["baseUrl on another port", "https://api.vip.pscx.ai:8443", "api.vip.pscx.ai:8443"],
  ])("refuses %s with 0 fetches, audited", async (_label, baseUrl, host) => {
    holder.profile = { ...BASE, baseUrl };
    await expect(scopelyFetch("/api/v1/health/")).rejects.toMatchObject({ code: "host_blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastAuditRow()).toMatchObject({
      resultSummary: "host_blocked",
      params: { method: "GET", host },
    });
  });
});
