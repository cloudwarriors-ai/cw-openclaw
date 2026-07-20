import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import type { ScopelyBotConfig } from "./config.js";
import { traceScopelyLogs } from "./devtools-client.js";
import { jsonResult, errorResult } from "./scopely-api.js";

export function registerCorrelationTools(
  api: OpenClawPluginApi,
  logger: AuditLogger,
  config: ScopelyBotConfig,
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
            const container =
              (params.container as string) ||
              process.env.SCOPELY_CONTAINER ||
              "scopely-scopely-backend-1";
            const logResult = await traceScopelyLogs(config, {
              pattern,
              containers: [container],
              tail: params.tail,
              since: params.since,
            });

            // 2. Search GitHub issues for similar patterns
            let ghMatches: unknown = [];
            let ghSource: Record<string, unknown> = { ok: false };
            try {
              const repo = (config.scopelyRepos ?? ["cloudwarriors-ai/scopely"])[0];
              const query = pattern.slice(0, 100);
              // Explicit argv (NO shell): the LLM-controlled query is passed literally.
              const result = execFileSync(
                "gh",
                [
                  "search",
                  "issues",
                  query,
                  "--repo",
                  repo,
                  "--limit",
                  "10",
                  "--json",
                  "number,title,state,labels,createdAt",
                ],
                {
                  encoding: "utf-8",
                  timeout: 15000,
                  env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                },
              );
              ghMatches = JSON.parse(result);
              ghSource = { ok: true };
            } catch (err) {
              ghSource = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }

            return jsonResult({
              ok: logResult.ok || ghSource.ok === true,
              pattern,
              container,
              sources: {
                logs: logResult.results[0]?.source ?? { ok: false, error: "no log result" },
                github: ghSource,
              },
              logMatches: logResult.results[0]?.matches ?? [],
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
