import { Type } from "@sinclair/typebox";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, errorResult } from "./helpers.js";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";

const STATE_DIR = "/root/code/external-org-autopilot/.autopilot-state";

export function registerEoaStateTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // eoa_list_runs
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_list_runs",
        description: "List all autopilot runs. Optionally filter by mirrorRepoId.",
        parameters: Type.Object({
          mirrorRepoId: Type.Optional(Type.String({ description: "Filter runs by mirror repo UUID" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const runsDir = path.join(STATE_DIR, "autopilot-runs");
            if (!fs.existsSync(runsDir)) {
              return jsonResult({ ok: true, data: [], message: "No runs directory found" });
            }
            const files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
            const runs = files.map((f) => {
              const content = fs.readFileSync(path.join(runsDir, f), "utf-8");
              try {
                return JSON.parse(content);
              } catch {
                return { file: f, parseError: true };
              }
            });
            const mirrorFilter = params.mirrorRepoId as string | undefined;
            const filtered = mirrorFilter
              ? runs.filter((r: Record<string, unknown>) => r.mirrorRepoId === mirrorFilter)
              : runs;
            return jsonResult({ ok: true, data: filtered, total: filtered.length });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_get_run
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_get_run",
        description: "Read a specific autopilot run status by ID.",
        parameters: Type.Object({
          runId: Type.String({ description: "Run UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const filePath = path.join(STATE_DIR, "autopilot-runs", `${params.runId}.json`);
            if (!fs.existsSync(filePath)) {
              return jsonResult({ ok: false, error: `Run ${params.runId} not found` });
            }
            const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_get_evidence
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_get_evidence",
        description: "Read a full evidence bundle by ID. Contains verdict, validation summary, runtime evidence, worker summary, and artifact links.",
        parameters: Type.Object({
          bundleId: Type.String({ description: "Evidence bundle UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const filePath = path.join(STATE_DIR, "evidence-bundles", `${params.bundleId}.json`);
            if (!fs.existsSync(filePath)) {
              return jsonResult({ ok: false, error: `Evidence bundle ${params.bundleId} not found` });
            }
            const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_get_workflow_status
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_get_workflow_status",
        description: "Check a GitHub Actions workflow run status. Returns status, conclusion, and jobs.",
        parameters: Type.Object({
          workflowRunId: Type.String({ description: "GitHub Actions workflow run ID" }),
          repo: Type.String({ description: "Shadow repo (owner/name) from the run JSON." }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = params.repo as string;
            if (!repo) {
              return jsonResult({ ok: false, error: "repo is required (shadow repo from run JSON)" });
            }
            const result = execSync(
              `gh run view ${params.workflowRunId} --repo ${repo} --json status,conclusion,jobs,name,createdAt,updatedAt`,
              {
                encoding: "utf-8",
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            const data = JSON.parse(result);
            return jsonResult({ ok: true, data });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_get_workflow_logs
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_get_workflow_logs",
        description: "Download full workflow logs from GitHub Actions. Returns the log output.",
        parameters: Type.Object({
          workflowRunId: Type.String({ description: "GitHub Actions workflow run ID" }),
          repo: Type.String({ description: "Shadow repo (owner/name)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = execSync(
              `gh run view ${params.workflowRunId} --repo ${params.repo} --log`,
              {
                encoding: "utf-8",
                timeout: 60000,
                maxBuffer: 10 * 1024 * 1024,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            // Truncate if very large
            const output = result.length > 50000 ? result.slice(-50000) + "\n...[truncated to last 50k chars]" : result;
            return jsonResult({ ok: true, data: output });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // eoa_get_commit_diff
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_get_commit_diff",
        description: "View what changed in a specific commit (the diff Claude produced).",
        parameters: Type.Object({
          sha: Type.String({ description: "Commit SHA" }),
          repo: Type.String({ description: "Shadow repo (owner/name)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const result = execSync(
              `gh api repos/${params.repo}/commits/${params.sha} --jq '.files[] | {filename, status, additions, deletions, patch}'`,
              {
                encoding: "utf-8",
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            return jsonResult({ ok: true, data: result.trim() });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );
}
