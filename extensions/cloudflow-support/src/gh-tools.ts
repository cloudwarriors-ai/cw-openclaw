import { execFileSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import { stageWrite } from "./gated.js";
import { jsonResult, errorResult } from "./helpers.js";
import {
  buildStakeholderWorkPrefix,
  extractStakeholdersFromIssue,
  formatStakeholderBlock,
  parseIssueNumberFromUrl,
  resolveStakeholderDmTarget,
  upsertStakeholderBlock,
} from "./stakeholders.js";
import { sendStakeholderZoomDm } from "./zoom-dm.js";

type PluginConfig = { cfRepos?: string[] };

function getAllowedRepos(config: PluginConfig): string[] {
  return config.cfRepos ?? ["cloudwarriors-ai/cloudflow"];
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

type GhIssueLike = {
  number?: number;
  url?: string;
  title?: string;
  body?: string;
  assignees?: Array<{ login?: string }>;
  comments?: Array<{ body?: string }>;
};

function stringifyReason(reason: unknown): string {
  const raw = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  return raw === "not_planned" ? "not planned" : "completed";
}

function formatDmMessage(p: {
  issueNumber: number;
  issueTitle: string;
  repo: string;
  closedBy?: string;
  closingComment?: string;
}): string {
  const url = `https://github.com/${p.repo}/issues/${p.issueNumber}`;
  return [
    `Issue #${p.issueNumber} was updated and closed: ${p.issueTitle}`,
    p.closedBy ? `Closed by: ${p.closedBy}` : undefined,
    p.closingComment ? `Update: ${p.closingComment}` : undefined,
    url,
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerGhTools(api: OpenClawPluginApi, logger: AuditLogger, config: PluginConfig) {
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_gh_list_issues",
        description: "List GitHub issues from the CloudFlow repo.",
        parameters: Type.Object({
          repo: Type.Optional(
            Type.String({ description: "Repo (owner/name). Defaults to primary CF repo." }),
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
            const data = gh([
              "issue",
              "list",
              "--repo",
              repo,
              "--state",
              state,
              "--limit",
              String(limit),
              ...(typeof params.label === "string" && params.label
                ? ["--label", params.label]
                : []),
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

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_gh_get_issue",
        description:
          "Get details of a specific GitHub issue including comments and stakeholder metadata.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
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
            ]) as GhIssueLike;
            const stakeholders = extractStakeholdersFromIssue(data);
            return jsonResult({ ok: true, data, stakeholders });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_gh_create_issue",
        description: "Create a new GitHub issue in the CloudFlow repo with stakeholder metadata.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
          title: Type.String({ description: "Issue title" }),
          body: Type.String({ description: "Issue body (markdown)" }),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply" })),
          reporter: Type.Optional(Type.String({ description: "Reporter identity." })),
          stakeholders: Type.Optional(
            Type.Array(Type.String(), { description: "Additional stakeholder identities." }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config); // validate now; mutation is deferred to confirm
            const summary = `create GitHub issue "${params.title as string}" in ${repo}`;
            return await stageWrite(summary, async () => {
              const labels = params.labels as string[] | undefined;
              const title = typeof params.title === "string" ? params.title : "";
              const reporter = typeof params.reporter === "string" ? params.reporter : undefined;
              const stakeholders = Array.isArray(params.stakeholders)
                ? (params.stakeholders as string[])
                : [];
              const enrichedBody = upsertStakeholderBlock(
                typeof params.body === "string" ? params.body : "",
                {
                  reporter,
                  stakeholders,
                },
              );
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
                  input: enrichedBody,
                  timeout: 30000,
                  env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                },
              );
              const url = result.trim();
              const issueNumber = parseIssueNumberFromUrl(url);
              if (issueNumber) {
                execFileSync(
                  "gh",
                  ["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"],
                  {
                    encoding: "utf-8",
                    input: formatStakeholderBlock({ reporter, stakeholders }),
                    timeout: 30000,
                    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                  },
                );
              }
              return {
                ok: true,
                status: 200,
                data: {
                  url,
                  issueNumber,
                  reporter,
                  stakeholders,
                  metadataSaved: Boolean(issueNumber),
                },
              };
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_gh_add_comment",
        description: "Add a comment to a GitHub issue. Auto-mentions stored stakeholders.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
          number: Type.Number({ description: "Issue number" }),
          body: Type.String({ description: "Comment body (markdown)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config); // validate now; mutation is deferred to confirm
            const issueNumber = assertIssueNumber(params.number);
            const summary = `add comment to issue #${issueNumber} in ${repo}`;
            return await stageWrite(summary, async () => {
              const issue = gh([
                "issue",
                "view",
                String(issueNumber),
                "--repo",
                repo,
                "--json",
                "number,url,title,body,assignees,comments",
              ]) as GhIssueLike;
              const extracted = extractStakeholdersFromIssue(issue);
              const prefix = buildStakeholderWorkPrefix(extracted.stakeholders);
              const originalBody = typeof params.body === "string" ? params.body : "";
              const body =
                prefix && !/^\s*(\/cc|Stakeholders:)/im.test(originalBody)
                  ? `${prefix}\n\n${originalBody}`
                  : originalBody;
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
              return {
                ok: true,
                status: 200,
                data: {
                  url: result.trim(),
                  stakeholders: extracted.stakeholders,
                  reporter: extracted.reporter,
                },
              };
            });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_gh_search_issues",
        description: "Search GitHub issues by keyword in CloudFlow repos.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
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

  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "cf_gh_close_issue",
        description: "Close a GitHub issue, mention stakeholders, and DM them on Zoom.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
          number: Type.Number({ description: "Issue number" }),
          comment: Type.Optional(Type.String({ description: "Closing comment." })),
          reason: Type.Optional(
            Type.String({ description: "Close reason: completed or not_planned." }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config); // validate now; mutation is deferred to confirm
            const issueNumber = assertIssueNumber(params.number);
            const closeReason = stringifyReason(params.reason);
            const closingComment = typeof params.comment === "string" ? params.comment.trim() : "";
            const summary = `close issue #${issueNumber} in ${repo} (${closeReason})`;
            return await stageWrite(summary, async () => {
              const issue = gh([
                "issue",
                "view",
                String(issueNumber),
                "--repo",
                repo,
                "--json",
                "number,url,title,body,assignees,comments",
              ]) as GhIssueLike;
              const extracted = extractStakeholdersFromIssue(issue);
              const prefix = buildStakeholderWorkPrefix(extracted.stakeholders);
              if (closingComment || prefix) {
                const commentBody = [prefix, closingComment].filter(Boolean).join("\n\n").trim();
                if (commentBody) {
                  execFileSync(
                    "gh",
                    ["issue", "comment", String(issueNumber), "--repo", repo, "--body-file", "-"],
                    {
                      encoding: "utf-8",
                      input: commentBody,
                      timeout: 30000,
                      env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                    },
                  );
                }
              }
              const closeOutput = execFileSync(
                "gh",
                ["issue", "close", String(issueNumber), "--repo", repo, "--reason", closeReason],
                {
                  encoding: "utf-8",
                  timeout: 30000,
                  env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                },
              ).trim();
              const dmTargets = extracted.stakeholders
                .map((s) =>
                  resolveStakeholderDmTarget(s, {
                    mapEnv: process.env.CF_STAKEHOLDER_MAP,
                    defaultDomain: process.env.CF_STAKEHOLDER_EMAIL_DOMAIN,
                  }),
                )
                .filter((v): v is string => Boolean(v));
              const uniqueTargets = [...new Set(dmTargets.map((t) => t.toLowerCase()))];
              const dmMessage = formatDmMessage({
                issueNumber,
                issueTitle: issue.title || `Issue ${issueNumber}`,
                repo,
                closedBy: "cloudflow-support",
                closingComment,
              });
              const notified: string[] = [];
              const notifyErrors: Array<{ stakeholder: string; error: string }> = [];
              for (const target of uniqueTargets) {
                const r = await sendStakeholderZoomDm({ toContact: target, message: dmMessage });
                if (r.ok) {
                  notified.push(target);
                } else {
                  notifyErrors.push({ stakeholder: target, error: r.error ?? "unknown" });
                }
              }
              return {
                ok: true,
                status: 200,
                data: {
                  number: issueNumber,
                  repo,
                  closeOutput,
                  closeReason,
                  stakeholders: extracted.stakeholders,
                  reporter: extracted.reporter,
                  notified,
                  notifyErrors,
                },
              };
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
