import { execFileSync } from "node:child_process";
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

// Run gh with an explicit argv (NO shell). Every element is passed literally, so
// LLM-controlled values (issue numbers, search queries, labels, titles) cannot be
// interpreted as shell syntax — `$(...)`, backticks, quotes, and `;` are inert.
// Never reintroduce a shell string here.
function gh(args: string[]): unknown {
  const result = execFileSync("gh", args, {
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

// gh accepts only these issue states; reject anything else with a clear error
// instead of shelling out to a guaranteed-failing invocation.
function normalizeIssueState(value: unknown): string {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "open";
  if (s === "open" || s === "closed" || s === "all") {
    return s;
  }
  throw new Error(
    `Invalid state "${typeof value === "string" ? value : ""}": must be open, closed, or all.`,
  );
}

// Issue numbers flow into the gh argv. Coerce to a positive integer so a malformed
// value fails fast with a clear error rather than reaching gh.
function assertIssueNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid issue number: ${JSON.stringify(value)}`);
  }
  return n;
}

// Clamp the gh --limit argv to a sane positive integer.
function normalizeLimit(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return fallback;
  }
  return Math.min(n, 200);
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
            const state = normalizeIssueState(params.state);
            const limit = normalizeLimit(params.limit, 30);
            const label = typeof params.label === "string" ? params.label : "";
            const data = gh([
              "issue",
              "list",
              "--repo",
              repo,
              "--state",
              state,
              "--limit",
              String(limit),
              ...(label ? ["--label", label] : []),
              "--json",
              "number,title,state,labels,assignees,createdAt,updatedAt",
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
            const issueNumber = assertIssueNumber(params.number);
            const data = gh([
              "issue",
              "view",
              String(issueNumber),
              "--repo",
              repo,
              "--json",
              "number,url,title,body,state,labels,assignees,comments,createdAt,updatedAt,closedAt",
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
            const title = typeof params.title === "string" ? params.title : "";
            const body = typeof params.body === "string" ? params.body : "";
            const result = execFileSync(
              "gh",
              [
                "issue",
                "create",
                "--repo",
                repo,
                "--title",
                title,
                ...(labels?.length ? ["--label", labels.join(",")] : []),
                "--body-file",
                "-",
              ],
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
            const issueNumber = assertIssueNumber(params.number);
            const body = typeof params.body === "string" ? params.body : "";
            const result = execFileSync(
              "gh",
              ["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"],
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
            const limit = normalizeLimit(params.limit, 20);
            const query = typeof params.query === "string" ? params.query : "";
            const data = gh([
              "search",
              "issues",
              query,
              "--repo",
              repo,
              "--limit",
              String(limit),
              "--json",
              "number,title,state,labels,repository,createdAt,updatedAt",
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
            const issueNumber = assertIssueNumber(params.number);
            const reason =
              typeof params.reason === "string" &&
              params.reason.trim().toLowerCase() === "not_planned"
                ? "not planned"
                : "completed";
            const closingComment = typeof params.comment === "string" ? params.comment.trim() : "";

            if (closingComment) {
              execFileSync(
                "gh",
                ["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"],
                {
                  encoding: "utf-8",
                  input: closingComment,
                  timeout: 30000,
                  env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                },
              );
            }

            const closeOutput = execFileSync(
              "gh",
              ["issue", "close", String(issueNumber), "--repo", repo, "--reason", reason],
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
