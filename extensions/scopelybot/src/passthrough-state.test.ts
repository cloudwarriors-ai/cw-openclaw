import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRunResults,
  getNewlyFailingTests,
  getRecoveredTests,
  readState,
} from "./passthrough-state.js";

describe("passthrough-state", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "scopelybot-state-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns default empty state when no file exists", () => {
    const state = readState(workspaceDir);
    expect(state.lastRun).toBeNull();
    expect(state.tests).toEqual({});
  });

  it("increments consecutiveFailures for a failing test", () => {
    const startedAt = new Date();

    // First run: fail
    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    const state1 = readState(workspaceDir);
    expect(state1.tests["[p1] test"].consecutiveFailures).toBe(1);

    // Second run: still fail
    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    const state2 = readState(workspaceDir);
    expect(state2.tests["[p1] test"].consecutiveFailures).toBe(2);
  });

  it("resets consecutiveFailures when a previously-failing test passes", () => {
    const startedAt = new Date();

    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "passed", durationMs: 50 }],
      startedAt,
      50,
    );

    expect(readState(workspaceDir).tests["[p1] test"].consecutiveFailures).toBe(0);
  });

  it("getNewlyFailingTests returns tests crossing the threshold this run", () => {
    const startedAt = new Date();

    // Run 1: fail (count = 1, below threshold)
    const r1 = applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    expect(getNewlyFailingTests(r1.previous, r1.current, 2)).toEqual([]);

    // Run 2: fail again (count = 2, meets threshold) — should alert
    const r2 = applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    const newlyFailing = getNewlyFailingTests(r2.previous, r2.current, 2);
    expect(newlyFailing).toHaveLength(1);
    expect(newlyFailing[0].passthrough).toBe("p1");

    // Run 3: still failing (count = 3, already past threshold) — should NOT alert again
    const r3 = applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    expect(getNewlyFailingTests(r3.previous, r3.current, 2)).toEqual([]);
  });

  it("getRecoveredTests returns tests that recovered from failing past threshold", () => {
    const startedAt = new Date();

    // Get to failing state past threshold
    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );

    // Now recover
    const r = applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "passed", durationMs: 50 }],
      startedAt,
      50,
    );
    const recovered = getRecoveredTests(r.previous, r.current, 2);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].passthrough).toBe("p1");
  });

  it("does not report recovery for tests that never crossed the threshold", () => {
    const startedAt = new Date();

    // Single fail (below threshold), then pass — should NOT report recovery
    applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "failed", durationMs: 100 }],
      startedAt,
      100,
    );
    const r = applyRunResults(
      workspaceDir,
      [{ passthrough: "p1", testTitle: "[p1] test", status: "passed", durationMs: 50 }],
      startedAt,
      50,
    );
    expect(getRecoveredTests(r.previous, r.current, 2)).toEqual([]);
  });
});
