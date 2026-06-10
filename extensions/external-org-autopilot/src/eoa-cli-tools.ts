import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { stageWrite } from "./gated.js";
import { jsonResult, errorResult } from "./helpers.js";

// Env-driven so the deploy host can relocate the checkout; the default matches
// the current production container layout. `||` (not `??`): compose passes
// `EOA_ROOT=${EOA_ROOT}`, so an unset host var arrives as "" and must still
// fall through to the default.
const EOA_ROOT = () => process.env.EOA_ROOT || "/root/code/external-org-autopilot";

// Run the EOA CLI with an explicit argv (NO shell): `npx tsx src/cli.ts <args...>`.
// Each arg is passed literally, so LLM-controlled paths/ids cannot be interpreted as
// shell syntax. Never reintroduce a shell string here.
function eoa(args: string[], timeoutMs = 120000): unknown {
  const result = execFileSync("npx", ["tsx", "src/cli.ts", ...args], {
    encoding: "utf-8",
    cwd: EOA_ROOT(),
    timeout: timeoutMs,
    env: { ...process.env },
  });
  try {
    return JSON.parse(result);
  } catch {
    return result.trim();
  }
}

// Coerce an LLM-supplied param to a safe argv element (empty if absent/object).
function argStr(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function registerEoaCliTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // eoa_release_validate
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_release_validate",
        description: "Validate a release JSON contract. Returns the validated release object.",
        parameters: Type.Object({
          releasePath: Type.String({ description: "Path to the release JSON file" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(["release", "validate", argStr(params.releasePath)]);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_release_lock
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_release_lock",
        description: "Lock a release JSON with pinned SHAs. Returns the locked release object.",
        parameters: Type.Object({
          releasePath: Type.String({ description: "Path to the release JSON file" }),
          outPath: Type.String({ description: "Output path for the locked release file" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa([
              "release",
              "lock",
              argStr(params.releasePath),
              "--out",
              argStr(params.outPath),
            ]);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_onboard_project
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_onboard_project",
        description:
          "STAGE onboarding of a new customer project (creates repos — requires human " +
          "CONFIRM <code> in the EOA channel before it runs). Takes a release JSON and " +
          "onboarding YAML. Returns {customerRepo, mirrorRepo} on confirm.",
        parameters: Type.Object({
          releasePath: Type.String({ description: "Path to the release JSON contract" }),
          onboardingPath: Type.String({ description: "Path to the onboarding YAML contract" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const releasePath = argStr(params.releasePath);
          const onboardingPath = argStr(params.onboardingPath);
          return stageWrite(
            `onboard customer project (release=${releasePath}, onboarding=${onboardingPath})`,
            async () => ({
              ok: true,
              status: 200,
              data: eoa(["customer", "onboard", releasePath, onboardingPath], 300000),
            }),
          );
        },
      },
      logger,
    ),
  );

  // eoa_doctor
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_doctor",
        description: "Run health checks on a customer repo. Returns {ok, checks[]}.",
        parameters: Type.Object({
          customerRepoId: Type.String({ description: "Customer repo UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(["customer", "doctor", argStr(params.customerRepoId)]);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_sync
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_sync",
        description:
          "Pull latest from customer repo. Returns {sourceSha, shadowMainSha, driftDetected}.",
        parameters: Type.Object({
          customerRepoId: Type.String({ description: "Customer repo UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(["sync", "pull", argStr(params.customerRepoId)], 180000);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_ingest_issue
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_ingest_issue",
        description:
          "Ingest a single issue from the customer repo. Returns {issueMirrorId, baselineSha}.",
        parameters: Type.Object({
          customerRepoId: Type.String({ description: "Customer repo UUID" }),
          issueNumber: Type.Number({ description: "GitHub issue number to ingest" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa([
              "issue",
              "ingest",
              argStr(params.customerRepoId),
              argStr(params.issueNumber),
            ]);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_ingest_batch
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_ingest_batch",
        description: "Batch ingest issues from a customer repo. Returns {ingested[], skipped[]}.",
        parameters: Type.Object({
          customerRepoId: Type.String({ description: "Customer repo UUID" }),
          limit: Type.Optional(Type.Number({ description: "Max issues to ingest (optional)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(
              [
                "issue",
                "ingest-batch",
                argStr(params.customerRepoId),
                ...(params.limit != null ? ["--limit", argStr(params.limit)] : []),
              ],
              300000,
            );
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_run_execute
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_run_execute",
        description:
          "STAGE a fix run for an issue mirror (spawns an autonomous agent run — requires " +
          "human CONFIRM <code> in the EOA channel before it starts). Returns " +
          "{run, evidenceBundleId} on confirm.",
        parameters: Type.Object({
          issueMirrorId: Type.String({ description: "Issue mirror UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const issueMirrorId = argStr(params.issueMirrorId);
          return stageWrite(`execute fix run for issue mirror ${issueMirrorId}`, async () => ({
            ok: true,
            status: 200,
            data: eoa(["run", "execute", issueMirrorId, "--detach"], 300000),
          }));
        },
      },
      logger,
    ),
  );

  // eoa_run_resume
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_run_resume",
        description:
          "STAGE resuming a previously started run (continues an autonomous agent run — " +
          "requires human CONFIRM <code> in the EOA channel). Returns {run, evidenceBundleId} " +
          "on confirm.",
        parameters: Type.Object({
          runId: Type.String({ description: "Run UUID to resume" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const runId = argStr(params.runId);
          return stageWrite(`resume run ${runId}`, async () => ({
            ok: true,
            status: 200,
            data: eoa(["run", "resume", runId], 300000),
          }));
        },
      },
      logger,
    ),
  );

  // eoa_smoke_test
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_smoke_test",
        description:
          "STAGE a full pipeline smoke test (onboards, ingests, and executes a run — " +
          "requires human CONFIRM <code> in the EOA channel). Returns the complete " +
          "pipeline result on confirm.",
        parameters: Type.Object({
          releasePath: Type.String({ description: "Path to release contract" }),
          onboardingPath: Type.String({ description: "Path to onboarding contract" }),
          issueNumber: Type.Number({ description: "Issue number to test" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const releasePath = argStr(params.releasePath);
          const onboardingPath = argStr(params.onboardingPath);
          const issueNumber = argStr(params.issueNumber);
          return stageWrite(
            `run pipeline smoke test (release=${releasePath}, issue=${issueNumber})`,
            async () => ({
              ok: true,
              status: 200,
              data: eoa(
                ["smoke", "run", releasePath, onboardingPath, issueNumber, "--detach"],
                600000,
              ),
            }),
          );
        },
      },
      logger,
    ),
  );

  // eoa_report
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_report",
        description: "Generate a customer report with all runs. Returns the full CustomerReport.",
        parameters: Type.Object({
          customerRepoId: Type.String({ description: "Customer repo UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(["report", "generate", argStr(params.customerRepoId)], 180000);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
