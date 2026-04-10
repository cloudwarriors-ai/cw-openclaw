import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { jsonResult, errorResult } from "./helpers.js";
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

type PluginConfig = { cfRepos?: string[] };

function getAllowedRepos(config: PluginConfig): string[] {
  return config.cfRepos ?? ["cloudwarriors-ai/cloudflow"];
}

function assertAllowedRepo(repo: string, config: PluginConfig) {
  const allowed = getAllowedRepos(config);
  if (!allowed.includes(repo)) throw new Error(`Repo "${repo}" not in allowed list: ${allowed.join(", ")}`);
}

function gh(args: string): unknown {
  const result = execSync(`gh ${args}`, {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
  });
  try { return JSON.parse(result); } catch { return result.trim(); }
}

type GhIssueLike = {
  number?: number; url?: string; title?: string; body?: string;
  assignees?: Array<{ login?: string }>; comments?: Array<{ body?: string }>;
};

function stringifyReason(reason: unknown): string {
  const raw = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  return raw === "not_planned" ? "not planned" : "completed";
}

function formatDmMessage(p: { issueNumber: number; issueTitle: string; repo: string; closedBy?: string; closingComment?: string }): string {
  const url = `https://github.com/${p.repo}/issues/${p.issueNumber}`;
  return [
    `Issue #${p.issueNumber} was updated and closed: ${p.issueTitle}`,
    p.closedBy ? `Closed by: ${p.closedBy}` : undefined,
    p.closingComment ? `Update: ${p.closingComment}` : undefined,
    url,
  ].filter(Boolean).join("\n");
}

