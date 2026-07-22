---
name: praxis
description: >
  Support and triage for Praxis, the GitHub-issue resolution orchestrator. Diagnose stuck or
  blocked issues, explain why an issue is where it is, and read its event trace — then escalate any
  fix to a human (this skill is read-only). Use the praxis_* tools. Also covers the user-scoped
  conversation flow ("my issues") when the praxis-write plugin is enabled for the agent.
  Triggers: "why is issue X stuck", "diagnose praxis issue", "what's blocking", "praxis status",
  "is praxis stuck", "check praxis", "list blocked issues", "praxis issue [id]", "my issues",
  "what's the status of my stuff", "my open issues".
metadata:
  openclaw:
    emoji: "🩺"
---

# Praxis support

Praxis is a deterministic state machine that drives a GitHub issue from intake to done, wrapping the
org autopilot/Sentinel engine as a swappable resolver. Your job here is **triage**: figure out _why_
an issue is where it is, explain it plainly, and hand any required action to a human. **This skill is
read-only** — see "Boundary" below.

## Tools

- `praxis_health` — connectivity + API-version check. Run this first if other tools error, to tell a
  config/auth problem apart from a real issue state.
- `praxis_list_issues` — list tracked issues, optionally filtered by `repo` and/or `state`. Use
  `state="blocked"` to find stuck issues.
- `praxis_get_issue` — one issue: state, fuses, risk score, recent events. Takes the **Praxis issue
  id**, not the GitHub number.
- `praxis_list_events` — the full append-only event trace (audit trail) for an issue.
- `praxis_diagnose_issue` — the primary triage tool. Aggregates fuses-vs-caps, open questions, the
  live resolver attempt, and unsettled outbox effects. Server-side redacted (no raw errors/tokens).

## Lifecycle

`intake → needs_info ⇄ ready → dispatch_requested → in_progress → deployed_dev → dev_uat →
user_uat → done`. Side states: `blocked` (with a reason), `cancelled`.

- **needs_info** — the issue is missing a required field; Praxis asked the reporter and is waiting.
- **ready** — sufficiency floor passed; awaiting dispatch to the resolver.
- **dispatch_requested** — handed to the engine; waiting for it to accept (the `claude-working` label).
- **in_progress** — engine accepted and is working.
- **deployed_dev → dev_uat → user_uat** — deployed; awaiting maintainer then reporter UAT verdicts.
- **blocked** — a fuse tripped or a precondition failed. The `state_reason` says which.

## Fuses (why things block)

Three retry fuses, each capped at **3**. At the cap the issue routes to `blocked`:

- `resolver` — resolver/dispatch attempts. At cap → `blocked(resolver)`.
- `uat_loop` — failed UAT rounds. At cap → `blocked(uat_loop)`.
- `nudge` — unanswered nudges to a human. At cap → `blocked(no_response)`.

In a diagnosis, each fuse shows `{count, cap, at_cap}`. **`at_cap: true` is the smoking gun** — that
fuse is why the issue is blocked.

## Playbook: diagnose → explain → escalate

1. **Diagnose.** Resolve the issue to its Praxis id (`praxis_list_issues` by repo/state if you only
   have a GitHub number or a description), then `praxis_diagnose_issue`. Pull the event trace with
   `praxis_list_events` if you need the full history.
2. **Explain.** Translate the diagnosis into plain language for the human:
   - Blocked? Name the `state_reason` and the `at_cap` fuse. (`resolver` = the engine kept failing
     to pick it up; `uat_loop` = UAT kept failing; `no_response` = a human never answered.)
   - `needs_info` with an open question? Say which `field` is missing and that the reporter must
     answer (open questions show `field`, `purpose`, `age_seconds`).
   - An unsettled `pending_effect` with `had_error: true` and rising `attempts`? A side-effect
     (dispatch/comms) is failing to send — flag it as an infra/engine problem, not issue content.
3. **Escalate.** The fix for a stuck issue is almost always a privileged action (`unblock`,
   `cancel`, `manual_override`) or a human reply (answering `needs_info`, giving a UAT verdict).
   **None of those are available in this skill.** Tell the human exactly what action is needed and
   who must take it; do not attempt it yourself.

## User-scoped conversation ("my issues")

When someone asks about **their own** issues in a DM ("what's going on with my stuff?", "any of my
issues need me?"), use the identity-scoped path from the `praxis-write` plugin (if enabled for this
agent) — it derives the verified Zoom identity from runtime context and Praxis resolves the linked
GitHub login server-side, so a user only ever sees their own issues:

1. **List** — `praxis_my_issues` (no arguments). Lead with the items where `needs_user_action` is
   true; each carries the internal `issue_id`, `ref`, `state`, and `open_question_field`.
2. **Drill down** — `praxis_my_issue` with that `issue_id`. NEVER use the org-wide
   `praxis_get_issue` / `praxis_list_issues` for a user asking about their own issues — those are
   operator tools with no per-user scoping.
3. **Act** — an issue in `needs_info` with an `open_question_field`: collect the missing detail
   conversationally, then relay it with `praxis_provide_info`. An issue in `user_uat`: ask for
   their verdict and submit it with `praxis_submit_verdict` (`pass` / `fail <reason>`).
4. **Unlinked?** — if any of these return `identity_not_linked`, offer `praxis_link_github` and
   check with `praxis_link_status` after they tap the link.

**Agent configuration note:** an end-user-facing agent should allowlist the user-scoped tools
(`praxis_my_issues`, `praxis_my_issue`, `praxis_provide_info`, `praxis_submit_verdict`,
`praxis_link_github`, `praxis_link_status`) and deliberately EXCLUDE the org-wide reads
(`praxis_list_issues`, `praxis_get_issue`, `praxis_list_events`, `praxis_diagnose_issue`) and the
operator writes — the allowlist, not this document, is the enforcement.

## Boundary (read-only)

This skill's own tools only **read** Praxis. There are no unblock/cancel/override tools here by
design. If your diagnosis concludes a mutation is needed, surface the recommendation and escalate
to a human operator — never imply you performed it. Hardened, opt-in write tools (verdicts,
needs-info relay, unblock/cancel, my-issues) live in the separate `praxis-write` plugin, each
allowlist-gated and identity-bound.
