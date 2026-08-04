import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import {
  type ActorContext,
  checkPolicy,
  conversationIdempotencyKey,
  confirmTokenMatches,
  deriveActorContext,
  idempotencyKey,
  mintConfirmToken,
  mintFileIssueConfirmToken,
  mintIngestConfirmToken,
  mintRepoConfirmToken,
  mintSelfHealConfirmToken,
  resolveWritePolicyConfig,
  type ToolRequestContext,
  type WritePolicyConfig,
} from "./policy.js";
import {
  fileIssue,
  getApiToken,
  getIssue,
  getIssueResponse,
  getLinkStatus,
  getMyIssue,
  getMyIssues,
  setMyConsent,
  ingestIssue,
  mapStateToUatKindPrefix,
  onboardRepo,
  type PraxisIssueState,
  runSelfHeal,
  startGithubLink,
  submitCommand,
  resolveIssueRef,
  resolveOpenAsk,
  resolveThreadIssue,
  submitNeedsInfoAnswer,
  submitVerdict,
  type UatVerdictKind,
} from "./praxis-write-client.js";

// The cancel-family kinds Praxis accepts off-band. `manual_override` is deliberately
// NOT here: it is too broad / terminal-state risky for a chat surface (spar MED) and is
// rejected server-side too. `unblock` is its own tool.
const CANCEL_KINDS = ["cancelled", "duplicate", "superseded", "source_closed"] as const;

// The verdict values the model may supply; the tool maps them to a stage-neutral wire kind.
// Praxis resolves the persisted uat1/uat2 event after idempotency lookup.
const VERDICT_VALUES = ["pass", "fail"] as const;

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

function mutationWasRecorded(data: Record<string, unknown>): boolean {
  return data.applied === true || data.idempotent === true;
}

function supportsConversationAckV1(issue: PraxisIssueState): boolean {
  return issue.contracts?.includes("conversation_ack_v1") === true;
}

/** Resolve the praxis issue from the runtime-provided reply thread. TRUSTED context only —
 * the thread id comes from deliveryContext (never model-supplied), and Praxis role-gates the
 * resolution server-side (unknown/foreign threads are undisclosed 404s). Returns null when the
 * message was not a threaded reply or the thread does not resolve for this identity; callers
 * fall back to explicit refs. */
