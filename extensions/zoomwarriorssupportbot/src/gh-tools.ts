import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, errorResult } from "./zws-api.js";
import type { AuditLogger } from "./audit.js";
import { wrapToolWithAudit } from "./audit.js";
import {
  buildStakeholderWorkPrefix,
  extractStakeholdersFromIssue,
  formatStakeholderBlock,
  parseIssueNumberFromUrl,
  resolveStakeholderDmTarget,
  upsertStakeholderBlock,
} from "./stakeholders.js";
import { sendStakeholderZoomDm } from "./zoom-dm.js";

type PluginConfig = { zwsRepos?: string[] };

function getAllowedRepos(config: PluginConfig): string[] {
  return config.zwsRepos ?? ["cloudwarriors-ai/zoomwarriors2"];
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

function formatStakeholderDmMessage(params: {
  issueNumber: number;
  issueTitle: string;
  repo: string;
  closedBy?: string;
  closingComment?: string;
}): string {
  const issueUrl = `https://github.com/${params.repo}/issues/${params.issueNumber}`;
  const lines = [
    `Issue #${params.issueNumber} was updated and closed: ${params.issueTitle}`,
    params.closedBy ? `Closed by: ${params.closedBy}` : undefined,
    params.closingComment ? `Update: ${params.closingComment}` : undefined,
    issueUrl,
  ].filter(Boolean);
  return lines.join("\n");
}

export function registerGhTools(api: OpenClawPluginApi, logger: AuditLogger, config: PluginConfig) {
  // zws_gh_list_issues
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_gh_list_issues",
        description: "List GitHub issues from a ZoomWarriors2 repo. Returns title, number, state, labels, assignees.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name). Defaults to primary ZW2 repo." })),
          state: Type.Optional(Type.String({ description: "Filter: open, closed, all (default: open)" })),
          label: Type.Optional(Type.String({ description: "Filter by label" })),
          limit: Type.Optional(Type.Number({ description: "Max results (default 30)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const state = (params.state as string) || "open";
            const limit = (params.limit as number) || 30;
            const labelFlag = params.label ? ` --label "${params.label}"` : "";
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

  // zws_gh_get_issue
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_gh_get_issue",
        description: "Get details of a specific GitHub issue including comments and parsed stakeholder metadata.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name). Defaults to primary ZW2 repo." })),
          number: Type.Number({ description: "Issue number" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const data = gh(
              `issue view ${params.number} --repo ${repo} --json number,url,title,body,state,labels,assignees,comments,createdAt,updatedAt,closedAt`,
            ) as GhIssueLike;
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

  // zws_gh_create_issue
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_gh_create_issue",
        description:
          "Create a new GitHub issue in a ZoomWarriors2 repo. Persists reporter/stakeholders in a machine-readable metadata block.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name). Defaults to primary ZW2 repo." })),
          title: Type.String({ description: "Issue title" }),
          body: Type.String({ description: "Issue body (markdown)" }),
          labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply" })),
          reporter: Type.Optional(
            Type.String({ description: "Reporter identity (email, @github-user, or Zoom JID)." }),
          ),
          stakeholders: Type.Optional(
            Type.Array(Type.String(), { description: "Additional stakeholder identities." }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const labels = params.labels as string[] | undefined;
            const labelFlag = labels?.length ? ` --label "${labels.join(",")}"` : "";
            const bodyStr = String(params.body ?? "");
            const reporter = typeof params.reporter === "string" ? params.reporter : undefined;
            const stakeholders = Array.isArray(params.stakeholders)
              ? (params.stakeholders as string[])
              : [];
            const enrichedBody = upsertStakeholderBlock(bodyStr, { reporter, stakeholders });

            const result = execSync(
              `gh issue create --repo ${repo} --title "${(params.title as string).replace(/"/g, '\\"')}"${labelFlag} --body-file -`,
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
              const metadataComment = formatStakeholderBlock({ reporter, stakeholders });
              execSync(
                `gh issue comment ${issueNumber} --repo ${repo} --body-file -`,
                {
                  encoding: "utf-8",
                  input: metadataComment,
                  timeout: 30000,
                  env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                },
              );
            }

            return jsonResult({ ok: true, url, issueNumber, reporter, stakeholders, metadataSaved: Boolean(issueNumber) });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_gh_add_comment
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_gh_add_comment",
        description: "Add a comment to an existing GitHub issue. Auto-mentions stored stakeholders.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name). Defaults to primary ZW2 repo." })),
          number: Type.Number({ description: "Issue number" }),
          body: Type.String({ description: "Comment body (markdown)" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const issue = gh(
              `issue view ${params.number} --repo ${repo} --json number,url,title,body,assignees,comments`,
            ) as GhIssueLike;
            const extracted = extractStakeholdersFromIssue(issue);
            const prefix = buildStakeholderWorkPrefix(extracted.stakeholders);
            const originalBody = String(params.body ?? "");
            const body =
              prefix && !/^\s*(\/cc|Stakeholders:)/im.test(originalBody)
                ? `${prefix}\n\n${originalBody}`
                : originalBody;

            const result = execSync(
              `gh issue comment ${params.number} --repo ${repo} --body-file -`,
              {
                encoding: "utf-8",
                input: body,
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            );
            return jsonResult({ ok: true, url: result.trim(), stakeholders: extracted.stakeholders, reporter: extracted.reporter });
          } catch (err) {
            return errorResult(err);
          }
        },
      },
      logger,
    ),
  );

  // zws_gh_search_issues
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_gh_search_issues",
        description: "Search GitHub issues by keyword in ZoomWarriors2 repos.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          repo: Type.Optional(Type.String({ description: "Repo (owner/name). Defaults to primary ZW2 repo." })),
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

  // zws_gh_close_issue
  api.registerTool(() =>
    wrapToolWithAudit(
      {
        name: "zws_gh_close_issue",
        description: "Close a GitHub issue, mention stakeholders in a closing comment, and DM stakeholders on Zoom.",
        parameters: Type.Object({
          repo: Type.Optional(Type.String({ description: "Repo (owner/name). Defaults to primary ZW2 repo." })),
          number: Type.Number({ description: "Issue number" }),
          comment: Type.Optional(Type.String({ description: "Closing update comment to post before close." })),
          reason: Type.Optional(Type.String({ description: "Close reason: completed or not_planned." })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const repo = (params.repo as string) || getAllowedRepos(config)[0];
            assertAllowedRepo(repo, config);
            const issueNumber = Number(params.number);
            const closeReason = stringifyReason(params.reason);
            const closingComment = typeof params.comment === "string" ? params.comment.trim() : "";

            const issue = gh(
              `issue view ${issueNumber} --repo ${repo} --json number,url,title,body,assignees,comments`,
            ) as GhIssueLike;
            const extracted = extractStakeholdersFromIssue(issue);
            const prefix = buildStakeholderWorkPrefix(extracted.stakeholders);
            if (closingComment || prefix) {
              const commentBody = [prefix, closingComment].filter(Boolean).join("\n\n").trim();
              if (commentBody) {
                execSync(
                  `gh issue comment ${issueNumber} --repo ${repo} --body-file -`,
                  {
                    encoding: "utf-8",
                    input: commentBody,
                    timeout: 30000,
                    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
                  },
                );
              }
            }

            const closeOutput = execSync(
              `gh issue close ${issueNumber} --repo ${repo} --reason "${closeReason}"`,
              {
                encoding: "utf-8",
                timeout: 30000,
                env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
              },
            ).trim();

            const dmTargets = extracted.stakeholders
              .map((stakeholder) =>
                resolveStakeholderDmTarget(stakeholder, {
                  mapEnv: process.env.ZWS_STAKEHOLDER_MAP,
                  defaultDomain: process.env.ZWS_STAKEHOLDER_EMAIL_DOMAIN,
                }),
              )
              .filter((value): value is string => Boolean(value));

            const uniqueTargets = [...new Set(dmTargets.map((target) => target.toLowerCase()))];
            const issueTitle = issue.title || `Issue ${issueNumber}`;
            const dmMessage = formatStakeholderDmMessage({
              issueNumber,
              issueTitle,
              repo,
              closedBy: "zoomwarriorssupportbot",
              closingComment,
            });

            const notified: string[] = [];
            const notifyErrors: Array<{ stakeholder: string; error: string }> = [];
            for (const stakeholder of uniqueTargets) {
              const dmResult = await sendStakeholderZoomDm({ toContact: stakeholder, message: dmMessage });
              if (dmResult.ok) notified.push(stakeholder);
              else notifyErrors.push({ stakeholder, error: dmResult.error ?? "unknown error" });
            }

            return jsonResult({
              ok: true, number: issueNumber, repo, closeOutput, closeReason,
              stakeholders: extracted.stakeholders, reporter: extracted.reporter,
              notified, notifyErrors,
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
