import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, errorResult } from "./helpers.js";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";

const EOA_ROOT = "/root/code/external-org-autopilot";

function eoa(args: string, timeoutMs = 120000): unknown {
  const result = execSync(`npx tsx src/cli.ts ${args}`, {
    encoding: "utf-8",
    cwd: EOA_ROOT,
    timeout: timeoutMs,
    env: { ...process.env },
  });
  try {
    return JSON.parse(result);
  } catch {
    return result.trim();
  }
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
            const data = eoa(`release validate ${params.releasePath}`);
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
            const data = eoa(`release lock ${params.releasePath} --out ${params.outPath}`);
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
        description: "Onboard a new customer project. Takes a release JSON and onboarding YAML. Returns {customerRepo, mirrorRepo}.",
        parameters: Type.Object({
          releasePath: Type.String({ description: "Path to the release JSON contract" }),
          onboardingPath: Type.String({ description: "Path to the onboarding YAML contract" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(`customer onboard ${params.releasePath} ${params.onboardingPath}`, 300000);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
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
            const data = eoa(`customer doctor ${params.customerRepoId}`);
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
        description: "Pull latest from customer repo. Returns {sourceSha, shadowMainSha, driftDetected}.",
        parameters: Type.Object({
          customerRepoId: Type.String({ description: "Customer repo UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(`sync pull ${params.customerRepoId}`, 180000);
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
        description: "Ingest a single issue from the customer repo. Returns {issueMirrorId, baselineSha}.",
        parameters: Type.Object({
          customerRepoId: Type.String({ description: "Customer repo UUID" }),
          issueNumber: Type.Number({ description: "GitHub issue number to ingest" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(`issue ingest ${params.customerRepoId} ${params.issueNumber}`);
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
            const limitFlag = params.limit ? ` --limit ${params.limit}` : "";
            const data = eoa(`issue ingest-batch ${params.customerRepoId}${limitFlag}`, 300000);
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
        description: "Execute a fix run for an issue mirror. Returns {run, evidenceBundleId}.",
        parameters: Type.Object({
          issueMirrorId: Type.String({ description: "Issue mirror UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(`run execute ${params.issueMirrorId} --detach`, 300000);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
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
        description: "Resume a previously started run. Returns {run, evidenceBundleId}.",
        parameters: Type.Object({
          runId: Type.String({ description: "Run UUID to resume" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(`run resume ${params.runId}`, 300000);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
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
        description: "Run a full pipeline smoke test. Returns the complete pipeline result.",
        parameters: Type.Object({
          releasePath: Type.String({ description: "Path to release contract" }),
          onboardingPath: Type.String({ description: "Path to onboarding contract" }),
          issueNumber: Type.Number({ description: "Issue number to test" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const data = eoa(
              `smoke run ${params.releasePath} ${params.onboardingPath} ${params.issueNumber} --detach`,
              600000,
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
            const data = eoa(`report generate ${params.customerRepoId}`, 180000);
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