async function resolveIssueFromReplyThread(
  toolContext: ToolRequestContext,
  channelUserId: string,
): Promise<{ issueId: number; ref: string } | null> {
  const raw = toolContext.deliveryContext?.threadId;
  const threadRef = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!threadRef) {
    return null;
  }
  let res: Awaited<ReturnType<typeof resolveThreadIssue>>;
  try {
    res = await resolveThreadIssue({
      channel: "zoom",
      channel_user_id: channelUserId,
      thread_ref: threadRef,
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  const issue = (res.data as { issue?: Record<string, unknown> }).issue;
  const issueId = Number(issue?.issue_id);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    return null;
  }
  return { issueId, ref: String(issue?.ref ?? "") };
}

/** Resolve the issue from the server's OPEN-ASK set — the last inference removed from the model.
 * Praxis returns the single issue with a question addressed to this identity; several candidates
 * refuse (ambiguous) rather than pick, and the caller surfaces the list to the human. Returns
 * {issueId, ref} on a clean resolve, {ambiguous} when the human must choose, null otherwise. */
async function resolveIssueFromOpenAsk(
  channelUserId: string,
): Promise<{ issueId?: number; ref?: string; ambiguous?: string[] } | null> {
  let res: Awaited<ReturnType<typeof resolveOpenAsk>>;
  try {
    res = await resolveOpenAsk({ channel: "zoom", channel_user_id: channelUserId });
  } catch {
    return null;
  }
  if (!res.ok) {
    const data = res.data as { error?: string; candidates?: { ref?: string }[] };
    if (data?.error === "ambiguous_open_ask") {
      return { ambiguous: (data.candidates ?? []).map((c) => String(c.ref ?? "")).filter(Boolean) };
    }
    return null;
  }
  const issue = (res.data as { issue?: Record<string, unknown> }).issue;
  const issueId = Number(issue?.issue_id);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    return null;
  }
  return { issueId, ref: String(issue?.ref ?? "") };
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
    // Freeze the first full UAT intent for each inbound human message so model retries resend an
    // identical stage-neutral command. The server also checks the optimistic state/version token.
    const verdictIntents = new Map<
      string,
      {
        kind: UatVerdictKind;
        reason: string;
        expected_state: "dev_uat" | "user_uat";
        expected_version: number;
      }
    >();
    const infoAnswers = new Map<string, string>();

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
          const body = res.data;
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
        issue_id: Type.Optional(
          Type.Number({
            description:
              "The Praxis issue id (not the GitHub issue number). OMIT when the user replied " +
              "in the ask's own thread — the trusted reply thread resolves the issue.",
          }),
        ),
        verdict: Type.String({
          description:
            "pass — UAT succeeded; fail — UAT failed and the issue should return for fixes",
        }),
        reason: Type.Optional(
          Type.String({ description: "Required failure summary for fail; optional for pass" }),
        ),
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

        const suppliedReason = typeof params.reason === "string" ? params.reason.trim() : "";
        if (verdictValue === "fail" && suppliedReason.length < 3) {
          return jsonResult({ ok: false, error: "failure_summary_required" });
        }
        // Issue resolution: an explicit issue_id wins (non-thread flows, byte-compatible with
        // the pre-thread contract); otherwise the TRUSTED reply thread resolves it server-side —
        // a user replying in the ask's own thread never has to name an issue.
        const explicitId = Number(params.issue_id);
        const hasExplicit = Number.isInteger(explicitId) && explicitId > 0;
        const fromThread = hasExplicit
          ? null
          : await resolveIssueFromReplyThread(toolContext, channelUserId);
        const issueId = hasExplicit ? explicitId : (fromThread?.issueId ?? 0);
        if (!Number.isInteger(issueId) || issueId <= 0) {
          return jsonResult({
            ok: false,
            error: "issue_required",
            message:
              "No issue_id was given and this message is not a reply in a Praxis ask's thread. " +
              "Call praxis_my_issues to find the issue awaiting a verdict, then retry.",
          });
        }
        if (!actor.inboundMessageId) {
          return jsonResult({
            ok: false,
            denied: "inbound_message_id_required",
            message:
              "This transport did not provide a trusted inbound message id, so Praxis refused to mutate without retry-safe idempotency.",
          });
        }
        // Read the issue state to determine the UAT kind prefix (uat1 or uat2).
        // UAT states only exit on a human verdict, so reading then submitting is
        // race-safe for this surface.
        let issueResponse: Awaited<ReturnType<typeof getIssueResponse>>;
        try {
          issueResponse = await getIssueResponse(issueId);
        } catch (err) {
          return errorResult(err);
        }
        if (!issueResponse.ok) {
          return jsonResult({
            ok: false,
            status: issueResponse.status,
            ...issueResponse.data,
          });
        }
        const issue = issueResponse.data;
        if (!supportsConversationAckV1(issue)) {
          return jsonResult({
            ok: false,
            denied: "server_contract_unconfirmed",
            message:
              "The connected Praxis server does not advertise conversation_ack_v1. Upgrade Praxis before submitting channel replies.",
          });
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

        const proposedKind: UatVerdictKind = verdictValue === "pass" ? "uat_pass" : "uat_fail";
        // Keep bare pass convenient without writing false audit evidence about who validated.
        const proposedReason =
          verdictValue === "fail"
            ? suppliedReason
            : suppliedReason || "Pass verdict submitted without additional rationale.";
        const conversationKey = conversationIdempotencyKey("verdict", issueId, actor);
        let intent = verdictIntents.get(conversationKey);
        if (!intent) {
          intent = {
            kind: proposedKind,
            reason: proposedReason,
            expected_state: issue.state as "dev_uat" | "user_uat",
            expected_version: issue.version,
          };
          verdictIntents.set(conversationKey, intent);
          if (verdictIntents.size > 2048) {
            const oldest = verdictIntents.keys().next().value;
            if (oldest) {
              verdictIntents.delete(oldest);
            }
          }
        }

        let res: Awaited<ReturnType<typeof submitVerdict>>;
        try {
          res = await submitVerdict(issueId, {
            kind: intent.kind,
            reason: intent.reason,
            requested_by: channelUserId,
            channel: "zoom",
            channel_user_id: channelUserId,
            message_id: actor.inboundMessageId,
            idempotency_key: conversationKey,
            ...intent,
          });
        } catch (err) {
          return errorResult(err);
        }

        // Surface structured Praxis errors as user-friendly messages.
        if (!res.ok) {
          const body = res.data;
          // These server validations happen before an event is written. Forget the proposed
          // payload so the model can correct its interpretation of the same inbound human message.
          if (body.error === "invalid_failure_summary" || body.error === "invalid_verdict_reason") {
            verdictIntents.delete(conversationKey);
          }
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
          return jsonResult({ ok: false, status: res.status, ...res.data });
        }
        if (!mutationWasRecorded(res.data)) {
          return jsonResult({
            ...res.data,
            ok: false,
            status: res.status,
            error: "verdict_not_confirmed",
            retryable: false,
            message:
              "Praxis did not confirm whether the verdict was recorded. Do not retry this message; check issue status first.",
          });
        }
        if (typeof res.data.message !== "string" || !res.data.message.trim()) {
          return jsonResult({
            ...res.data,
            ok: false,
            status: res.status,
            error: "acknowledgement_missing",
            mutation_recorded: true,
            retryable: false,
            message:
              "Praxis recorded the verdict but did not return canonical acknowledgement copy. Do not retry this message; check issue status.",
          });
        }
        return jsonResult({
          ok: res.ok,
          status: res.status,
          ...(fromThread ? { resolved_from_thread: fromThread.ref } : {}),
          ...res.data,
        });
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
              'The GitHub issue ref "owner/repo#N". OMIT when the user replied in the ask\'s own thread — the trusted reply thread resolves the issue',
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
        if (!actor.inboundMessageId) {
          return jsonResult({
            ok: false,
            denied: "inbound_message_id_required",
            message:
              "This transport did not provide a trusted inbound message id, so Praxis refused to mutate without retry-safe idempotency.",
          });
        }
        // Resolve the issue. Ladder: explicit praxis id, then the explicit "owner/repo#N" ref,
        // then the TRUSTED reply thread (runtime-provided — a user answering in the ask's own
        // thread never needs to name anything).
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
        const hasExplicit = Number.isInteger(issueId) && issueId > 0;
        const fromThread = hasExplicit
          ? null
          : await resolveIssueFromReplyThread(toolContext, channelUserId);
        if (!hasExplicit && fromThread) {
          issueId = fromThread.issueId;
        }
        // Last rung: the server's open-ask set. An answer with no thread and no named issue
        // belongs to whichever issue is actually WAITING on this person — resolved from data,
        // never from the model's memory of the conversation.
        let fromOpenAsk: Awaited<ReturnType<typeof resolveIssueFromOpenAsk>> = null;
        if (!hasExplicit && !fromThread) {
          fromOpenAsk = await resolveIssueFromOpenAsk(channelUserId);
          if (fromOpenAsk?.ambiguous?.length) {
            return jsonResult({
              ok: false,
              error: "ambiguous_open_ask",
              candidates: fromOpenAsk.ambiguous,
              message:
                "More than one issue is waiting on you: " +
                `${fromOpenAsk.ambiguous.join(", ")}. Ask which one this answers, then call ` +
                "again with that issue.",
            });
          }
          if (fromOpenAsk?.issueId) {
            issueId = fromOpenAsk.issueId;
          }
        }
        if (!Number.isInteger(issueId) || issueId <= 0) {
          return jsonResult({
            ok: false,
            error: "issue_required",
            message:
              "No issue was given, this message is not a reply in a Praxis ask's thread, and " +
              "nothing is currently waiting on you. Call praxis_my_issues to check status.",
          });
        }
        let issueResponse: Awaited<ReturnType<typeof getIssueResponse>>;
        try {
          issueResponse = await getIssueResponse(issueId);
        } catch (err) {
          return errorResult(err);
        }
        if (!issueResponse.ok) {
          return jsonResult({
            ok: false,
            status: issueResponse.status,
            ...issueResponse.data,
          });
        }
        const issue = issueResponse.data;
        if (!supportsConversationAckV1(issue)) {
          return jsonResult({
            ok: false,
            denied: "server_contract_unconfirmed",
            message:
              "The connected Praxis server does not advertise conversation_ack_v1. Upgrade Praxis before submitting channel replies.",
          });
        }

        const conversationKey = conversationIdempotencyKey("info", issueId, actor);
        let frozenAnswer = infoAnswers.get(conversationKey);
        if (frozenAnswer === undefined) {
          frozenAnswer = answer;
          infoAnswers.set(conversationKey, frozenAnswer);
          if (infoAnswers.size > 2048) {
            const oldest = infoAnswers.keys().next().value;
            if (oldest) {
              infoAnswers.delete(oldest);
            }
          }
        }

        let res: Awaited<ReturnType<typeof submitNeedsInfoAnswer>>;
        try {
          // The trusted inbound provider message, not the model tool call, binds idempotency.
          // A model retry or a replay after state advancement cannot double-apply the answer.
          res = await submitNeedsInfoAnswer(issueId, {
            reason: frozenAnswer,
            requested_by: channelUserId,
            channel: "zoom",
            channel_user_id: channelUserId,
            message_id: actor.inboundMessageId,
            idempotency_key: conversationKey,
          });
        } catch (err) {
          return errorResult(err);
        }

        if (!res.ok) {
          const body = res.data;
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
          return jsonResult({ ok: false, status: res.status, ...res.data });
        }
        if (!mutationWasRecorded(res.data)) {
          return jsonResult({
            ...res.data,
            ok: false,
            status: res.status,
            error: "answer_not_confirmed",
            retryable: false,
            message:
              "Praxis did not confirm whether the information was recorded. Do not retry this message; check issue status first.",
          });
        }
        if (typeof res.data.message !== "string" || !res.data.message.trim()) {
          return jsonResult({
            ...res.data,
            ok: false,
            status: res.status,
            error: "acknowledgement_missing",
            mutation_recorded: true,
            retryable: false,
            message:
              "Praxis recorded the information but did not return canonical acknowledgement copy. Do not retry this message; check issue status.",
          });
        }
        return jsonResult({
          ok: res.ok,
          status: res.status,
          ...(fromThread ? { resolved_from_thread: fromThread.ref } : {}),
          ...(fromOpenAsk?.ref ? { resolved_from_open_ask: fromOpenAsk.ref } : {}),
          ...res.data,
        });
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
          const body = res.data;
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

        const body = res.data;
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
            ...res.data,
          });
        }

        const body = res.data;
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

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_my_issues",
      description:
        "List the chat user's OWN open Praxis issues (the ones they reported), across repos — " +
        "use this when someone asks about 'my issues' / 'my stuff'. Uses the verified runtime " +
        "identity (no model-supplied arguments); Praxis resolves the linked GitHub login " +
        "server-side, so a user only ever sees their own issues. Each item carries the internal " +
        "issue_id that praxis_my_issue / praxis_provide_info / praxis_submit_verdict take, plus " +
        "needs_user_action + open_question_field so you can lead with what is waiting on them. " +
        "If the identity is not linked, prompt praxis_link_github. Allowlist-gated.",
      parameters: Type.Object({}),
      async execute(toolCallId: string, _params: Record<string, unknown>) {
        const actor = deriveActorContext(toolContext, toolCallId);

        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }
        const channelUserId = actor.requestedBy;
        if (!channelUserId) {
          return jsonResult({ ok: false, denied: "no_requester_identity" });
        }

        let res: Awaited<ReturnType<typeof getMyIssues>>;
        try {
          res = await getMyIssues({ channel: "zoom", channel_user_id: channelUserId });
        } catch (err) {
          return errorResult(err);
        }
        const body = res.data;
        if (!res.ok) {
          const hint =
            body?.error === "identity_not_linked"
              ? "The user's Zoom identity is not linked to GitHub — run praxis_link_github."
              : undefined;
          return jsonResult({ ok: false, status: res.status, ...body, ...(hint ? { hint } : {}) });
        }
        return jsonResult({ ok: true, ...body });
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_my_issue",
      description:
        "Identity-scoped drill-down into ONE of the chat user's own issues (by internal issue_id " +
        "from praxis_my_issues). Returns 404 unless the resolved user is that issue's reporter — " +
        "this is the end-user detail path; NEVER use the org-wide praxis_get_issue for a user " +
        "asking about their own issue. Allowlist-gated.",
      parameters: Type.Object({
        issue_id: Type.Number({ description: "Internal Praxis issue id (from praxis_my_issues)." }),
      }),
      async execute(toolCallId: string, params: { issue_id?: number }) {
        const actor = deriveActorContext(toolContext, toolCallId);

        const decision = checkPolicy(actor, config);
        if (!decision.allowed) {
          return jsonResult({ ok: false, denied: decision.reason });
        }
        const channelUserId = actor.requestedBy;
        if (!channelUserId) {
          return jsonResult({ ok: false, denied: "no_requester_identity" });
        }
        const issueId = typeof params.issue_id === "number" ? params.issue_id : Number.NaN;
        if (!Number.isInteger(issueId) || issueId <= 0) {
          return jsonResult({ ok: false, error: "issue_id_required" });
        }

        let res: Awaited<ReturnType<typeof getMyIssue>>;
        try {
          res = await getMyIssue(issueId, { channel: "zoom", channel_user_id: channelUserId });
        } catch (err) {
          return errorResult(err);
        }
        const body = res.data;
        if (!res.ok) {
          return jsonResult({ ok: false, status: res.status, ...body });
        }
        return jsonResult({ ok: true, ...body });
      },
    }));

    // Shared body for the two consent tools: identical policy/identity gating, differing only in
    // opt-in vs opt-out. Takes each tool's own toolContext (registerTool passes it per tool).
    const runConsentTool = async (
      toolContext: ToolRequestContext,
      toolCallId: string,
      optIn: boolean,
    ) => {
      const actor = deriveActorContext(toolContext, toolCallId);
      const decision = checkPolicy(actor, config);
      if (!decision.allowed) {
        return jsonResult({ ok: false, denied: decision.reason });
      }
      const channelUserId = actor.requestedBy;
      if (!channelUserId) {
        return jsonResult({ ok: false, denied: "no_requester_identity" });
      }
      let res: Awaited<ReturnType<typeof setMyConsent>>;
      try {
        res = await setMyConsent({
          channel: "zoom",
          channel_user_id: channelUserId,
          opt_in: optIn,
        });
      } catch (err) {
        return errorResult(err);
      }
      const body = res.data;
      if (!res.ok) {
        return jsonResult({ ok: false, status: res.status, ...body });
      }
      return jsonResult({ ok: true, ...body });
    };

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_opt_in",
      description:
        "Opt the chat user IN to proactive Praxis DMs about their issues (a periodic digest of " +
        "what's on their plate + what needs them). Call this when the user agrees to be kept " +
        "posted — e.g. 'yes, keep me updated', 'notify me about my issues'. A verified identity " +
        "alone is NOT consent; Praxis sends nothing proactively until this is set. Uses the " +
        "verified runtime identity (no model-supplied arguments) and records the user's OWN " +
        "opt-in. Reversible with praxis_opt_out. Allowlist-gated.",
      parameters: Type.Object({}),
      async execute(toolCallId: string, _params: Record<string, unknown>) {
        return runConsentTool(toolContext, toolCallId, true);
      },
    }));

    optionalApi.registerTool((toolContext) => ({
      name: "praxis_opt_out",
      description:
        "Opt the chat user OUT of proactive Praxis DMs (stop the periodic digest). Call this when " +
        "the user asks to stop being messaged / unsubscribe. Uses the verified runtime identity; " +
        "revokes the user's OWN consent. Reactive answers to their questions are unaffected — " +
        "this only stops Praxis-initiated messages. Allowlist-gated.",
      parameters: Type.Object({}),
      async execute(toolCallId: string, _params: Record<string, unknown>) {
        return runConsentTool(toolContext, toolCallId, false);
      },
    }));
  },
};

export default plugin;
