---
title: "ScopelyBot Tool Overload — Recommended Sequence"
summary: "Recommendation + as-built record (2026-06-04): rebuild → measure → hub-and-spoke. 8-spoke split implemented and validated. Companion to scopelybot-hub-spoke-design.md."
status: built
---

# ScopelyBot Tool Overload — Recommended Sequence

> Companion to [ScopelyBot Hub-and-Spoke — Design Intent](/reference/scopelybot-hub-spoke-design).
> That doc records the desired flow and open questions; this one records the **agreed plan of
> attack** after verifying the platform primitives and reviewing prior art (Anthropic guidance,
> upstream OpenClaw features). Agreed by the operator on 2026-06-04.

## Implementation status (BUILT — 2026-06-04)

The hub-and-spoke is **implemented and validated** (config-only; no core code change beyond the
streamTo fix below). Summary:

- **streamTo fix** (committed `563f81dab8`): `sessions_spawn` ignores the acp-only `streamTo` param for
  `runtime=subagent` instead of erroring — this unblocked subagent spawns. The only code change required.
- **8 spokes** (unbound `gpt-5.4-mini` agents, each with an exclusive `tools.allow` of its domain tools):
  `scopely-observe` (15), `scopely-admin` (7), `scopely-users` (9), `scopely-orgs` (8), `scopely-pricing`
  (15), `scopely-vendors` (13), `scopely-deploy` (13), `scopely-github` (6). Each owns its full CRUD so
  routing is unambiguous (observe/admin = cross-cutting reads).
- **Coordinator** (`scopelybot`): `tools.allow` shrunk **111 → 17** (dropped all 86 domain tools + the
  `scopelybot` plugin-id entry that re-granted them; kept core + `sessions_spawn`/`subagents` +
  `scopely_health_check`/`auth_status` for trivial liveness). `subagents.allowAgents` → the 8 spokes. Its
  `workspace-scopelybot/IDENTITY.md` is now a router prompt with the routing table.
- **Isolation** is guaranteed by `isOptionalToolAllowed` (src/plugins/tools.ts): scopely tools are
  `optional:true`, so a spoke sees only the tool names in its allowlist; other domains' tools are excluded.
- **Confirm-gate works cross-agent, unchanged**: `putPending`/`takePending` is a process-wide store and
  `CONFIRM <code>` is executed by the channel-level `message_received` hook (scopelybot/index.ts), which
  short-circuits before any LLM turn. A spoke stages → coordinator relays the `CONFIRM` prompt verbatim →
  user confirms → the hook executes. The LLM is never in the execution path; safety holds.
- **Validated**: spawn round-trip + announce-back to Zoom proven end-to-end (a real channel message);
  routing discriminates correctly ("list orgs"→`scopely-orgs`→`scopely_list_orgs`; "recent errors"→
  `scopely-observe`→`scopely_recent_errors`); coordinator runs only `sessions_spawn`, never domain tools.

**Where it lives / how to operate:** all spoke config is runtime state under `.data/openclaw/` (gitignored,
not a repo artifact) — `openclaw.json` (`agents.list[]` + coordinator allow/allowAgents) and
`workspace-scopely-<spoke>/IDENTITY.md`. To add/move a tool between spokes, edit the spoke's `tools.allow`
and restart the gateway. Backups: `/root/backups/moltbot/openclaw.json.bak-{pre,post}spokes-*`.

**Known follow-ups (deferred):** (1) spoke results announce to the Zoom **channel root, not the originating
thread** — Zoom lacks the `subagent_delivery_target` hook discord/feishu have; pairs with the (2) known
routing bug where threaded replies route to `main`. (3) cold-start `memory_search readStringParam` warning
in `extensions/memory-core` (vendored SDK, tangential).

## Headline

**The wheel already exists.** OpenClaw natively ships everything the hub-and-spoke design needs —
no custom orchestration, router layer, or new runtime surface is required. However, prior art says
the hub-and-spoke should be the **last** lever pulled, not the first: cheaper levers (foreign-tool
scoping via rebuild, tool consolidation) may resolve most of the degradation on their own.

## What was verified (2026-06-04, against current src)

### The platform primitive is complete

The router+workers pattern maps 1:1 onto existing primitives:

- **Spawn + push-based hand-back.** `sessions_spawn(runtime=subagent)` returns "accepted"
  immediately; on the child's lifecycle `end`, `completeSubagentRun()`
  (`src/agents/subagent-registry.ts:823`) runs the announce flow, which injects the result into the
  requester's session via a gateway `agent` call (`src/agents/subagent-announce.ts:609`),
  **re-triggering the coordinator's turn**. This resolves design-doc open question #2 — the
  completion hand-back is push-based platform behavior, not something to build.
- **Zoom's missing delivery hooks do not break this.** The `subagent_delivery_target` hook
  (discord/feishu implement it; zoom does not) only redirects where the _announcement_ lands.
  Without the hook, the fallback is `requesterOrigin` (`src/agents/subagent-announce.ts:566`) —
  i.e., back to the coordinator's session, which is exactly what the design wants ("spokes never
  talk to the channel"). The missing hook is arguably a feature here.
- **Per-agent allowlists** already proven live for an agent's own tools (Stage 1, commit
  `646a3b9496`).
- **No alternative primitive exists.** The codebase has no deferred tool loading, no tool search,
  and tool profiles cover core tools only. Spokes-via-subagents _is_ the native answer if
  agent-level splitting is needed.

### Prior art reorders the problem

Anthropic's guidance for "too many tools degrades selection," in priority order:

1. **Consolidate + sharpen tools**
   ([Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).
   Degradation starts around 30–50 tools. Merging thin CRUD wrappers and adding tool-use examples
   moved their complex-parameter accuracy 72%→90%. Cheapest lever, no architecture change.
2. **Deferred tool loading / Tool Search** — **not applicable**: it is a server-side Claude API
   feature; scopelybot runs gpt-5.4-mini via OpenRouter.
3. **Orchestrator-workers**
   ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).
   Anthropic explicitly flags this as a poor fit for sequential CRUD-style work (~15× token cost;
   the gains come from parallel breadth-first research). For scopelybot it is valid **only** for
   the small-menu-per-agent effect — use it as lightweight delegation, never as parallel
   orchestration.

## Recommended sequence

### Step 0 — Rebuild the image (the single unlock)

A rebuild from current src is intended to clear both known blockers:

- the `streamTo` rejection that blocks subagent spawns on the running image, and
- the allowlist pipeline that filters foreign (other bots') non-optional tools.

**This is a hypothesis, not a proven fix.** The streamTo fix (`effectiveStreamToParent` confined to
`acp-spawn.ts`, not the subagent path) was committed 2026-03-10 (`9f5dee32f6`) — which _predates_
the 2026-04-26 running image, yet the 06-03 G0 test still showed that image rejecting subagent
spawns. The most likely explanation is that the 04-26 image was built from stale src or a Docker
layer cache. So a clean `--no-cache` rebuild is the unlock to _try_, but **G0 (Step 3, the live
spawn round-trip) is the only real proof** the spawn path works. If G0 still rejects streamTo on a
fresh build, the cause is elsewhere and the spoke plan needs a different unlock.

Nothing downstream can be tested until the rebuild lands. **Caveat:** the rebuild bakes the whole
working tree — do a deliberate review of dirty `src/` WIP first (other agents' in-flight changes
would activate). As of 2026-06-04 the only uncommitted _core_ change is a plugin-loader memory-leak
fix in `src/plugins/*`; all 10 commits since the running image are scopely-extension (already live
via jiti) + docs.

### Step 1 — Measure before building spokes

Post-rebuild, scopelybot drops from ~285 visible tools to ~116 (86 own + core) with zero
additional work — the worst confusion source (199 foreign tools) disappears. Run against real
channel traffic for a few days. ~116 is still above the degradation threshold, but the fumbling
may have mostly come from the foreign tools. Decide from observed behavior, not assumption.

### Step 2 — Tool consolidation pass (missing from the original plan)

The 86 tools are CRUD-heavy. Merge per-entity get/list/create/update/delete into fewer
multi-action tools, sharpen names/descriptions, and add usage examples to descriptions. A
plausible landing zone is 35–50 tools — at or near the threshold — which may make spokes
unnecessary, and definitely makes each spoke better if they are built.

**Review flag:** consolidation changes confirm-gated write surfaces; every merged tool must
preserve the staging/CONFIRM semantics.

### Step 3 — Hub-and-spoke, only if still needed

Proceed as the design-intent doc describes, using native config only:

- **G0 first:** live spawn + announce-back round-trip on the rebuilt image — the one thing
  source-reading cannot prove (design-doc open questions #1 and #3).
- **6 spokes** as previously agreed: observe (~17) / users (~11) / orgs (8) / pricing (15) /
  vendor (13) / deploy+cards (13). Each is an unbound agent with an exclusive allowlist.
- **Coordinator** keeps `sessions_spawn` + `subagents.allowAgents` + a handful of trivial reads.
- **Confirm-gate hardening:** the gate is process-wide and agent-agnostic, so safety holds
  regardless of which agent stages a write — but post gate messages directly via
  `sendScopelyText` so CONFIRM codes never pass through an LLM relay (now two LLM hops).
- **Risks to watch:** whether gpt-5.4-mini reliably emits clean spawn calls and waits for the
  async completion (live-test only), and added latency/token cost (every spoke call is a second
  full agent turn).

### Independent fix — threaded-reply routing bug (land with or before Step 0)

Threaded/topic replies in the vipbot channel route to the unscoped `main` agent (~285 tools,
`tools` config null), not scopelybot — confirmed 3× via session paths. This hits prod users today
and silently undoes all scoping work for threaded conversations. Note the audit log hardcodes
`actor: "scopelybot"`, so use the session path as ground truth, not the audit log.

## What NOT to do

- Do not build a custom router layer, LangGraph-style supervisor, or any new runtime surface —
  `sessions_spawn` + allowlists + channel bindings cover it.
- Do not copy Anthropic's parallel multi-agent pattern — this workload is sequential delegation,
  not breadth-first research.
- Do not skip Step 2 and jump to spokes — six agents each holding poorly-described CRUD wrappers
  is six small versions of the same problem.

## Constraints carried over (unchanged)

- Confirm-gated writes stay confirm-gated; no path lets any agent self-confirm.
- Changes remain scoped to scopelybot; other bots/agents are not modified.
- Prefer existing platform primitives; prove a primitive cannot satisfy the need before adding one.

## Sources

- [Writing effective tools for agents — Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [How we built our multi-agent research system — Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Building effective agents — Anthropic](https://www.anthropic.com/research/building-effective-agents)
- [Tool search tool — Claude API docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)

## Pointers

- Design intent + open questions: `docs/reference/scopelybot-hub-spoke-design.md`
- Tool catalog / admin surface: `docs/reference/scopely-admin-config-roadmap.md`,
  `docs/reference/scopely-user-maintenance-roadmap.md`
- ScopelyBot extension: `extensions/scopelybot/`
