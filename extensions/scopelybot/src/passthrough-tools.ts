import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { runPassthroughCycle } from "./passthrough-runner-cycle.js";
import { readState } from "./passthrough-state.js";
import { jsonResult, errorResult } from "./scopely-api.js";

export function registerPassthroughTools(
  api: OpenClawPluginApi,
  logger: AuditLogger,
  workspaceDir: string,
) {
  // scopely_passthrough_status — "Are all the passthroughs healthy?"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_passthrough_status",
        description:
          "Get the current health status of every Scopely passthrough being monitored. " +
          "Shows last run timestamp, pass/fail status per passthrough, and consecutive failure counts. " +
          "Use this to answer 'are the integrations healthy' or 'when did the last check run'.",
        parameters: Type.Object({
          only_failing: Type.Optional(
            Type.Boolean({ description: "Only show currently failing passthroughs" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const state = readState(workspaceDir);
            const tests = Object.values(state.tests);
            const filtered = params.only_failing
              ? tests.filter((t) => t.status !== "passed")
              : tests;

            const summary = {
              ok: true,
              last_run: state.lastRun,
              last_run_duration_ms: state.lastRunDurationMs,
              total_tests: tests.length,
              passing: tests.filter((t) => t.status === "passed").length,
              failing: tests.filter((t) => t.status === "failed").length,
              skipped: tests.filter((t) => t.status === "skipped").length,
              tests: filtered.map((t) => ({
                passthrough: t.passthrough,
                test_title: t.testTitle,
                status: t.status,
                last_checked: t.lastChecked,
                duration_ms: t.durationMs,
                consecutive_failures: t.consecutiveFailures,
                error_message: t.errorMessage,
              })),
            };

            return jsonResult(summary);
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_passthrough_run_now — "Force a passthrough check right now"
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_passthrough_run_now",
        description:
          "Trigger an immediate passthrough test run instead of waiting for the next scheduled cycle. " +
          "Returns the run summary including pass/fail counts and any newly-failing passthroughs. " +
          "Useful after a deploy or when investigating a reported issue.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const summary = await runPassthroughCycle(workspaceDir, { source: "manual" });
            return jsonResult({
              ok: true,
              ...summary,
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
