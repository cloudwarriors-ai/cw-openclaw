// Capability registry: every registered scopely_* tool belongs to one family of
// the plan's tool_family_rollout, which fixes its effect on the ZW app, its
// enablement mode, its M1 status and where its gap is tracked.
//
// Applied ONCE, in the index.ts registerTool wrapper (applyCapabilityRegistry),
// so no tool factory changes: a tool whose status is not live/local never runs
// its old-backend code. It answers "not available on the new app yet" with the
// manual path (and the tracking link once the profile supplies one), or
// "paused" for a write while read-only, with no network call. A tool
// missing from the registry is refused (deny by default); a completeness test
// derives the registered tool list from register() and fails on a missing row.
//
// Statuses reflect PK-7a/M1: the only live app request is the health GET. The
// new app's anonymous catalog is a hard-coded one-vendor placeholder (dev-stack
// spike; prod byte-identical), so the catalog reads wait for a bot identity
// (blocked-on-identity) like the other gap families; later packets flip rows.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { boundedText } from "./audit-chain.js";
import { auditBackendEvent, readBackendProfile } from "./backend-profile.js";
import { currentCall, requesterFromToolCtx, runInCall } from "./call-context.js";
import { jsonResult } from "./scopely-api.js";

export type FamilyId =
  | "F1"
  | "F2"
  | "F3"
  | "F4"
  | "F4b"
  | "F5"
  | "F6"
  | "F7"
  | "F8"
  | "F9"
  | "F10"
  | "F11"
  | "F12";

/** Effect on the ZW app. read-with-bookkeeping awaits PK-4's per-endpoint effect matrix. */
export type EffectClass = "pure-read" | "read-with-bookkeeping" | "write" | "non-api";

export type Enablement =
  | "blocked-on-identity"
  | "read-live-on-prod"
  | "repoint-config-only"
  | "blocked-on-zw2-endpoint"
  | "write-on-dev-stack-only"
  | "drop-or-replace";

/** live/local run the tool; not_available/not_ported answer from the registry. */
export type CapabilityStatus = "live" | "local" | "not_available" | "not_ported";

type Family = {
  effect: EffectClass;
  enablement: Enablement;
  status: CapabilityStatus;
  /** Why the family is unavailable today, shown to the user. */
  reason: string;
  /** Where a human does it by hand meanwhile (owner-editable wording). */
  manualPath: string;
  tools: readonly string[];
};

// No family has a filed tracking issue yet (PK-17/PK-6 file them), so none is
// built in: the live profile's issueLinks map is the only source of a
// "Tracked in" link, and without one the answer makes no tracking claim.

