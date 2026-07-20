/**
 * Approver-store tests: config ids are permanent, grants persist across reloads,
 * revoke only touches chat-granted entries, and the identity ledger resolves
 * observed emails to Zoom operator_ids.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApproverStore } from "./approver-store.js";

const CHAD = "Mb4vcQ4YQUaQKJjoY4vntQ";
const RUDY = "wc7WZVkGRMGcNWOYTksTvQ";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "approver-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("approver store", () => {
  it("seeds config ids as permanent approvers (normalized)", () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [` ${CHAD} `] });
    expect(store.approverIds()).toEqual([CHAD.toLowerCase()]);
    expect(store.configuredIds()).toEqual([CHAD.toLowerCase()]);
  });

  it("grant adds an approver, persists it, and refuses duplicates", () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    expect(
      store.grant({ operatorId: RUDY, email: "john.rudolph@cloudwarriors.ai", grantedBy: CHAD }),
    ).toBe(true);
    expect(store.approverIds()).toContain(RUDY.toLowerCase());
    // duplicate grant (any case) is a no-op
    expect(
      store.grant({
        operatorId: RUDY.toUpperCase(),
        email: "john.rudolph@cloudwarriors.ai",
        grantedBy: CHAD,
      }),
    ).toBe(false);
    // granting a config-seeded approver is a no-op
    expect(store.grant({ operatorId: CHAD, email: "chad@x.ai", grantedBy: CHAD })).toBe(false);

    // persistence: a fresh store over the same dir sees the grant
    const reloaded = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    expect(reloaded.approverIds()).toContain(RUDY.toLowerCase());
    expect(reloaded.listGrants()[0]).toMatchObject({
      operatorId: RUDY,
      email: "john.rudolph@cloudwarriors.ai",
      grantedBy: CHAD,
    });
  });

  it("revoke removes chat-granted entries but refuses config-seeded ids", () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    store.grant({ operatorId: RUDY, email: "john.rudolph@cloudwarriors.ai", grantedBy: CHAD });

    expect(store.revoke(CHAD).removed).toBe(false);
    expect(store.revoke(CHAD).reason).toContain("config");

    expect(store.revoke(RUDY).removed).toBe(true);
    expect(store.approverIds()).not.toContain(RUDY.toLowerCase());
    // already gone
    expect(store.revoke(RUDY).removed).toBe(false);
  });

  it("identity ledger records senders and resolves email → operator id (case-insensitive)", () => {
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [] });
    store.recordSeenIdentity(RUDY, "John.Rudolph@CloudWarriors.ai");
    expect(store.resolveOperatorId("john.rudolph@cloudwarriors.ai")).toBe(RUDY);
    expect(store.emailForOperatorId(RUDY)).toBe("john.rudolph@cloudwarriors.ai");
    // junk is ignored
    store.recordSeenIdentity(undefined, "x@y.z");
    store.recordSeenIdentity("id-1", "not-an-email");
    expect(store.resolveOperatorId("x@y.z")).toBeUndefined();
    // persists across reload
    const reloaded = createApproverStore({ workspaceDir: dir, configuredIds: [] });
    expect(reloaded.resolveOperatorId("john.rudolph@cloudwarriors.ai")).toBe(RUDY);
  });

  it("tolerates a corrupt state file by starting empty", () => {
    writeFileSync(join(dir, "scopelybot-approvers.json"), "{not json");
    const store = createApproverStore({ workspaceDir: dir, configuredIds: [CHAD] });
    expect(store.approverIds()).toEqual([CHAD.toLowerCase()]);
    expect(store.listGrants()).toEqual([]);
  });
});
