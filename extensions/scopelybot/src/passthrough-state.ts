import * as fs from "fs";
import * as path from "path";

/**
 * Persistent state for passthrough test results.
 * Stored at ~/.openclaw/workspace/scopelybot/passthrough-state.json so
 * the OpenClaw runner can survive restarts and track consecutive failures.
 */

export type PassthroughResult = "passed" | "failed" | "skipped";

export interface PassthroughTestState {
  passthrough: string; // e.g. "bighead-launch"
  testTitle: string; // full test title for context
  status: PassthroughResult;
  lastChecked: string; // ISO 8601
  durationMs: number;
  errorMessage?: string;
  consecutiveFailures: number;
}

export interface PassthroughState {
  lastRun: string | null; // ISO 8601 of most recent run
  lastRunDurationMs: number;
  tests: Record<string, PassthroughTestState>; // keyed by test title
}

const DEFAULT_STATE: PassthroughState = {
  lastRun: null,
  lastRunDurationMs: 0,
  tests: {},
};

function getStateFilePath(workspaceDir: string): string {
  return path.join(workspaceDir, "scopelybot", "passthrough-state.json");
}

export function readState(workspaceDir: string): PassthroughState {
  const file = getStateFilePath(workspaceDir);
  try {
    if (!fs.existsSync(file)) {
      return { ...DEFAULT_STATE };
    }
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as PassthroughState;
    // Defensive: ensure shape
    return {
      lastRun: parsed.lastRun ?? null,
      lastRunDurationMs: parsed.lastRunDurationMs ?? 0,
      tests: parsed.tests ?? {},
    };
  } catch (err) {
    console.error("[scopelybot-passthrough] failed to read state, using defaults:", err);
    return { ...DEFAULT_STATE };
  }
}

export function writeState(workspaceDir: string, state: PassthroughState): void {
  const file = getStateFilePath(workspaceDir);
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[scopelybot-passthrough] failed to write state:", err);
  }
}

/**
 * Update state with the latest run results.
 * - Increments consecutiveFailures for failing tests, resets to 0 on pass
 * - Returns the previous state (so callers can detect transitions for alerting)
 */
export function applyRunResults(
  workspaceDir: string,
  results: Array<{
    passthrough: string;
    testTitle: string;
    status: PassthroughResult;
    durationMs: number;
    errorMessage?: string;
  }>,
  runStartedAt: Date,
  runDurationMs: number,
): { previous: PassthroughState; current: PassthroughState } {
  const previous = readState(workspaceDir);
  const current: PassthroughState = {
    lastRun: runStartedAt.toISOString(),
    lastRunDurationMs: runDurationMs,
    tests: { ...previous.tests },
  };

  for (const r of results) {
    const prevTest = previous.tests[r.testTitle];
    const consecutiveFailures =
      r.status === "failed" ? (prevTest?.consecutiveFailures ?? 0) + 1 : 0;

    current.tests[r.testTitle] = {
      passthrough: r.passthrough,
      testTitle: r.testTitle,
      status: r.status,
      lastChecked: runStartedAt.toISOString(),
      durationMs: r.durationMs,
      errorMessage: r.errorMessage,
      consecutiveFailures,
    };
  }

  writeState(workspaceDir, current);
  return { previous, current };
}

/**
 * Returns tests that crossed the alert threshold on this run.
 * A test crosses the threshold when its consecutiveFailures becomes >= threshold
 * AND it was below threshold (or absent) in the previous state — this prevents
 * alerting on every run while a passthrough is broken.
 */
export function getNewlyFailingTests(
  previous: PassthroughState,
  current: PassthroughState,
  threshold: number,
): PassthroughTestState[] {
  const newlyFailing: PassthroughTestState[] = [];
  for (const [title, test] of Object.entries(current.tests)) {
    if (test.consecutiveFailures < threshold) {
      continue;
    }
    const prevFailures = previous.tests[title]?.consecutiveFailures ?? 0;
    if (prevFailures < threshold) {
      newlyFailing.push(test);
    }
  }
  return newlyFailing;
}

/**
 * Returns tests that recovered on this run (were failing >= threshold, now passing).
 */
export function getRecoveredTests(
  previous: PassthroughState,
  current: PassthroughState,
  threshold: number,
): PassthroughTestState[] {
  const recovered: PassthroughTestState[] = [];
  for (const [title, test] of Object.entries(current.tests)) {
    if (test.status !== "passed") {
      continue;
    }
    const prevFailures = previous.tests[title]?.consecutiveFailures ?? 0;
    if (prevFailures >= threshold) {
      recovered.push(test);
    }
  }
  return recovered;
}
