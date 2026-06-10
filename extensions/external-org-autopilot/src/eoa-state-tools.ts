import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { jsonResult, errorResult } from "./helpers.js";

// Env-driven so the deploy host can relocate the checkout/state; defaults match
// the current production container layout (state lives inside the EOA checkout).
const STATE_DIR = () =>
  process.env.EOA_STATE_DIR ??
  path.join(process.env.EOA_ROOT ?? "/root/code/external-org-autopilot", ".autopilot-state");

// GitHub Actions run IDs are numeric. Validate so the value is a sane argv element.
function assertRunId(value: unknown): string {
  const s =
    typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!/^\d+$/.test(s)) {
    throw new Error(`Invalid workflow run ID: ${JSON.stringify(value)}`);
  }
  return s;
}

// owner/name. Reject anything that could alter a gh api path (extra slashes, traversal).
function assertRepoSlug(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) {
    throw new Error(`Invalid repo "${s}": expected owner/name.`);
  }
  return s;
}

// 7-40 char hex commit SHA. Reject anything that could alter the gh api path.
function assertCommitSha(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-fA-F]{7,40}$/.test(s)) {
    throw new Error(`Invalid commit SHA: ${JSON.stringify(value)}`);
  }
  return s;
}

export function registerEoaStateTools(api: OpenClawPluginApi, logger: AuditLogger) {
  // eoa_list_runs
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "eoa_list_runs",
        description: "List all autopilot runs. Optionally filter by mirrorRepoId.",
        parameters: Type.Object({
          mirrorRepoId: Type.Optional(
            Type.String({ description: "Filter runs by mirror repo UUID" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const runsDir = path.join(STATE_DIR(), "autopilot-runs");
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
            const filePath = path.join(STATE_DIR(), "autopilot-runs", `${params.runId}.json`);
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
        description:
          "Read a full evidence bundle by ID. Contains verdict, validation summary, runtime evidence, worker summary, and artifact links.",
        parameters: Type.Object({
          bundleId: Type.String({ description: "Evidence bundle UUID" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const filePath = path.join(STATE_DIR(), "evidence-bundles", `${params.bundleId}.json`);
            if (!fs.existsSync(filePath)) {
              return jsonResult({
                ok: false,
                error: `Evidence bundle ${params.bundleId} not found`,
              });
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
        description:
          "Check a GitHub Actions workflow run status. Returns status, conclusion, and jobs.",
        parameters: Type.Object({
          workflowRunId: Type.String({ description: "GitHub Actions workflow run ID" }),
          repo: Type.String({ description: "Shadow repo (owner/name) from the run JSON." }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = assertRepoSlug(params.repo);
            const runId = assertRunId(params.workflowRunId);
            const result = execFileSync(
              "gh",
              [
                "run",
                "view",
                runId,
                "--repo",
                repo,
                "--json",
                "status,conclusion,jobs,name,createdAt,updatedAt",
              ],
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
            const repo = assertRepoSlug(params.repo);
            const runId = assertRunId(params.workflowRunId);
            const result = execFileSync("gh", ["run", "view", runId, "--repo", repo, "--log"], {
              encoding: "utf-8",
              timeout: 60000,
              maxBuffer: 10 * 1024 * 1024,
              env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
            });
            // Truncate if very large
            const output =
              result.length > 50000
                ? result.slice(-50000) + "\n...[truncated to last 50k chars]"
                : result;
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
            const repo = assertRepoSlug(params.repo);
            const sha = assertCommitSha(params.sha);
            // argv: the path is one literal element and --jq gets the expression
            // verbatim (the shell single-quotes were quoting, not part of the value).
            const result = execFileSync(
              "gh",
              [
                "api",
                `repos/${repo}/commits/${sha}`,
                "--jq",
                ".files[] | {filename, status, additions, deletions, patch}",
              ],
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