const FAMILIES: Record<FamilyId, Family> = {
  F1: {
    effect: "pure-read",
    enablement: "blocked-on-identity",
    status: "not_available",
    reason:
      "the new app only shows its real catalog to a signed-in identity, which the bot does not have yet",
    manualPath: "the ZW2 wizard or staff catalog screens",
    tools: [
      "scopely_list_project_types",
      "scopely_list_scoping_cards",
      "scopely_get_scoping_card",
      "scopely_list_deployment_types",
      "scopely_list_vendors",
      "scopely_get_vendor",
      "scopely_vendor_config",
    ],
  },
  F2: {
    effect: "pure-read",
    enablement: "read-live-on-prod",
    status: "not_available",
    reason: "the new app has no component health endpoint",
    manualPath: "ask the ZW2 team to check the app's health",
    tools: ["scopely_health_check", "scopely_component_health"],
  },
  F3: {
    effect: "non-api",
    enablement: "read-live-on-prod",
    status: "not_available",
    reason: "log access is paused while its credentials are rotated",
    manualPath: "ask the ZW2 team for the container logs",
    tools: ["scopely_trace_logs", "scopely_list_services", "scopely_correlate_errors"],
  },
  F4: {
    effect: "non-api",
    enablement: "repoint-config-only",
    status: "not_available",
    reason: "GitHub access is paused while its credentials are replaced",
    manualPath: "use GitHub directly",
    tools: [
      "scopely_gh_search_issues",
      "scopely_gh_get_issue",
      "scopely_gh_list_issues",
      "scopely_gh_create_issue",
      "scopely_gh_add_comment",
      "scopely_gh_close_issue",
    ],
  },
  F4b: {
    effect: "non-api",
    enablement: "repoint-config-only",
    status: "not_available",
    reason: "support tickets are moving to the new repo behind a confirm step",
    manualPath: "open the issue on GitHub directly",
    tools: ["scopely_create_support_ticket"],
  },
  F5: {
    effect: "pure-read",
    // Staff reads need the bot's own sign-in (PK-12), like the F1 catalog.
    enablement: "blocked-on-identity",
    status: "not_available",
    reason: "this read needs the bot's own sign-in to the new app",
    manualPath: "the ZW2 staff UI (All Orders)",
    tools: [
      "scopely_auth_status",
      "scopely_list_sessions",
      "scopely_get_session",
      "scopely_search",
      "scopely_sow_preview",
      "scopely_support_session",
      "scopely_session_pricing",
      "scopely_list_session_versions",
      "scopely_list_pricing_defaults",
      "scopely_get_pricing_default",
      "scopely_list_users",
      "scopely_get_user",
    ],
  },
  F6: {
    effect: "pure-read",
    enablement: "blocked-on-zw2-endpoint",
    status: "not_available",
    reason: "the new app has no matching endpoint yet",
    manualPath: "the ZW2 Django admin",
    tools: [
      "scopely_list_pricing_items",
      "scopely_list_vendor_terms",
      "scopely_list_currencies",
      "scopely_get_session_pricing_config",
      "scopely_list_deployment_type_templates",
      "scopely_compare_session_versions",
      "scopely_session_status_counts",
      "scopely_list_orgs",
      "scopely_get_org",
      "scopely_list_org_domains",
      "scopely_list_invites",
      "scopely_audit_logs",
      "scopely_activity_log",
      "scopely_recent_errors",
      "scopely_recent_logins",
      "scopely_user_activity",
      "scopely_active_users",
      "scopely_dashboard_stats",
      "scopely_wizard_funnel",
      "scopely_pending_approvals",
      "scopely_extraction_metrics",
      "scopely_extraction_sessions",
      "scopely_extraction_detail",
      "scopely_list_session_discounts",
      "scopely_list_access_requests",
      "scopely_get_org_destination_lock",
    ],
  },
  F7: {
    effect: "write",
    enablement: "blocked-on-zw2-endpoint",
    status: "not_available",
    reason: "the new app has no catalog configuration write API yet",
    manualPath: "the ZW2 Django admin (catalog configuration)",
    tools: [
      "scopely_create_scoping_card",
      "scopely_update_scoping_card",
      "scopely_delete_scoping_card",
      "scopely_update_deployment_type",
      "scopely_update_project_type",
      "scopely_delete_vendor",
      "scopely_create_vendor",
      "scopely_update_vendor",
      "scopely_create_project_type",
      "scopely_delete_project_type",
      "scopely_create_deployment_type",
      "scopely_delete_deployment_type",
      "scopely_create_deployment_type_template",
      "scopely_update_deployment_type_template",
      "scopely_delete_deployment_type_template",
      "scopely_create_vendor_term",
      "scopely_update_vendor_term",
      "scopely_delete_vendor_term",
    ],
  },
  F8: {
    effect: "write",
    enablement: "blocked-on-zw2-endpoint",
    status: "not_available",
    reason: "the new app has no rate-card write API yet",
    manualPath: "the ZW2 Django admin (pricing)",
    tools: [
      "scopely_create_pricing_item",
      "scopely_update_pricing_item",
      "scopely_delete_pricing_item",
      "scopely_update_pricing_default",
      "scopely_create_pricing_default",
      "scopely_delete_pricing_default",
      "scopely_create_currency",
      "scopely_update_currency",
      "scopely_delete_currency",
      "scopely_update_session_pricing_config",
    ],
  },
  F9: {
    effect: "write",
    enablement: "blocked-on-zw2-endpoint",
    status: "not_available",
    reason: "the new app has no audited staff user/org admin API yet",
    manualPath: "the ZW2 staff admin",
    tools: [
      "scopely_reset_user_password",
      "scopely_unlock_user",
      "scopely_set_user_active",
      "scopely_create_invite",
      "scopely_update_user",
      "scopely_resend_user_verification",
      "scopely_create_org",
      "scopely_update_org",
      "scopely_delete_org",
      "scopely_add_org_domain",
      "scopely_remove_org_domain",
      "scopely_approve_access_request",
      "scopely_reject_access_request",
      "scopely_set_org_destination_lock",
    ],
  },
  F10: {
    effect: "write",
    enablement: "write-on-dev-stack-only",
    status: "not_available",
    reason: "order lifecycle changes are only exercised on the dev stack",
    manualPath: "the ZW2 staff UI order actions",
    tools: [
      "scopely_archive_session",
      "scopely_cancel_session",
      "scopely_reopen_session",
      "scopely_revise_session",
      "scopely_clone_session",
      "scopely_generate_sow",
      "scopely_send_sow",
      "scopely_execute_sow",
      "scopely_change_sow_signer",
      "scopely_refresh_docusign_status",
      "scopely_resend_docusign",
      "scopely_reassign_session",
    ],
  },
  F11: {
    effect: "write",
    enablement: "drop-or-replace",
    status: "not_ported",
    reason: "approvals were removed in ZW2 and discounts live in the pricing editor",
    manualPath: "the pricing editor in the ZW2 staff UI",
    tools: [
      "scopely_request_session_approval",
      "scopely_approve_session",
      "scopely_reject_session",
      "scopely_add_session_discount",
      "scopely_remove_session_discount",
    ],
  },
  F12: {
    effect: "non-api",
    enablement: "drop-or-replace",
    status: "not_available",
    reason: "approver changes are frozen and the passthrough runner is retired for the new app",
    manualPath: "ask the bot owner",
    tools: [
      "scopely_list_approvers",
      "scopely_grant_approver",
      "scopely_revoke_approver",
      "scopely_passthrough_status",
      "scopely_passthrough_run_now",
    ],
  },
};

