import { postFailureAlert, postRecoveryAlert, postRunnerErrorAlert } from "./passthrough-alerts.js";
import { runPassthroughTests } from "./passthrough-runner.js";
import { applyRunResults, getNewlyFailingTests, getRecoveredTests } from "./passthrough-state.js";

export interface CycleSummary {
  source: "scheduled" | "manual";
  ran_successfully: boolean;
  run_error?: string;
  duration_ms: number;
  total_tests: number;
  passed: number;
  failed: number;
  skipped: number;
  newly_failing: number;
  recovered: number;
}

const ALERT_THRESHOLD = Number(process.env.PASSTHROUGH_ALERT_THRESHOLD ?? 2);

/**
 * Single end-to-end cycle: run the tests, update state, fire alerts on
 * threshold transitions. Used by both the scheduled hook and the manual
 * chat tool so they behave identically.
 */
export async function runPassthroughCycle(
  workspaceDir: string,
  opts: { source: "scheduled" | "manual" },
): Promise<CycleSummary> {
  const summary = await runPassthroughTests();

  if (!summary.ranSuccessfully) {
    // Alert about the runner being broken — but only on scheduled runs to
    // avoid spamming the channel when someone manually triggers it.
    if (opts.source === "scheduled") {
      await postRunnerErrorAlert(summary.runError ?? "unknown error");
    }
    return {
      source: opts.source,
      ran_successfully: false,
      run_error: summary.runError,
      duration_ms: summary.durationMs,
      total_tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      newly_failing: 0,
      recovered: 0,
    };
  }

  const { previous, current } = applyRunResults(
    workspaceDir,
    summary.results,
    summary.startedAt,
    summary.durationMs,
  );

  const newlyFailing = getNewlyFailingTests(previous, current, ALERT_THRESHOLD);
  const recovered = getRecoveredTests(previous, current, ALERT_THRESHOLD);

  // Fire alerts. These are best-effort (postX functions swallow errors).
  await postFailureAlert(newlyFailing);
  await postRecoveryAlert(recovered);

  return {
    source: opts.source,
    ran_successfully: true,
    duration_ms: summary.durationMs,
    total_tests: summary.results.length,
    passed: summary.results.filter((r) => r.status === "passed").length,
    failed: summary.results.filter((r) => r.status === "failed").length,
    skipped: summary.results.filter((r) => r.status === "skipped").length,
    newly_failing: newlyFailing.length,
    recovered: recovered.length,
  };
}
