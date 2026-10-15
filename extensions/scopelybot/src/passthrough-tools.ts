import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { capabilityRefusal } from "./capability-registry.js";

// Both passthrough tools stay registered (INV-7: tool ids never disappear) but
// are refused in code. PK-7a deleted the legacy runner, which spawned
// Playwright with env credentials against env URLs outside the scopelyFetch
// guard (plan F12/L4), and the state file only it wrote. The registry wrapper
// refuses them first; the code refusal keeps them inert without it.
export function registerPassthroughTools(api: OpenClawPluginApi, logger: AuditLogger) {
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
        async execute() {
          return capabilityRefusal("scopely_passthrough_status");
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
          return capabilityRefusal("scopely_passthrough_run_now");
        },
      },
      logger,
    ),
  );
}