// Tools whose M1 status differs from their family default.
const STATUS_OVERRIDES: Record<string, CapabilityStatus> = {
  // F2: GET /api/v1/health/ on the profile's host, through the guarded scopelyFetch.
  scopely_health_check: "live",
  // F12: reads the bot's own approver file; never touches the app.
  scopely_list_approvers: "local",
  // F12: the legacy runner (Playwright against env URLs, outside the guard) was
  // deleted in PK-7a; both tools stay registered (INV-7) and code-refused.
  scopely_passthrough_status: "not_ported",
  scopely_passthrough_run_now: "not_ported",
};

// Tools whose effect differs from their family's: these write to GitHub or to
// the bot's approver file rather than read, so the "no write is live" rule
// covers them too (a family-level effect would hide them).
const EFFECT_OVERRIDES: Record<string, EffectClass> = {
  scopely_gh_create_issue: "write",
  scopely_gh_add_comment: "write",
  scopely_gh_close_issue: "write",
  scopely_create_support_ticket: "write",
  scopely_grant_approver: "write",
  scopely_revoke_approver: "write",
};

const TOOL_FAMILY = new Map<string, FamilyId>(
  (Object.keys(FAMILIES) as FamilyId[]).flatMap((id) =>
    FAMILIES[id].tools.map((tool) => [tool, id] as const),
  ),
);

export type Capability = {
  tool: string;
  family: FamilyId;
  effect: EffectClass;
  enablement: Enablement;
  status: CapabilityStatus;
};

export function capabilityFor(tool: string): Capability | undefined {
  const family = TOOL_FAMILY.get(tool);
  if (!family) {
    return undefined;
  }
  const { effect, enablement, status } = FAMILIES[family];
  return {
    tool,
    family,
    effect: EFFECT_OVERRIDES[tool] ?? effect,
    enablement,
    status: STATUS_OVERRIDES[tool] ?? status,
  };
}

/** Every tool row, in family order (tests compare it with registration). */
export function registryTools(): string[] {
  return (Object.keys(FAMILIES) as FamilyId[]).flatMap((id) => FAMILIES[id].tools);
}

type Outcome = "not_available" | "not_ported" | "blocked_read_only" | "not_registered";

/**
 * The deterministic answer for a tool that must not run. Never reports success
 * (INV-8); carries the manual path and, only when the live profile supplies
 * one, the family's tracking link. Audited as write_blocked_read_only or not_available, with
 * the outcome as details.reason (tool_<outcome>).
 */
