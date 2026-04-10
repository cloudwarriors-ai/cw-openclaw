import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";

type PluginConfig = { zwsRepos?: string[] };

const DEVTOOLS_BASE = () => process.env.ZWS_DEVTOOLS_API_URL ?? process.env.BIGHEAD_DEVTOOLS_API_URL ?? "http://bighead-devtools-api:9100";
const DEVTOOLS_TOKEN = () => process.env.ZWS_DEV_TOOLS_API ?? process.env.BIGHEAD_DEV_TOOLS_API ?? process.env.DEV_TOOLS_API ?? "";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }] };
}

export function registerCorrelationTools(api: OpenClawPluginApi, logger: AuditLogger, config: PluginConfig) {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_correlate_logs",
        description:
          "Correlate error patterns across ZoomWarriors container logs and GitHub issues. " +
          "Searches container logs via DevTools API and GitHub issues in parallel.",
        parameters: Type.Object({
          pattern: Type.String({ description: "Error pattern to search for (case-insensitive)" }),
          container: Type.Optional(Type.String({ description: "Container to search logs in (default: zoomwarriors2-backend)" })),
          repo: Type.Optional(Type.String({ description: "GitHub repo to search (default: primary ZW2 repo)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const pattern = params.pattern as string;
            const container = (params.container as string) || "zoomwarriors2-backend";
            const repos = config.zwsRepos ?? ["cloudwarriors-ai/zoomwarriors2"];
            const repo = (params.repo as string) || repos[0];

            // Search container logs
            let logMatches: unknown[] = [];
            const token = DEVTOOLS_TOKEN();
            if (token) {
              try {
                const resp = await fetch(
                  `${DEVTOOLS_BASE()}/api/v1/containers/${encodeURIComponent(container)}/logs?tail=500`,
                  { headers: { Authorization: `Bearer ${token}` } },
                );
                if (resp.ok) {
                  const logs = (await resp.json()) as string[];
                  const re = new RegExp(pattern, "i");
                  logMatches = (Array.isArray(logs) ? logs : []).filter((l) => re.test(String(l))).slice(0, 50);
                }
              } catch {
                // DevTools unavailable, continue with GH search
              }
            }

            // Search GitHub issues
            let ghIssues: unknown = [];
            try {
              const escaped = pattern.replace(/"/g, '\\"');
              ghIssues = JSON.parse(
                execSync(
                  `gh search issues "${escaped}" --repo ${repo} --limit 10 --json number,title,state,labels,updatedAt`,
                  { encoding: "utf-8", timeout: 30000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" } },
                ),
              );
            } catch {
              // GH search may fail, continue
            }

            return jsonResult({
              ok: true,
              pattern,
              container,
              logMatches: { count: logMatches.length, lines: logMatches },
              githubIssues: ghIssues,
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
