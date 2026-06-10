// Scopely READ-ONLY genie-prompt test matrix.
// Natural, vague, user-style phrasing ("magic genie") — NOT exact tool instructions —
// to test whether a normal human's request reaches the right spoke and tool.
// READ-ONLY: every prompt here resolves to read endpoints (GET). No write is staged;
// we assert mutatingToolsCalled is empty as a safety guard. Nothing is confirmed,
// nothing reaches the channel (harness captures + suppresses egress).
//
// Run in-container:  node extensions/test-capture/harness/cases-scopely-reads.mjs
import { runScenario, resetSession } from "./harness.mjs";
import { getProfile } from "./profiles.mjs";

// Each row: { spoke (expected, informational), prompt (genie phrasing), expectTool (the
// read tool we expect in the trace; multi-step prompts may also call helper reads) }.
const MATRIX = [
  // --- scopely-observe (telemetry / read) ---
  { spoke: "scopely-observe", prompt: "are the scopely systems healthy right now?", expectTool: "scopely_health_check" },
  { spoke: "scopely-observe", prompt: "is your scopely connection still authenticated?", expectTool: "scopely_auth_status" },
  { spoke: "scopely-observe", prompt: "how many users are active at the moment?", expectTool: "scopely_active_users" },
  { spoke: "scopely-observe", prompt: "have there been any errors recently?", expectTool: "scopely_recent_errors" },
  { spoke: "scopely-observe", prompt: "who has logged in recently?", expectTool: "scopely_recent_logins" },
  { spoke: "scopely-observe", prompt: "show me the recent sessions", expectTool: "scopely_list_sessions" },
  { spoke: "scopely-observe", prompt: "what's matt keuning been up to lately?", expectTool: "scopely_user_activity" },
  { spoke: "scopely-observe", prompt: "search scopely for anything about cloudwarriors", expectTool: "scopely_search" },
  { spoke: "scopely-observe", prompt: "how are the extraction metrics looking?", expectTool: "scopely_extraction_metrics" },
  { spoke: "scopely-observe", prompt: "list the extraction sessions", expectTool: "scopely_extraction_sessions" },
  { spoke: "scopely-observe", prompt: "what does the wizard funnel look like?", expectTool: "scopely_wizard_funnel" },
  { spoke: "scopely-observe", prompt: "can you correlate the recent errors for me?", expectTool: "scopely_correlate_errors" },

  // --- scopely-admin (summaries / queues) ---
  { spoke: "scopely-admin", prompt: "show me the dashboard stats", expectTool: "scopely_dashboard_stats" },
  { spoke: "scopely-admin", prompt: "pull up the recent audit logs", expectTool: "scopely_audit_logs" },
  { spoke: "scopely-admin", prompt: "are there any pending approvals?", expectTool: "scopely_pending_approvals" },
  { spoke: "scopely-admin", prompt: "give me the session pricing summary", expectTool: "scopely_session_pricing" },
  { spoke: "scopely-admin", prompt: "show me the vendor config summary", expectTool: "scopely_vendor_config" },
  { spoke: "scopely-admin", prompt: "what's the status of the passthrough test runner?", expectTool: "scopely_passthrough_status" },

  // --- scopely-users (reads) ---
  { spoke: "scopely-users", prompt: "list the users in cloudwarriors", expectTool: "scopely_list_users" },
  { spoke: "scopely-users", prompt: "look up matt keuning's account", expectTool: "scopely_get_user" }, // search → get
  { spoke: "scopely-users", prompt: "have we sent any invites out?", expectTool: "scopely_list_invites" },
  { spoke: "scopely-users", prompt: "show me the pending access requests", expectTool: "scopely_list_access_requests" },

  // --- scopely-orgs (reads) ---
  { spoke: "scopely-orgs", prompt: "what organizations do we have?", expectTool: "scopely_list_orgs" },
  { spoke: "scopely-orgs", prompt: "show me the details on the cloudwarriors org", expectTool: "scopely_get_org" }, // list → get
  { spoke: "scopely-orgs", prompt: "what domains are attached to the cloudwarriors org?", expectTool: "scopely_list_org_domains" },

  // --- scopely-pricing (reads) ---
  { spoke: "scopely-pricing", prompt: "what currencies do we support?", expectTool: "scopely_list_currencies" },
  { spoke: "scopely-pricing", prompt: "show me the pricing defaults", expectTool: "scopely_list_pricing_defaults" },
  { spoke: "scopely-pricing", prompt: "list the pricing items", expectTool: "scopely_list_pricing_items" },
  { spoke: "scopely-pricing", prompt: "what's the session pricing configuration?", expectTool: "scopely_get_session_pricing_config" },

  // --- scopely-vendors (reads) ---
  { spoke: "scopely-vendors", prompt: "list our vendors", expectTool: "scopely_list_vendors" },
  { spoke: "scopely-vendors", prompt: "show me the 8x8 vendor", expectTool: "scopely_get_vendor" }, // list → get
  { spoke: "scopely-vendors", prompt: "what project types does 8x8 have?", expectTool: "scopely_list_project_types" },
  { spoke: "scopely-vendors", prompt: "show me the vendor terms for 8x8", expectTool: "scopely_list_vendor_terms" },

  // --- scopely-deploy (reads) ---
  { spoke: "scopely-deploy", prompt: "what deployment types exist?", expectTool: "scopely_list_deployment_types" },
  { spoke: "scopely-deploy", prompt: "show me the deployment type templates", expectTool: "scopely_list_deployment_type_templates" },
  { spoke: "scopely-deploy", prompt: "list the scoping cards", expectTool: "scopely_list_scoping_cards" },

  // --- scopely-github (reads) ---
  { spoke: "scopely-github", prompt: "list the open scopely github issues", expectTool: "scopely_gh_list_issues" },
  { spoke: "scopely-github", prompt: "search the scopely issues for anything about login", expectTool: "scopely_gh_search_issues" },
];

