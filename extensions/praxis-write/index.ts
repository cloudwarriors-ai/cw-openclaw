import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import {
  type ActorContext,
  checkPolicy,
  confirmTokenMatches,
  deriveActorContext,
  idempotencyKey,
  mintConfirmToken,
  mintFileIssueConfirmToken,
  mintIngestConfirmToken,
  mintRepoConfirmToken,
  mintSelfHealConfirmToken,
  resolveWritePolicyConfig,
  type WritePolicyConfig,
} from "./policy.js";
import {
  fileIssue,
  getApiToken,
  getIssue,
  getLinkStatus,
  ingestIssue,
  mapStateToUatKindPrefix,
  onboardRepo,
  type PraxisIssueState,
  runSelfHeal,
  startGithubLink,
  submitCommand,
  resolveIssueRef,
  submitNeedsInfoAnswer,
  submitVerdict,
  type UatVerdictKind,
} from "./praxis-write-client.js";

// The cancel-family kinds Praxis accepts off-band. `manual_override` is deliberately
// NOT here: it is too broad / terminal-state risky for a chat surface (spar MED) and is
// rejected server-side too. `unblock` is its own tool.
const CANCEL_KINDS = ["cancelled", "duplicate", "superseded", "source_closed"] as const;

// The verdict values the model may supply; the tool maps them to the full kind
// (uat1_pass / uat2_pass etc.) after reading the issue state.
const VERDICT_VALUES = ["pass", "fail"] as const;
type VerdictValue = (typeof VERDICT_VALUES)[number];

// Default target for praxis_file_issue: the Praxis repo itself, so a self-improvement issue Praxis
// can then work lands in its own repo. Mirrors the server's PRAXIS_SELF_HEAL_REPO default; kept
// concrete here so the dry-run preview + confirm token bind to a real target. Overridable per call.
const PRAXIS_SELF_IMPROVEMENT_REPO = "cloudwarriors-ai/praxis";

const PraxisWriteConfigSchema = z.strictObject({
  allowedUsers: z.array(z.string()).optional(),
  allowedChannels: z.array(z.string()).optional(),
});

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}

/** Shared path for both write tools: policy gate -> reason check -> fetch issue ->
 * dry-run/confirm -> submit. Identity comes from `actor` (trusted runtime context),
 * never from model args. */
async function runWriteCommand(params: {
  kind: string;
  reason: unknown;
  confirm: unknown;
  issueId: unknown;
  actor: ActorContext;
  config: WritePolicyConfig;
}) {
  const decision = checkPolicy(params.actor, params.config);
  if (!decision.allowed) {
    return jsonResult({ ok: false, denied: decision.reason });
  }
  const reason = typeof params.reason === "string" ? params.reason.trim() : "";
  if (!reason) {
    return jsonResult({ ok: false, error: "reason_required" });
  }
  const issueId = Number(params.issueId);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    return jsonResult({ ok: false, error: "invalid_issue_id" });
  }

  let token: string;
  try {
    token = getApiToken();
  } catch (err) {
    return errorResult(err);
  }

  let issue: PraxisIssueState;
  try {
    issue = await getIssue(issueId);
  } catch (err) {
    return errorResult(err);
  }

  const expected = mintConfirmToken({ secret: token, kind: params.kind, issue });
  const confirm = typeof params.confirm === "string" ? params.confirm : "";
  if (!confirm || !confirmTokenMatches(confirm, expected)) {
    return jsonResult({
      ok: true,
      preview: true,
      action: params.kind,
      issue: {
        id: issue.id,
        state: issue.state,
        state_reason: issue.state_reason,
        version: issue.version,
      },
      requested_by: params.actor.requestedBy,
      confirm_token: expected,
      message:
        `Dry run only — nothing changed. Re-call this tool with confirm="${expected}" to execute ` +
        `${params.kind} on issue ${issue.id}. The token is bound to the issue's current state and ` +
        `is rejected if the issue changes before you confirm.`,
    });
  }

  let res: Awaited<ReturnType<typeof submitCommand>>;
  try {
    res = await submitCommand(issueId, {
      kind: params.kind,
      reason,
      requested_by: params.actor.requestedBy,
      channel: params.actor.channel,
      message_id: params.actor.messageId,
      idempotency_key: idempotencyKey(params.kind, issue),
    });
  } catch (err) {
    return errorResult(err);
  }
  return jsonResult({ ok: res.ok, status: res.status, ...res.data });
}