export function capabilityRefusal(tool: string, forced?: "blocked_read_only") {
  const cap = capabilityFor(tool);
  const profile = readBackendProfile();
  let outcome: Outcome;
  if (forced) {
    outcome = forced;
  } else if (!cap) {
    outcome = "not_registered";
  } else if (cap.status === "not_ported") {
    outcome = "not_ported";
  } else if (cap.effect === "write" && profile.mode !== "read-write") {
    outcome = "blocked_read_only";
  } else {
    outcome = "not_available";
  }
  auditBackendEvent(outcome === "blocked_read_only" ? "write_blocked_read_only" : "not_available", {
    tool,
    family: cap?.family ?? null,
    reason: `tool_${outcome}`,
  });

  const paused = `Changes are paused: the bot is read-only, so ${tool || "this change"} did not run and nothing was staged.`;
  if (!cap) {
    const error =
      outcome === "blocked_read_only"
        ? paused
        : `${tool} is not in the bot's capability registry, so it is refused.`;
    return jsonResult({ ok: false, outcome, tool, error });
  }
  const family = FAMILIES[cap.family];
  const issue = profile.issueLinks[cap.family];
  const lead =
    outcome === "not_ported"
      ? `${tool} does not exist in the new app: ${family.reason}.`
      : outcome === "blocked_read_only"
        ? paused
        : `${tool} is not available on the new app yet: ${family.reason}.`;
  return jsonResult({
    ok: false,
    outcome,
    tool,
    family: cap.family,
    error: `${lead}${issue ? ` Tracked in ${issue}.` : ""} Manual path: ${family.manualPath}.`,
    issue: issue ?? null,
    manual_path: family.manualPath,
  });
}

// The tool currently executing (set by the wrapper, in the call context), so
// gated.ts can name the family in its read-only refusal without threading a
// tool name through every stageWrite call site.
export function currentToolName(): string | undefined {
  return currentCall()?.tool;
}

type ToolArg = Parameters<OpenClawPluginApi["registerTool"]>[0];
type AgentTool = Exclude<ToolArg, (...args: never[]) => unknown>;

const OP_CLASS: Record<EffectClass, string> = {
  "pure-read": "read",
  "read-with-bookkeeping": "read",
  write: "write",
  "non-api": "non_api",
};

type ToolOrigin = { agentId?: string; sessionKey?: string; requesterSenderId?: string };

// Both branches run inside the call context, so a refusal row
// (write_blocked_read_only, not_available) carries the requester too. A tool
// registered as a plain object (no factory ctx) has no requester: missing.
function gateTool(tool: AgentTool, origin?: ToolOrigin): AgentTool {
  const cap = capabilityFor(tool.name);
  const status = cap?.status;
  const action = {
    tool: tool.name,
    family: cap?.family ?? null,
    op_class: cap ? OP_CLASS[cap.effect] : "unknown",
    registry_status: status ?? "unregistered",
  };
  const requester = requesterFromToolCtx(origin);
  const inCall = <T>(toolCallId: unknown, fn: () => T): T => {
    // Host-supplied ids are bounded so none can push a row over the size cap.
    const id = (value: unknown) => (typeof value === "string" ? boundedText(value) : null);
    const openclaw = {
      agent_id: id(origin?.agentId),
      session_key: id(origin?.sessionKey),
      tool_call_id: id(toolCallId),
    };
    return runInCall({ tool: tool.name, trigger: "tool", requester, action, openclaw }, fn);
  };
  const execute: AgentTool["execute"] =
    status === "live" || status === "local"
      ? (...args) => inCall(args[0], () => tool.execute(...args))
      : async (...args) =>
          inCall(
            args[0],
            () => capabilityRefusal(tool.name) as Awaited<ReturnType<AgentTool["execute"]>>,
          );
  return { ...tool, execute };
}

/** Wrap a registerTool argument (tool or factory) so every produced tool is gated. */
export function applyCapabilityRegistry(tool: ToolArg): ToolArg {
  if (typeof tool !== "function") {
    return gateTool(tool);
  }
  return (ctx) => {
    // The factory ctx is the run's trusted context (sender, session): every
    // tool it builds carries it, so each call resolves its requester from it.
    const built = tool(ctx);
    if (!built) {
      return built;
    }
    return Array.isArray(built) ? built.map((t) => gateTool(t, ctx)) : gateTool(built, ctx);
  };
}
