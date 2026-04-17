import { execSync } from "child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { jsonResult, errorResult } from "./scopely-api.js";

const DEVTOOLS_BASE = () => process.env.DEVTOOLS_API_URL ?? "https://devtools-api.cloudwarriors.ai";
const DEVTOOLS_TOKEN = () => process.env.DEV_TOOLS_API ?? "";

type PluginConfig = { scopelyRepos?: string[] };

export function registerCorrelationTools(
  api: OpenClawPluginApi,
  logger: AuditLogger,
  config: PluginConfig,
) {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_correlate_errors",
        description:
          "Correlate an error pattern across Scopely container logs and GitHub issues. " +
          "Searches Docker logs via devtools API and GH issues for matching patterns, then returns correlated results. " +
          "Use this to investigate an error across all data sources at once.",
        parameters: Type.Object({
          pattern: Type.String({ description: "Error pattern or message to search for" }),
          container: Type.Optional(
            Type.String({
              description: "Container name to search logs in (default: scopely app container)",
            }),
          ),
          since: Type.Optional(
            Type.String({
              description: "Log time range start (e.g. '1h', '2024-01-01T00:00:00Z')",
            }),
          ),
          tail: Type.Optional(
            Type.Number({ description: "Number of log lines to search (default 500)" }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const pattern = params.pattern as string;
            const container = (params.container as string) || "dev-scopely";
            const tail = (params.tail as number) || 500;
            const since = params.since as string | undefined;

            // 1. Search container logs via devtools API
            let logMatches: string[] = [];
            const token = DEVTOOLS_TOKEN();
            if (token) {
              const qs = new URLSearchParams({ tail: String(tail) });
              if (since) {
                qs.set("since", since);
              }
              try {
                const resp = await fetch(
                  `${DEVTOOLS_BASE()}/api/v1/containers/${encodeURIComponent(container)}/logs?${qs}`,
                  { headers: { Authorization: `Bearer ${token}` } },
                );
                if (resp.ok) {
                  const data = (await resp.json()) as { logs?: string };
                  const logText =
                    typeof data === "string" ? data : (data.logs ?? JSON.stringify(data));
                  const lines = logText.split("\n");
                  const lowerPattern = pattern.toLowerCase();
                  logMatches = lines.filter((l: string) => l.toLowerCase().includes(lowerPattern));
                }
              } catch {
                // devtools unavailable, continue with GH search
              }
            }

            // 2. Search GitHub issues for similar patterns
            let ghMatches: unknown = [];
            try {
              const repo = (config.scopelyRepos ?? ["cloudwarriors-ai/scopely"])[0];
              const query = pattern.replace(/"/g, '\\"').slice(0, 100);
              const result = execSync(
                `gh search issues "${query}" --repo ${repo} --limit 10 --json number,title,state,labels,createdAt`,
                {
                  encoding: "utf-8",
                  timeout: 15000,
                  env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                },
              );
              ghMatches = JSON.parse(result);
            } catch {
              // gh search failed, continue
            }

            return jsonResult({
              ok: true,
              pattern,
              container,
              logMatches: {
                count: logMatches.length,
                lines: logMatches.slice(0, 50),
              },
              ghIssues: ghMatches,
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
