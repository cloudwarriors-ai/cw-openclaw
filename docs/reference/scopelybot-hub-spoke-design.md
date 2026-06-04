---
title: "ScopelyBot Hub-and-Spoke — Design Intent"
summary: "What we want from a coordinator/specialist-spoke split for scopelybot, and an explicit separation of what is verified vs assumed. Read the assumptions section before building."
status: exploratory
---

# ScopelyBot Hub-and-Spoke — Design Intent

> **Read this first.** This is an _intent_ document, not an approved spec. It records the
> desired flow and, deliberately, separates **verified facts** from **unverified assumptions**
> so a future implementer is not biased by guesses made during exploration. Treat everything in
> "Open questions / assumptions to validate" as **not yet proven** — re-verify before relying on it.

## Problem

`scopelybot` accumulated a large tool surface (86 own tools, and at the time of writing it could
also see other bots' tools — see "Current state"). Large tool menus degrade an agent's tool
selection. The goal is to keep the capability while reducing how many tools any single agent must
reason over at once.

## Current state (as of 2026-06-04)

- **Shipped:** scopelybot's tools are registered `optional: true` and scoped via the agent's
  allowlist, so other bots no longer see scopely tools. This did **not** by itself shrink
  scopelybot's own menu.
- **Not started:** the hub-and-spoke architecture below. Nothing here is implemented beyond a
  throwaway test agent (`scopely-probe`) left in config for a future spawn test.

## Desired general flow (what we want)

A single user-facing **coordinator** agent, bound to the channel as today, that delegates the
actual work to small, single-domain **specialist** agents ("spokes"):

```
 user (channel)
      │
      ▼
 coordinator  ── routes the request to ONE domain specialist ──►  spoke (small toolset)
      ▲                                                              │
      └──────────────  spoke returns its data to the coordinator ───┘
      │
      ▼
 coordinator composes the reply and sends it to the channel (as it already does)
```

Intended properties:

- **Spokes are pure workers.** A spoke runs its domain's tools and returns data. It does **not**
  talk to the channel itself — the coordinator owns all user-facing replies.
- **Each spoke sees only its domain's tools** (e.g. org management, pricing, vendor config, etc.),
  so any one agent reasons over a small menu.
- **The coordinator stays small** — routing + a few trivial tools — rather than holding every tool.
- **Safety is unchanged:** any write remains confirm-gated (human must reply `CONFIRM <code>`); the
  bot cannot self-approve a mutation. Whatever surfacing changes, this property must hold.
- **Scope of change is scopelybot only** — other bots/agents are not modified.

This shape mirrors a common "router + workers" pattern; the point of this doc is the _intent_, not
the mechanism.

## What is verified (facts, with evidence)

- Per-agent tool scoping works on the running build for an agent's **own** tools (confirmed live).
- The platform has a native subagent-spawn primitive and per-agent tool policy (exists in source).
- The confirm-gate is process-wide and agent-agnostic (a staged action is executed by a human
  `CONFIRM` reply regardless of which agent staged it).

## Open questions / assumptions to validate (NOT yet proven — do not assume)

These were believed during exploration but are **unconfirmed or known-uncertain**. An implementer
should treat each as a test to run, not a settled decision:

1. **Spawn round-trip on the deployed build.** A clean subagent spawn has never completed
   end-to-end here. At time of writing the running image rejected subagent spawns due to a
   `streamTo` handling difference; whether a rebuilt image resolves this must be **observed**, not
   assumed from source.
2. **Completion hand-back to the coordinator.** The spawn result returns **asynchronously** (the
   spawn call returns "accepted" immediately; the result arrives later via a completion/announce
   that must re-trigger the coordinator's turn). Whether that wake-up is reliable for this channel
   is unproven. The channel integration may or may not need additional hooks — verify before
   assuming either way.
3. **Coordinator driving the flow.** Whether the chosen coordinator model reliably emits a clean
   spawn call and correctly waits for the async completion is unproven. Do not assume a given model
   tier is sufficient or insufficient without testing.
4. **Routing.** Confirm how channel messages (including threaded/topic replies) map to the intended
   agent before relying on any agent receiving a given message.
5. **Spoke boundaries.** The exact grouping of tools into spokes is a proposal, not validated; the
   right number and split should be revisited with real usage.
6. **Build/deploy impact.** Any image rebuild bakes the whole working tree; the set of changes that
   would ship has not been fully reconciled and should be reviewed independently.

## Constraints to preserve regardless of approach

- Confirm-gated writes stay confirm-gated; no path lets the agent self-confirm.
- Changes remain scoped to scopelybot; do not modify other bots/agents as a side effect.
- Prefer reusing existing platform primitives over new runtime surfaces; prove a primitive cannot
  satisfy the need before adding one.

## Pointers

- Tool catalog / admin surface: `docs/reference/scopely-admin-config-roadmap.md`,
  `docs/reference/scopely-user-maintenance-roadmap.md`
- ScopelyBot extension: `extensions/scopelybot/`