export function registerGhTools(api: OpenClawPluginApi, logger: AuditLogger, config: PluginConfig) {
  api.registerTool(() => wrapToolWithAudit({
    name: "cf_gh_list_issues",
    description: "List GitHub issues from the CloudFlow repo.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Repo (owner/name). Defaults to primary CF repo." })),
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
        const data = gh(`issue list --repo ${repo} --state ${state} --limit ${limit}${labelFlag} --json number,title,state,labels,assignees,createdAt,updatedAt`);
        return jsonResult({ ok: true, data });
      } catch (err) { return errorResult(err); }
    },
  }, logger));

  api.registerTool(() => wrapToolWithAudit({
    name: "cf_gh_get_issue",
    description: "Get details of a specific GitHub issue including comments and stakeholder metadata.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
      number: Type.Number({ description: "Issue number" }),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const repo = (params.repo as string) || getAllowedRepos(config)[0];
        assertAllowedRepo(repo, config);
        const data = gh(`issue view ${params.number} --repo ${repo} --json number,url,title,body,state,labels,assignees,comments,createdAt,updatedAt,closedAt`) as GhIssueLike;
        const stakeholders = extractStakeholdersFromIssue(data);
        return jsonResult({ ok: true, data, stakeholders });
      } catch (err) { return errorResult(err); }
    },
  }, logger));

  api.registerTool(() => wrapToolWithAudit({
    name: "cf_gh_create_issue",
    description: "Create a new GitHub issue in the CloudFlow repo with stakeholder metadata.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
      title: Type.String({ description: "Issue title" }),
      body: Type.String({ description: "Issue body (markdown)" }),
      labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to apply" })),
      reporter: Type.Optional(Type.String({ description: "Reporter identity." })),
      stakeholders: Type.Optional(Type.Array(Type.String(), { description: "Additional stakeholder identities." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const repo = (params.repo as string) || getAllowedRepos(config)[0];
        assertAllowedRepo(repo, config);
        const labels = params.labels as string[] | undefined;
        const labelFlag = labels?.length ? ` --label "${labels.join(",")}"` : "";
        const reporter = typeof params.reporter === "string" ? params.reporter : undefined;
        const stakeholders = Array.isArray(params.stakeholders) ? (params.stakeholders as string[]) : [];
        const enrichedBody = upsertStakeholderBlock(String(params.body ?? ""), { reporter, stakeholders });
        const result = execSync(
          `gh issue create --repo ${repo} --title "${(params.title as string).replace(/"/g, '\\"')}"${labelFlag} --body-file -`,
          { encoding: "utf-8", input: enrichedBody, timeout: 30000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" } },
        );
        const url = result.trim();
        const issueNumber = parseIssueNumberFromUrl(url);
        if (issueNumber) {
          execSync(`gh issue comment ${issueNumber} --repo ${repo} --body-file -`, {
            encoding: "utf-8", input: formatStakeholderBlock({ reporter, stakeholders }), timeout: 30000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
          });
        }
        return jsonResult({ ok: true, url, issueNumber, reporter, stakeholders, metadataSaved: Boolean(issueNumber) });
      } catch (err) { return errorResult(err); }
    },
  }, logger));

  api.registerTool(() => wrapToolWithAudit({
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
        assertAllowedRepo(repo, config);
        const issue = gh(`issue view ${params.number} --repo ${repo} --json number,url,title,body,assignees,comments`) as GhIssueLike;
        const extracted = extractStakeholdersFromIssue(issue);
        const prefix = buildStakeholderWorkPrefix(extracted.stakeholders);
        const originalBody = String(params.body ?? "");
        const body = prefix && !/^\s*(\/cc|Stakeholders:)/im.test(originalBody) ? `${prefix}\n\n${originalBody}` : originalBody;
        const result = execSync(`gh issue comment ${params.number} --repo ${repo} --body-file -`, {
          encoding: "utf-8", input: body, timeout: 30000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
        });
        return jsonResult({ ok: true, url: result.trim(), stakeholders: extracted.stakeholders, reporter: extracted.reporter });
      } catch (err) { return errorResult(err); }
    },
  }, logger));

  api.registerTool(() => wrapToolWithAudit({
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
        const limit = (params.limit as number) || 20;
        const query = (params.query as string).replace(/"/g, '\\"');
        const data = gh(`search issues "${query}" --repo ${repo} --limit ${limit} --json number,title,state,labels,repository,createdAt,updatedAt`);
        return jsonResult({ ok: true, data });
      } catch (err) { return errorResult(err); }
    },
  }, logger));

  api.registerTool(() => wrapToolWithAudit({
    name: "cf_gh_close_issue",
    description: "Close a GitHub issue, mention stakeholders, and DM them on Zoom.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Repo (owner/name)." })),
      number: Type.Number({ description: "Issue number" }),
      comment: Type.Optional(Type.String({ description: "Closing comment." })),
      reason: Type.Optional(Type.String({ description: "Close reason: completed or not_planned." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      try {
        const repo = (params.repo as string) || getAllowedRepos(config)[0];
        assertAllowedRepo(repo, config);
        const issueNumber = Number(params.number);
        const closeReason = stringifyReason(params.reason);
        const closingComment = typeof params.comment === "string" ? params.comment.trim() : "";
        const issue = gh(`issue view ${issueNumber} --repo ${repo} --json number,url,title,body,assignees,comments`) as GhIssueLike;
        const extracted = extractStakeholdersFromIssue(issue);
        const prefix = buildStakeholderWorkPrefix(extracted.stakeholders);
        if (closingComment || prefix) {
          const commentBody = [prefix, closingComment].filter(Boolean).join("\n\n").trim();
          if (commentBody) execSync(`gh issue comment ${issueNumber} --repo ${repo} --body-file -`, {
            encoding: "utf-8", input: commentBody, timeout: 30000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
          });
        }
        const closeOutput = execSync(`gh issue close ${issueNumber} --repo ${repo} --reason "${closeReason}"`, {
          encoding: "utf-8", timeout: 30000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" },
        }).trim();
        const dmTargets = extracted.stakeholders
          .map((s) => resolveStakeholderDmTarget(s, { mapEnv: process.env.CF_STAKEHOLDER_MAP, defaultDomain: process.env.CF_STAKEHOLDER_EMAIL_DOMAIN }))
          .filter((v): v is string => Boolean(v));
        const uniqueTargets = [...new Set(dmTargets.map((t) => t.toLowerCase()))];
        const dmMessage = formatDmMessage({ issueNumber, issueTitle: issue.title || `Issue ${issueNumber}`, repo, closedBy: "cloudflow-support", closingComment });
        const notified: string[] = [];
        const notifyErrors: Array<{ stakeholder: string; error: string }> = [];
        for (const target of uniqueTargets) {
          const r = await sendStakeholderZoomDm({ toContact: target, message: dmMessage });
          if (r.ok) notified.push(target);
          else notifyErrors.push({ stakeholder: target, error: r.error ?? "unknown" });
        }
        return jsonResult({ ok: true, number: issueNumber, repo, closeOutput, closeReason, stakeholders: extracted.stakeholders, reporter: extracted.reporter, notified, notifyErrors });
      } catch (err) { return errorResult(err); }
    },
  }, logger));
}
