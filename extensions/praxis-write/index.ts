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
  resolveWritePolicyConfig,
  type WritePolicyConfig,
} from "./policy.js";
import {
  getApiToken,
  getIssue,
  type PraxisIssueState,
  submitCommand,
} from "./praxis-write-client.js";

// The cancel-family kinds Praxis accepts off-band. `manual_override` is deliberately
// NOT here: it is too broad / terminal-state risky for a chat surface (spar MED) and is
// rejected server-side too. `unblock` is its own tool.
const CANCEL_KINDS = ["cancelled", "duplicate", "superseded", "source_closed"] as const;

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
    "Praxis operator write tools (hardened): unblock or cancel a stuck issue. Default-disabled, " +
    "allowlist-gated, two-step dry-run/confirm.",
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
  },
};

export default plugin;
