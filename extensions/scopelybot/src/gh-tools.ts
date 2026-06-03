import { execSync } from "child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { jsonResult, errorResult } from "./scopely-api.js";

type PluginConfig = { scopelyRepos?: string[] };

function getAllowedRepos(config: PluginConfig): string[] {
  return config.scopelyRepos ?? ["cloudwarriors-ai/scopely"];
}

function assertAllowedRepo(repo: string, config: PluginConfig) {
  const allowed = getAllowedRepos(config);
  if (!allowed.includes(repo)) {
    throw new Error(`Repo "${repo}" not in allowed list: ${allowed.join(", ")}`);
  }
}

function gh(args: string): unknown {
  const result = execSync(`gh ${args}`, {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
  });
  try {
    return JSON.parse(result);
  } catch {
    return result.trim();
  }
}

export function registerGhTools(api: OpenClawPluginApi, logger: AuditLogger, config: PluginConfig) {
  // scopely_gh_list_issues
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_gh_list_issues",
        description:
          "List GitHub issues from a Scopely repo. Returns title, number, state, labels, assignees.",
        parameters: Type.Object({
          repo: Type.Optional(
            Type.String({ description: "Repo (owner/name). Defaults to primary Scopely repo." }),
          ),
          state: Type.Optional(
            Type.String({ description: "Filter: open, closed, all (default: open)" }),
          ),
          label: Type.Optional(Type.String({ description: "Filter by label" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const state = (params.state as string) || "open";
            const limit = (params.limit as number) || 30;
            const label = typeof params.label === "string" ? params.label : "";
            const labelFlag = label ? ` --label "${label}"` : "";
            const data = gh(
              `issue list --repo ${repo} --state ${state} --limit ${limit}${labelFlag} --json number,title,state,labels,assignees,createdAt,updatedAt`,
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

  // scopely_gh_get_issue
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_gh_get_issue",
        description: "Get details of a specific GitHub issue including body and comments.",
        parameters: Type.Object({
          repo: Type.Optional(
            Type.String({ description: "Repo (owner/name). Defaults to primary Scopely repo." }),
          ),
          number: Type.Number({ description: "Issue number" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const issueNumber = Number(params.number);
            const data = gh(
              `issue view ${issueNumber} --repo ${repo} --json number,url,title,body,state,labels,assignees,comments,createdAt,updatedAt,closedAt`,
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

  // scopely_gh_create_issue
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_gh_create_issue",
        description: "Create a new GitHub issue in a Scopely repo for tracking bugs or tasks.",
        parameters: Type.Object({
          repo: Type.Optional(
            Type.String({ description: "Repo (owner/name). Defaults to primary Scopely repo." }),
          ),
          title: Type.String({ description: "Issue title" }),
          body: Type.String({ description: "Issue body (markdown)" }),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const labels = params.labels as string[] | undefined;
            const labelFlag = labels?.length ? ` --label "${labels.join(",")}"` : "";
            const body = typeof params.body === "string" ? params.body : "";
            const result = execSync(
              `gh issue create --repo ${repo} --title "${(params.title as string).replace(/"/g, '\\"')}"${labelFlag} --body-file -`,
              {
                encoding: "utf-8",
                input: body,
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            return jsonResult({ ok: true, url: result.trim() });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_gh_add_comment
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_gh_add_comment",
        description: "Add a comment to an existing GitHub issue.",
        parameters: Type.Object({
          repo: Type.Optional(
            Type.String({ description: "Repo (owner/name). Defaults to primary Scopely repo." }),
          ),
          number: Type.Number({ description: "Issue number" }),
          body: Type.String({ description: "Comment body (markdown)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const issueNumber = Number(params.number);
            const body = typeof params.body === "string" ? params.body : "";
            const result = execSync(
              `gh issue comment ${issueNumber} --repo ${repo} --body-file -`,
              {
                encoding: "utf-8",
                input: body,
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            return jsonResult({ ok: true, url: result.trim() });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // scopely_gh_search_issues
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_gh_search_issues",
        description: "Search GitHub issues by keyword in Scopely repos.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          repo: Type.Optional(
            Type.String({ description: "Repo (owner/name). Defaults to primary Scopely repo." }),
          ),
          limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const limit = (params.limit as number) || 20;
            const query = (params.query as string).replace(/"/g, '\\"');
            const data = gh(
              `search issues "${query}" --repo ${repo} --limit ${limit} --json number,title,state,labels,repository,createdAt,updatedAt`,
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

  // scopely_gh_close_issue
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "scopely_gh_close_issue",
        description: "Close a GitHub issue with an optional closing comment.",
        parameters: Type.Object({
          repo: Type.Optional(
            Type.String({ description: "Repo (owner/name). Defaults to primary Scopely repo." }),
          ),
          number: Type.Number({ description: "Issue number" }),
          comment: Type.Optional(
            Type.String({ description: "Closing comment to post before closing." }),
          ),
          reason: Type.Optional(
            Type.String({ description: "Close reason: completed or not_planned." }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const issueNumber = Number(params.number);
            const reason =
              typeof params.reason === "string" &&
              params.reason.trim().toLowerCase() === "not_planned"
                ? "not planned"
                : "completed";
            const closingComment = typeof params.comment === "string" ? params.comment.trim() : "";

            if (closingComment) {
              execSync(`gh issue comment ${issueNumber} --repo ${repo} --body-file -`, {
                encoding: "utf-8",
                input: closingComment,
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              });
            }

            const closeOutput = execSync(
              `gh issue close ${issueNumber} --repo ${repo} --reason "${reason}"`,
              {
                encoding: "utf-8",
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            ).trim();

            return jsonResult({
              ok: true,
              number: issueNumber,
              repo,
              closeOutput,
              closeReason: reason,
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
