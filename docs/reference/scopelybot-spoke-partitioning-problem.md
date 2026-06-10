---
title: "ScopelyBot Spoke Tool-Partitioning — Problem Statement"
summary: "The 86 tools were split across 8 spokes by action-class, not by the domain the coordinator routes on. Read/dependency tools end up siloed away from the spoke that fields their questions, and the routing table and allowlists drift independently. This doc describes the problem and what a good split must achieve — it does NOT prescribe a solution."
status: exploratory
---

# ScopelyBot Spoke Tool-Partitioning — Problem Statement

> **Scope of this doc.** This describes a recurring class of failure in how scopelybot's tools are
> divided among spokes, with concrete evidence. It deliberately does **not** propose a fix — only
> the problem, why it keeps happening, and the criteria any future rework must satisfy. A separate
> design doc will own the solution.

## Context

`scopelybot` is a router **coordinator** plus 8 single-domain **specialist spokes** (see
`scopelybot-hub-spoke-design.md`). The coordinator owns no domain tools; it classifies each user
request into one domain and delegates to that domain's spoke via `sessions_spawn`. Each spoke has a
small `tools.allow` allowlist. The 86 Scopely tools were partitioned across the spokes:

```
scopely-observe   telemetry/read       (~15 tools)
scopely-admin     summaries/queues     (~7)
scopely-users     user mutations       (10)
scopely-orgs      orgs/domains         (8)
scopely-pricing   pricing/currency     (15)
scopely-vendors   vendors/project-types(13)
scopely-deploy    deployment/scoping   (14)
scopely-github    GitHub issues        (6)
```

## The problem

**Tools were grouped by action-class (listing, summaries, CRUD, telemetry) instead of by the
domain noun the coordinator actually routes on.** The coordinator routes on the noun in the request
("users", "vendors", "scoping cards"). When a _read_ or _dependency-resolution_ tool for that noun
lives in a different spoke, the spoke that receives the question cannot answer it.

This is not a one-off; it is a **structural mismatch** between the routing axis (domain noun) and
the partitioning axis (action class). It produces a steady trickle of "the bot can't do X" reports
that are each individually "just add a tool" but collectively signal the split is wrong.

### Evidence — three instances of the same failure

1. **Scoping cards (resolved 2026-06-05).** `scopely-deploy` owns `scopely_list_scoping_cards` but
   the cards endpoint needs a numeric `project_type_id`, and the resolver
   `scopely_list_project_types` lived only in `scopely-vendors`. Asked for "8x8 UCaaS scoping
   cards," the deploy spoke could not resolve `ucaas → 66`, **brute-forced `project_type_id` 0–10
   (all 404), and gave up**. Fixed by adding the resolver to `scopely-deploy`.

2. **List users (resolved 2026-06-05).** `scopely_list_users`, `scopely_active_users`,
   `scopely_user_activity` were all assigned to `scopely-observe`. "List users in CloudWarriors"
   routes to `scopely-users` (per the routing table), which had only `scopely_get_user` + user
   mutations — **no way to enumerate users**. The spoke **approximated from access-requests/invites
   and honestly reported it could not produce an authoritative list**. Fixed by adding
   `scopely_list_users` to `scopely-users`.

3. **Cross-cutting overlap (open).** `scopely-admin` ("summaries") and `scopely-observe`
   ("telemetry") cut **across every domain**: `scopely_session_pricing` and `scopely_vendor_config`
   live in `admin`; `scopely_active_users`/`scopely_user_activity` live in `observe`. So
   "vendor config" could plausibly route to `vendors` _or_ `admin`; "active users" to `users` _or_
   `observe`. This is **routing ambiguity by construction** — the coordinator has to guess which
   spoke owns a tool, and a weak model guesses wrong.

### Symptoms this produces

- Spokes that **cannot answer in-domain questions** because a needed read/lookup tool is elsewhere.
- Spokes **brute-forcing or approximating** (guessing ids, deriving counts from proxy data) instead
  of calling the right tool — which then looks like a model failure but is a missing-tool failure.
- **Routing ambiguity** for cross-cutting spokes (admin/observe), worsened by the weak coordinator
  model.
- Each gap is discovered **one user complaint at a time**, in production, rather than caught up front.

## Secondary problem: routing table and allowlists drift independently

The coordinator's routing table lives in prose in `IDENTITY.md`; each spoke's tools live in
`tools.allow` in `openclaw.json`. **They are maintained separately and have no shared source of
truth.** This is literally how the `list_users` gap shipped: the routing table sent user questions
to `scopely-users`, but `scopely-users`'s allowlist did not contain `scopely_list_users`. There is
no check that "every question the table routes to spoke S can be answered by the tools S actually
has." Nothing prevents the table and the allowlists from disagreeing.

## Why it keeps happening (root cause)

- **Wrong partitioning axis.** Splitting by action-class (list/summary/CRUD/telemetry) cuts across
  the domain nouns the router reasons about. A domain's read + write + dependency-resolution tools
  get scattered across spokes.
- **No coverage contract.** There is no artifact asserting that the routing target for an intent
  actually holds the tools to satisfy it.
- **Thin tool descriptions.** Even when a tool is in the right spoke, the spoke's own model picks
  and sequences tools from names + descriptions. Where descriptions omit how to obtain a required
  parameter (e.g. "`project_type_id` comes from `scopely_list_project_types`"), the model
  brute-forces (observed: 0–10 id guessing). Description quality compounds the partitioning
  problem, especially under `gpt-5.4-mini`.

## What a good split must achieve (success criteria, not a design)

Any future rework should be judged against these — the _how_ is out of scope for this doc:

1. **Routing axis == partitioning axis.** A request classified to a domain noun must land on a
   spoke that holds the full surface needed to answer it (read + write + the lookups those depend
   on), so the coordinator never has to know which sibling holds a dependency tool.
2. **No cross-domain dependency reaches.** A spoke should not need to have called a tool that lives
   in another spoke to complete a single in-domain task.
3. **Unambiguous routing.** For any user intent there should be one obviously-correct spoke. Where
   cross-cutting concerns (telemetry, summaries) genuinely exist, their charter must be crisp enough
   that the coordinator applies it mechanically.
4. **Single source of truth / coverage guarantee.** The routing table and the spoke allowlists must
   not be able to drift — a representative intent should be provably answerable by the spoke it
   routes to.
5. **Right-sized, well-described spokes.** Small enough that the spoke's model selects tools
   reliably; descriptions that name how to obtain required parameters so the model resolves instead
   of guessing.
6. **Lower the reasoning bar.** Better grouping + descriptions should make correct routing and tool
   use achievable even by a weak coordinator model — reducing dependence on a model upgrade.

## Out of scope (intentionally)

- The mechanism for grouping (re-partition, merge cross-cutting spokes, generate config from a
  declarative map, etc.).
- The model question (`gpt-5.4-mini` vs a stronger coordinator) — relevant, but a separate lever.
- Tool-description rewriting specifics.

These belong in a follow-up design doc once the problem framing here is agreed.
