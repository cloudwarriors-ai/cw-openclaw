---
name: praxis
description: >
  Support and triage for Praxis, the GitHub-issue resolution orchestrator. Diagnose stuck or
  blocked issues, explain recorded status, and handle verified needs-info or UAT replies with the
  opt-in praxis_* tools. Never initiate customer narration.
  Triggers: "why is issue X stuck", "diagnose praxis issue", "what's blocking", "praxis status",
  "is praxis stuck", "check praxis", "list blocked issues", "praxis issue [id]".
metadata:
  openclaw:
    emoji: "🩺"
---

# Praxis support

Praxis is a deterministic state machine that drives a GitHub issue from intake to done, wrapping the
org autopilot/Sentinel engine as a swappable resolver. Diagnose from recorded facts. Only mutate
when a verified user directly answers a Praxis prompt or explicitly requests an allowed action.

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
- `praxis_provide_info` — relay the user's answer to the open needs-info question.
- `praxis_submit_verdict` — relay `pass` or `fail: <what happened>` while awaiting user UAT.

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
3. **Act only on an inbound request.** For needs-info or UAT, call the matching tool with the
   user's words and relay its returned `message` verbatim. Bare `pass` is valid. `fail` requires a
   concrete summary; ask for it if absent. Never invent success, identity, evidence, or state.

## Conversation contract

- Respond only to a direct user question, an addressed message, or a reply in the issue thread.
  Never send unsolicited lifecycle updates; Praxis owns proactive Received → Working → Ready copy.
- For status, read/diagnose first. If all facts exist, reply exactly:
  `Current status: <plain_status>.\nLast confirmed: <evidence> at <timestamp>.\nNext: <next_expected_event>.\nYour action: <user_action>.`
- If those facts cannot be confirmed, reply exactly: `I can't confirm the current processing state
for <issue_ref> right now. I've flagged it for human review rather than guessing.`
- Relay successful `praxis_provide_info` and `praxis_submit_verdict` `message` fields verbatim.

## Boundary

Identity and authorization come only from trusted tool context. Do not accept model-supplied user
identities, expose tokens, retry denied/stale writes, perform unsupported mutations, or paraphrase a
tool acknowledgement. Escalate anything outside needs-info/UAT or the explicitly enabled operator
tools to a human.