const plugin = {
  id: "praxis-write",
  name: "Praxis Write",
  description:
    "Praxis operator write tools (hardened): onboard a repo, run a self-heal scan that files " +
    "deduped GitHub issues, unblock or cancel a stuck issue, submit UAT verdicts on behalf of the " +
    "chat user, or start GitHub account linking. Default-disabled, allowlist-gated, two-step " +
    "dry-run/confirm for onboarding/self-heal/destructive ops.",
  configSchema: buildPluginConfigSchema(PraxisWriteConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = PraxisWriteConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return { success: false, error: { issues: mapPluginConfigIssues(parsed.error.issues) } };
    },
  }),

  register(api: OpenClawPluginApi) {
    const config = resolveWritePolicyConfig(api.pluginConfig);

    // Register every tool as `optional: true` so per-agent allowlists scope them — an operator
    // must name the tool / plugin id / "group:plugins" in an agent's `tools.allow`. Combined with
    // the plugin being disabled by default (no `enabledByDefault` in the manifest), the write
    // surface is dormant until explicitly enabled, allowlisted, AND configured.
    const optionalApi: OpenClawPluginApi = {
      ...api,
      registerTool: (tool, opts) => api.registerTool(tool, { ...opts, optional: true }),
    };

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_unblock",
      description:
        "Operator action: unblock a Praxis issue (resume it from `blocked`). The unblock target is " +
        "derived server-side from the issue's block reason — you do not pick it. Two steps: call " +
        "first with just issue_id + reason to get a dry-run preview and a confirm_token, then call " +
        "again passing that token in `confirm` to execute. Allowlist-gated; the human you are acting " +
        "for is recorded for audit. If denied, surface the reason to the human; do not retry.",
      parameters: Type.Object({
        issue_id: Type.Number({ description: "The Praxis issue id (not the GitHub issue number)" }),
        reason: Type.String({
          description: "Operator justification for the unblock (required, audited)",
        }),
        confirm: Type.Optional(
          Type.String({
            description:
              "Confirmation token from the dry-run preview. Omit on the first call to preview; " +
              "pass the returned confirm_token to execute.",
          }),
        ),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);
        return runWriteCommand({
          kind: "unblock",
          reason: params.reason,
          confirm: params.confirm,
          issueId: params.issue_id,
          actor,
          config,
        });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_onboard",
      description:
        "Onboard an EXISTING GitHub repo into Praxis so its issues are tracked: registers the repo " +
        "and (by default) backfills its current open issues through intake. Two steps: call first " +
        "with full_name (+ optional maintainers / owns_dispatch / backfill) and a reason to get a " +
        "dry-run preview and a confirm_token, then call again passing that token in `confirm` to " +
        "execute. Does NOT create the GitHub webhook (that needs repo-admin Praxis lacks) — the " +
        "result returns a webhook instruction for a repo admin to finish. Allowlist-gated; the " +
        "human you are acting for is recorded for audit. If denied, surface the reason; do not retry.",
      parameters: Type.Object({
        full_name: Type.String({ description: "owner/name, e.g. cloudwarriors-ai/foo" }),
        maintainers: Type.Optional(
          Type.Array(Type.String(), {
            description: "Repo-wide maintainer GitHub logins (optional)",
          }),
        ),
        owns_dispatch: Type.Optional(
          Type.Boolean({
            description: "Praxis writes the dispatch label for this repo (default false)",
          }),
        ),
        backfill: Type.Optional(
          Type.Boolean({
            description: "Ingest the repo's existing open issues through intake (default true)",
          }),
        ),
        reason: Type.String({
          description: "Operator justification for onboarding (required, audited)",
        }),
        confirm: Type.Optional(
          Type.String({
            description:
              "Confirmation token from the dry-run preview. Omit on the first call to preview; " +
              "pass the returned confirm_token to execute.",
          }),
        ),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!reason) {
          return jsonResult({ ok: false, error: "reason_required" });
        }
        const fullName = typeof params.full_name === "string" ? params.full_name.trim() : "";
        if (!fullName.includes("/")) {
          return jsonResult({ ok: false, error: "invalid_full_name" });
        }
        const backfill = params.backfill === undefined ? true : params.backfill === true;
        const ownsDispatch = params.owns_dispatch === true;
        const maintainers = Array.isArray(params.maintainers)
          ? params.maintainers.filter((m): m is string => typeof m === "string")
          : [];

        let token: string;
        try {
          token = getApiToken();
        } catch (err) {
          return errorResult(err);
        }

        const expected = mintRepoConfirmToken({ secret: token, fullName, backfill });
        const confirm = typeof params.confirm === "string" ? params.confirm : "";
        if (!confirm || !confirmTokenMatches(confirm, expected)) {
          return jsonResult({
            ok: true,
            preview: true,
            action: "onboard",
            repo: fullName,
            backfill,
            owns_dispatch: ownsDispatch,
            maintainers,
            requested_by: actor.requestedBy,
            confirm_token: expected,
            message:
              `Dry run only — nothing changed. Re-call this tool with confirm="${expected}" to ` +
              `onboard ${fullName}` +
              (backfill ? " and backfill its open issues." : ".") +
              " A repo admin must still create the GitHub webhook (instructions returned in the result).",
          });
        }

        let res: Awaited<ReturnType<typeof onboardRepo>>;
        try {
          res = await onboardRepo({
            full_name: fullName,
            maintainers,
            owns_dispatch: ownsDispatch,
            backfill,
          });
        } catch (err) {
          return errorResult(err);
        }
        return jsonResult({ ok: res.ok, status: res.status, ...res.data });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_ingest",
      description:
        "Force-ingest a SINGLE GitHub issue into Praxis when the issue exists on GitHub but Praxis " +
        "does not know about it yet (its repo is already onboarded, but the issue never got tracked " +
        "— a missed webhook delivery, or it predates the webhook). Reach for this when a human says " +
        "an issue isn't showing up / isn't started / 'give it to Praxis' and praxis_get_issue can't " +
        "find it. Two steps: call first with full_name + number + reason to get a dry-run preview " +
        "and a confirm_token, then call again passing that token in `confirm` to execute. " +
        "Idempotent — re-ingesting an already-tracked issue is a no-op. Onboard the repo first with " +
        "praxis_onboard if this returns repo_not_onboarded. Allowlist-gated; the human you are " +
        "acting for is recorded for audit. If denied, surface the reason; do not retry.",
      parameters: Type.Object({
        full_name: Type.String({ description: "owner/name, e.g. cloudwarriors-ai/scopely" }),
        number: Type.Number({
          description: "The GitHub issue NUMBER (e.g. 1015), not the Praxis issue id",
        }),
        reason: Type.String({
          description: "Operator justification for the manual ingest (required, audited)",
        }),
        confirm: Type.Optional(
          Type.String({
            description:
              "Confirmation token from the dry-run preview. Omit on the first call to preview; " +
              "pass the returned confirm_token to execute.",
          }),
        ),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!reason) {
          return jsonResult({ ok: false, error: "reason_required" });
        }
        const fullName = typeof params.full_name === "string" ? params.full_name.trim() : "";
        if (!fullName.includes("/")) {
          return jsonResult({ ok: false, error: "invalid_full_name" });
        }
        const number = Number(params.number);
        if (!Number.isInteger(number) || number <= 0) {
          return jsonResult({ ok: false, error: "invalid_issue_number" });
        }

        let token: string;
        try {
          token = getApiToken();
        } catch (err) {
          return errorResult(err);
        }

        // Bind the confirm token to the repo + issue number so a preview can't be replayed against
        // a different issue. Ingest can post a needs_info comment to GitHub (a real side effect), so
        // it takes the same two-step dry-run/confirm as the other side-effecting write tools.
        const expected = mintIngestConfirmToken({ secret: token, fullName, number });
        const confirm = typeof params.confirm === "string" ? params.confirm : "";
        if (!confirm || !confirmTokenMatches(confirm, expected)) {
          return jsonResult({
            ok: true,
            preview: true,
            action: "ingest",
            repo: fullName,
            number,
            requested_by: actor.requestedBy,
            confirm_token: expected,
            message:
              `Dry run only — nothing changed. Re-call this tool with confirm="${expected}" to ` +
              `ingest ${fullName}#${number} into Praxis. If the repo is not onboarded this returns ` +
              `repo_not_onboarded — run praxis_onboard first.`,
          });
        }

        let res: Awaited<ReturnType<typeof ingestIssue>>;
        try {
          res = await ingestIssue({
            full_name: fullName,
            number,
            requested_by: actor.requestedBy,
            channel: actor.channel,
            message_id: actor.messageId,
            // Stable per logical ingest so a double-confirm dedupes the server-side audit row.
            idempotency_key: `ingest:${fullName}:${number}`,
          });
        } catch (err) {
          return errorResult(err);
        }

        // Surface Praxis's structured guards as actionable messages.
        if (!res.ok) {
          const body = res.data as Record<string, unknown>;
          if (body.error === "repo_not_onboarded") {
            return jsonResult({
              ok: false,
              error: "repo_not_onboarded",
              message:
                `Praxis is not tracking ${fullName} yet. Onboard it first with praxis_onboard, ` +
                `then re-run this ingest.`,
            });
          }
          if (body.error === "issue_not_open") {
            return jsonResult({
              ok: false,
              error: "issue_not_open",
              message:
                `GitHub issue ${fullName}#${number} is not open (closed or missing), so Praxis ` +
                `won't ingest it. Only open issues enter the intake flow.`,
            });
          }
        }

        return jsonResult({ ok: res.ok, status: res.status, ...res.data });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_file_issue",
      description:
        "Author and file a single GitHub issue INTO THE PRAXIS REPO ITSELF (the default), so Praxis " +
        "can then work it — this is how Praxis self-heals and improves itself. Use it to file a " +
        "specific self-healing fix or self-improvement idea you (or a human) identified, distinct " +
        "from praxis_self_heal which only files failures its automated trace-scan detects. Two " +
        "steps: call first with title (+ optional body/labels/repo) and a reason to get a dry-run " +
        "preview and a confirm_token, then call again passing that token in `confirm` to execute. " +
        "Defaults to cloudwarriors-ai/praxis; pass `repo` to target another repo. Allowlist-gated; " +
        "the human you are acting for is recorded for audit. If denied, surface the reason; do not retry.",
      parameters: Type.Object({
        title: Type.String({ description: "The GitHub issue title (required)" }),
        body: Type.Optional(
          Type.String({
            description:
              "The issue body (markdown). Include repro/what-to-fix so Praxis can act on it.",
          }),
        ),
        labels: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "GitHub labels (optional). Omit to apply the default 'praxis:self-improvement' marker.",
          }),
        ),
        repo: Type.Optional(
          Type.String({
            description: `Target repo owner/name (default ${PRAXIS_SELF_IMPROVEMENT_REPO})`,
          }),
        ),
        reason: Type.String({
          description: "Operator justification for filing the issue (required, audited)",
        }),
        confirm: Type.Optional(
          Type.String({
            description:
              "Confirmation token from the dry-run preview. Omit on the first call to preview; " +
              "pass the returned confirm_token to execute.",
          }),
        ),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!reason) {
          return jsonResult({ ok: false, error: "reason_required" });
        }
        const title = typeof params.title === "string" ? params.title.trim() : "";
        if (!title) {
          return jsonResult({ ok: false, error: "title_required" });
        }
        const fullName =
          typeof params.repo === "string" && params.repo.trim()
            ? params.repo.trim()
            : PRAXIS_SELF_IMPROVEMENT_REPO;
        if (!fullName.includes("/")) {
          return jsonResult({ ok: false, error: "invalid_repo" });
        }
        const issueBody = typeof params.body === "string" ? params.body : "";
        // Only forward labels when the model supplied them, so the server applies its default
        // self-improvement marker on omission (an explicit [] would suppress the marker).
        const labels = Array.isArray(params.labels)
          ? params.labels.filter((l): l is string => typeof l === "string")
          : undefined;

        let token: string;
        try {
          token = getApiToken();
        } catch (err) {
          return errorResult(err);
        }

        // Bind the confirm token to the repo + title so a preview can't be replayed against a
        // different target or a different issue. Filing an issue is a real external side effect, so
        // it takes the same two-step dry-run/confirm as the other side-effecting write tools.
        const expected = mintFileIssueConfirmToken({ secret: token, fullName, title });
        const confirm = typeof params.confirm === "string" ? params.confirm : "";
        if (!confirm || !confirmTokenMatches(confirm, expected)) {
          return jsonResult({
            ok: true,
            preview: true,
            action: "file_issue",
            repo: fullName,
            title,
            labels: labels ?? ["praxis:self-improvement (default)"],
            requested_by: actor.requestedBy,
            confirm_token: expected,
            message:
              `Dry run only — nothing filed. Re-call this tool with confirm="${expected}" to file ` +
              `the issue "${title}" into ${fullName}.`,
          });
        }

        let res: Awaited<ReturnType<typeof fileIssue>>;
        try {
          res = await fileIssue({
            full_name: fullName,
            title,
            body: issueBody,
            ...(labels !== undefined ? { labels } : {}),
            requested_by: actor.requestedBy,
            channel: actor.channel,
            message_id: actor.messageId,
            idempotency_key: `file-issue:${fullName}:${title}`,
          });
        } catch (err) {
          return errorResult(err);
        }
        return jsonResult({ ok: res.ok, status: res.status, ...res.data });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_self_heal",
      description:
        "Run a Praxis self-heal scan: detect recurring runtime failures from Praxis's own trace and " +
        "(in create-issues mode, the default) file deduped GitHub issues into a repo. Two steps: " +
        "call first with an optional repo/mode/since_minutes/min_occurrences and a reason to get a " +
        "dry-run preview and a confirm_token, then call again passing that token in `confirm` to " +
        "execute. mode create-issues writes GitHub issues; dry-run/record do not. Allowlist-gated; " +
        "the human you are acting for is recorded for audit. If denied, surface the reason; do not retry.",
      parameters: Type.Object({
        repo: Type.Optional(
          Type.String({
            description:
              "owner/name to file self-heal issues into (defaults to the configured " +
              "self-heal repo)",
          }),
        ),
        mode: Type.Optional(
          Type.String({
            description: "dry-run | record | create-issues (default create-issues)",
          }),
        ),
        since_minutes: Type.Optional(
          Type.Number({ description: "Trace window to scan, in minutes (default 60)" }),
        ),
        min_occurrences: Type.Optional(
          Type.Number({ description: "Minimum recurrences before a finding is published" }),
        ),
        notify: Type.Optional(
          Type.Boolean({ description: "Post a status update to the Praxis Zoom channel" }),
        ),
        note: Type.Optional(
          Type.String({
            description:
              "Extra context to append to the filed issue(s) as an 'Operator Context' section " +
              "(e.g. your analysis or the relevant chat detail). Optional but recommended.",
          }),
        ),
        reason: Type.String({
          description: "Operator justification for the self-heal run (required, audited)",
        }),
        confirm: Type.Optional(
          Type.String({
            description:
              "Confirmation token from the dry-run preview. Omit on the first call to preview; " +
              "pass the returned confirm_token to execute.",
          }),
        ),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }
        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!reason) {
          return jsonResult({ ok: false, error: "reason_required" });
        }
        const repo = typeof params.repo === "string" ? params.repo.trim() : "";
        const mode = typeof params.mode === "string" ? params.mode.trim() : "create-issues";
        if (!["dry-run", "record", "create-issues"].includes(mode)) {
          return jsonResult({ ok: false, error: "invalid_mode" });
        }
        const sinceMinutes =
          typeof params.since_minutes === "number" ? params.since_minutes : undefined;
        const minOccurrences =
          typeof params.min_occurrences === "number" ? params.min_occurrences : undefined;
        const notify = params.notify === true;
        const note = typeof params.note === "string" ? params.note.trim() : "";

        let token: string;
        try {
          token = getApiToken();
        } catch (err) {
          return errorResult(err);
        }

        // Bind the confirm token to the repo+mode actually requested (empty repo => server default).
        const expected = mintSelfHealConfirmToken({ secret: token, repo, mode });
        const confirm = typeof params.confirm === "string" ? params.confirm : "";
        if (!confirm || !confirmTokenMatches(confirm, expected)) {
          return jsonResult({
            ok: true,
            preview: true,
            action: "self_heal",
            repo: repo || "(server default self-heal repo)",
            mode,
            requested_by: actor.requestedBy,
            confirm_token: expected,
            message:
              `Dry run only — nothing changed. Re-call this tool with confirm="${expected}" to run ` +
              `self-heal (mode=${mode})` +
              (mode === "create-issues" ? " and file GitHub issues for recurring findings." : "."),
          });
        }

        let res: Awaited<ReturnType<typeof runSelfHeal>>;
        try {
          res = await runSelfHeal({
            ...(repo ? { repo } : {}),
            mode,
            ...(sinceMinutes !== undefined ? { since_minutes: sinceMinutes } : {}),
            ...(minOccurrences !== undefined ? { min_occurrences: minOccurrences } : {}),
            notify,
            ...(note ? { note } : {}),
          });
        } catch (err) {
          return errorResult(err);
        }
        return jsonResult({ ok: res.ok, status: res.status, ...res.data });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_cancel",
      description:
        "Operator action: cancel a Praxis issue, collapsing it to `cancelled` with a tag. `kind` is " +
        "one of: cancelled | duplicate | superseded | source_closed. Two steps: call first with " +
        "issue_id + kind + reason to get a dry-run preview and a confirm_token, then call again " +
        "passing that token in `confirm` to execute. Allowlist-gated; the human you are acting for " +
        "is recorded for audit. `manual_override` is intentionally not available here.",
      parameters: Type.Object({
        issue_id: Type.Number({ description: "The Praxis issue id (not the GitHub issue number)" }),
        kind: Type.String({
          description: "Cancel reason tag: cancelled | duplicate | superseded | source_closed",
        }),
        reason: Type.String({
          description: "Operator justification for the cancel (required, audited)",
        }),
        confirm: Type.Optional(
          Type.String({
            description:
              "Confirmation token from the dry-run preview. Omit on the first call to preview; " +
              "pass the returned confirm_token to execute.",
          }),
        ),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const kind = typeof params.kind === "string" ? params.kind : "";
        if (!(CANCEL_KINDS as readonly string[]).includes(kind)) {
          return jsonResult({ ok: false, error: "unsupported_kind", allowed: CANCEL_KINDS });
        }
        const actor = deriveActorContext(toolContext, toolCallId);
        return runWriteCommand({
          kind,
          reason: params.reason,
          confirm: params.confirm,
          issueId: params.issue_id,
          actor,
          config,
        });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_submit_verdict",
      description:
        "Submit a UAT verdict (pass or fail) on a Praxis issue on behalf of the chat user. The " +
        "tool reads the issue's current state to determine the right UAT stage (dev_uat → uat1, " +
        "user_uat → uat2) and rejects the call if the issue is not awaiting a verdict. The " +
        "requester's verified Zoom identity is forwarded as channel_user_id — the server enforces " +
        "that the identity is linked to a GitHub account with the reporter/owner role. If the " +
        "identity is not linked, instruct the user to run praxis_link_github first. " +
        "Allowlist-gated; no dry-run/confirm step (UAT states only exit on a human verdict, so " +
        "the read→submit is race-safe). For needs-info answers use praxis_provide_info.",
      parameters: Type.Object({
        issue_id: Type.Number({ description: "The Praxis issue id (not the GitHub issue number)" }),
        verdict: Type.String({
          description:
            "pass — UAT succeeded; fail — UAT failed and the issue should return for fixes",
        }),
        reason: Type.String({
          description: "Human-readable UAT verdict rationale (required, recorded for audit)",
        }),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);

        // Policy gate: identity + allowlist
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }

        // The verified Zoom sender id is the trusted identity we forward. Fail
        // closed if the runtime didn't supply one (model cannot inject this).
        const channelUserId = actor.requestedBy;
        if (!channelUserId) {
          return jsonResult({ ok: false, denied: "no_requester_identity" });
        }

        const verdictValue = typeof params.verdict === "string" ? params.verdict.trim() : "";
        if (!(VERDICT_VALUES as readonly string[]).includes(verdictValue)) {
          return jsonResult({
            ok: false,
            error: "unsupported_verdict",
            allowed: VERDICT_VALUES,
          });
        }

        const reason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (!reason) {
          return jsonResult({ ok: false, error: "reason_required" });
        }

        const issueId = Number(params.issue_id);
        if (!Number.isInteger(issueId) || issueId <= 0) {
          return jsonResult({ ok: false, error: "invalid_issue_id" });
        }

        // Read the issue state to determine the UAT kind prefix (uat1 or uat2).
        // UAT states only exit on a human verdict, so reading then submitting is
        // race-safe for this surface.
        let issue: PraxisIssueState;
        try {
          issue = await getIssue(issueId);
        } catch (err) {
          return errorResult(err);
        }

        const kindPrefix = mapStateToUatKindPrefix(issue.state);
        if (!kindPrefix) {
          return jsonResult({
            ok: false,
            error: "issue_not_awaiting_verdict",
            state: issue.state,
            message: `Issue #${issueId} is not awaiting a UAT verdict (state=${issue.state}). Only issues in dev_uat or user_uat can receive a verdict.`,
          });
        }

        const kind: UatVerdictKind = `${kindPrefix}_${verdictValue as VerdictValue}`;

        let res: Awaited<ReturnType<typeof submitVerdict>>;
        try {
          res = await submitVerdict(issueId, {
            kind,
            reason,
            requested_by: channelUserId,
            channel: "zoom",
            channel_user_id: channelUserId,
          });
        } catch (err) {
          return errorResult(err);
        }

        // Surface structured Praxis errors as user-friendly messages.
        if (!res.ok) {
          const body = res.data as Record<string, unknown>;
          if (body.error === "identity_not_linked") {
            return jsonResult({
              ok: false,
              error: "identity_not_linked",
              message:
                "Your Zoom identity is not yet linked to a GitHub account. " +
                "Run praxis_link_github to get a link URL, tap it to authorize GitHub, then try again.",
            });
          }
          if (res.status === 403) {
            return jsonResult({
              ok: false,
              error: "unauthorized",
              message:
                "Your linked GitHub account does not have the reporter or owner role for this verdict. " +
                "Contact an admin if you believe this is an error.",
            });
          }
          if (body.error === "identity_required") {
            return jsonResult({
              ok: false,
              error: "identity_required",
              message:
                "No verified identity was forwarded to Praxis. This is a configuration error.",
            });
          }
        }

        return jsonResult({ ok: res.ok, status: res.status, ...res.data });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_provide_info",
      description:
        "Relay a human's answer to a Praxis needs-info question. Use when a user replies (in the " +
        "issue's thread or addressed to you) with the detail Praxis asked for on an issue in the " +
        "needs_info state. The requester's verified Zoom identity is forwarded as " +
        "channel_user_id — the server verifies it is the asked reporter or a maintainer, consumes " +
        "the open question, applies the answer to the question's stored field, and mirrors the " +
        "answer to the GitHub issue. If the identity is not linked, instruct the user to run " +
        "praxis_link_github first. Allowlist-gated.",
      parameters: Type.Object({
        issue: Type.Optional(
          Type.String({
            description:
              'The GitHub issue ref "owner/repo#N" (as shown in the thread root) — preferred',
          }),
        ),
        issue_id: Type.Optional(
          Type.Number({ description: "The Praxis issue id, if already known" }),
        ),
        answer: Type.String({
          description: "The user's answer text, verbatim (do not paraphrase or embellish)",
        }),
      }),
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);

        // Policy gate: identity + allowlist
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }

        // The verified Zoom sender id is the trusted identity we forward. Fail
        // closed if the runtime didn't supply one (model cannot inject this).
        const channelUserId = actor.requestedBy;
        if (!channelUserId) {
          return jsonResult({ ok: false, denied: "no_requester_identity" });
        }

        const answer = typeof params.answer === "string" ? params.answer.trim() : "";
        if (!answer) {
          return jsonResult({ ok: false, error: "answer_required" });
        }

        // Resolve the issue: prefer the thread-root "owner/repo#N" ref (what humans and the
        // root card speak); fall back to an explicit praxis id.
        let issueId = Number(params.issue_id);
        const ref = typeof params.issue === "string" ? params.issue.trim() : "";
        if ((!Number.isInteger(issueId) || issueId <= 0) && ref) {
          let resolved: number | undefined;
          try {
            resolved = await resolveIssueRef(ref);
          } catch (err) {
            return errorResult(err);
          }
          if (!resolved) {
            return jsonResult({
              ok: false,
              error: "issue_not_tracked",
              message: `Praxis is not tracking ${ref}.`,
            });
          }
          issueId = resolved;
        }
        if (!Number.isInteger(issueId) || issueId <= 0) {
          return jsonResult({ ok: false, error: "invalid_issue_id" });
        }

        let res: Awaited<ReturnType<typeof submitNeedsInfoAnswer>>;
        try {
          // toolCallId as idempotency key: a model retry of the same call never
          // double-applies the answer.
          res = await submitNeedsInfoAnswer(issueId, {
            reason: answer,
            requested_by: channelUserId,
            channel: "zoom",
            channel_user_id: channelUserId,
            idempotency_key: toolCallId,
          });
        } catch (err) {
          return errorResult(err);
        }

        if (!res.ok) {
          const body = res.data as Record<string, unknown>;
          if (body.error === "identity_not_linked") {
            return jsonResult({
              ok: false,
              error: "identity_not_linked",
              message:
                "Your Zoom identity is not yet linked to a GitHub account. " +
                "Run praxis_link_github to get a link URL, tap it to authorize GitHub, then try again.",
            });
          }
          if (body.error === "issue_not_awaiting_info") {
            return jsonResult({
              ok: false,
              error: "issue_not_awaiting_info",
              state: body.state,
              message: `Issue #${issueId} is not waiting for information (state=${String(body.state)}).`,
            });
          }
          if (res.status === 403) {
            return jsonResult({
              ok: false,
              error: "unauthorized",
              message:
                "Your linked GitHub account is not the asked reporter or a maintainer for this issue.",
            });
          }
        }

        return jsonResult({ ok: res.ok, status: res.status, ...res.data });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_link_github",
      description:
        "Start a GitHub account linking flow for the chat user. Sends the user's verified Zoom " +
        "identity to Praxis, which returns a URL the user must tap to authorize their GitHub account. " +
        "Once linked, the user can submit UAT verdicts via praxis_submit_verdict. Takes no " +
        "model-supplied identity arguments — the verified sender from the runtime context is used. " +
        "Allowlist-gated.",
      parameters: Type.Object({}),
      async execute(toolCallId: string, _params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);

        // Policy gate: identity + allowlist
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }

        const channelUserId = actor.requestedBy;
        if (!channelUserId) {
          return jsonResult({ ok: false, denied: "no_requester_identity" });
        }

        let res: Awaited<ReturnType<typeof startGithubLink>>;
        try {
          res = await startGithubLink({ channel: "zoom", channel_user_id: channelUserId });
        } catch (err) {
          return errorResult(err);
        }

        if (!res.ok) {
          const body = res.data as Record<string, unknown>;
          if (body.error === "linking_not_configured") {
            return jsonResult({
              ok: false,
              error: "linking_not_configured",
              message:
                "GitHub linking is not configured on the Praxis server. " +
                "Contact an admin to set up the GitHub OAuth app.",
            });
          }
          if (body.error === "identity_required") {
            return jsonResult({
              ok: false,
              error: "identity_required",
              message:
                "No verified identity was forwarded to Praxis. This is a configuration error.",
            });
          }
        }

        const body = res.data as Record<string, unknown>;
        const url = typeof body.url === "string" ? body.url : undefined;
        if (!url) {
          return jsonResult({
            ok: false,
            error: "unexpected_response",
            message: "Praxis did not return a linking URL. Contact an admin.",
          });
        }

        return jsonResult({
          ok: true,
          status: res.status,
          url,
          message: `Tap this link to connect your GitHub account: ${url}`,
        });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_link_status",
      description:
        "Check whether the chat user's verified identity is already linked to a GitHub account in " +
        "Praxis. Uses the verified runtime identity (no model-supplied arguments) and returns whether " +
        "they are linked and, if linked, the GitHub login. Use this to confirm a link succeeded or to " +
        "decide whether to prompt the user to run praxis_link_github. Allowlist-gated.",
      parameters: Type.Object({}),
      async execute(toolCallId: string, _params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);

        // Policy gate: identity + allowlist
        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }

        const channelUserId = actor.requestedBy;
        if (!channelUserId) {
          return jsonResult({ ok: false, denied: "no_requester_identity" });
        }

        let res: Awaited<ReturnType<typeof getLinkStatus>>;
        try {
          res = await getLinkStatus({ channel: "zoom", channel_user_id: channelUserId });
        } catch (err) {
          return errorResult(err);
        }
        if (!res.ok) {
          return jsonResult({
            ok: false,
            status: res.status,
            ...(res.data as Record<string, unknown>),
          });
        }

        const body = res.data as Record<string, unknown>;
        const linked = body.linked === true;
        const githubLogin = typeof body.github_login === "string" ? body.github_login : undefined;
        return jsonResult({
          ok: true,
          linked,
          github_login: githubLogin,
          message: linked
            ? `Your Zoom identity is linked to GitHub as ${githubLogin}.`
            : "Your Zoom identity is not linked to a GitHub account yet. Run praxis_link_github to link it.",
        });
      },
    }));
  },
};

export default plugin;