const profile = getProfile("scopelybot");
console.log(`\n=== Scopely READ matrix: ${MATRIX.length} genie prompts (read-only, no confirm) ===\n`);

// Reset the session ONCE up front (clean context), then run reads without per-case reset.
await resetSession(profile.sessionKey);

const results = [];
let pass = 0, fail = 0;
for (const c of MATRIX) {
  let r;
  try {
    r = await runScenario({ profileName: "scopelybot", message: c.prompt, reset: false });
  } catch (e) {
    console.log(`✗ ${c.expectTool.padEnd(38)} threw: ${e.message}`);
    fail++; results.push({ ...c, ok: false, err: e.message }); continue;
  }
  const calledTools = r.trace.filter((t) => t.kind === "tool_call").map((t) => t.tool_name);
  const toolHit = calledTools.includes(c.expectTool);
  const answered = r.summary.outboundCount >= 1;
  const noWrite = r.summary.mutatingToolsCalled.length === 0;
  const ok = toolHit && answered && noWrite;
  ok ? pass++ : fail++;
  results.push({ ...c, ok, routed: r.summary.routedSpokes, calledTools, answered, noWrite, mut: r.summary.mutatingToolsCalled });
  const mark = ok ? "✓" : "✗";
  const why = ok ? "" : ` [tool:${toolHit} answered:${answered} noWrite:${noWrite}${noWrite ? "" : " MUT=" + JSON.stringify(r.summary.mutatingToolsCalled)}]`;
  console.log(`${mark} ${c.expectTool.padEnd(38)} → routed=${JSON.stringify(r.summary.routedSpokes)}${why}`);
}

console.log(`\n=== ${pass}/${MATRIX.length} passed, ${fail} failed ===`);
console.log("Routing/tool detail (for analysis):");
for (const r of results) {
  if (!r.ok) console.log(`  MISS  "${r.prompt}"  expected=${r.expectTool}  routed=${JSON.stringify(r.routed)}  called=${JSON.stringify((r.calledTools||[]).slice(0,6))}`);
}
process.exit(fail === 0 ? 0 : 1);
