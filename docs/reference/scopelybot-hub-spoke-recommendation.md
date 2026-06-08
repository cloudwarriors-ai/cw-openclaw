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

The hub-and-spoke is **implemented and validated**. The spoke split is config-only; two small code
changes were needed (the `streamTo` subagent fix and the Zoom thread-delivery hook — see the threading
cluster below). Summary:

- **streamTo fix** (committed `563f81dab8`): `sessions_spawn` ignores the acp-only `streamTo` param for
  `runtime=subagent` instead of erroring — this unblocked subagent spawns. The only code change required.
- **8 spokes** (unbound `gpt-5.4-mini` agents, each with an exclusive `tools.allow` of its domain tools):
  `scopely-observe` (15), `scopely-admin` (7), `scopely-users` (9), `scopely-orgs` (8), `scopely-pricing`
  (15), `scopely-vendors` (13), `scopely-deploy` (13), `scopely-github` (6). Each owns its full CRUD so
  routing is unambiguous (observe/admin = cross-cutting reads).
- **Coordinator** (`scopelybot`): `tools.allow` shrunk **111 → 4** — **router-only**:
  `sessions_spawn`, `subagents`, and `scopely_health_check`/`scopely_auth_status` (trivial liveness only).
  `subagents.allowAgents` → the 8 spokes. Its `workspace-scopelybot/IDENTITY.md` is a router prompt with the
  routing table.
  - **Key lesson (cost 4 failed live tests):** an intermediate shrink to 17 tools (kept `read`,
    `memory_search`, `memory_get`, `web_*`, `exec`) **did not work** — the coordinator used those escape
    hatches to answer domain questions from its own memory/history (and even asked permission) instead of
    routing. A router must have **no general/memory/read tools** — `sessions_spawn` should be its only path to
    domain data. Prompt hardening alone was insufficient; removing the tools was the structural fix.
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

**Threading cluster — FIXED 2026-06-04** (both validated live in one threaded conversation):

- **Inbound (was: threaded replies hijacked by `main`)** — set `channels.zoom.threading.inheritParent: true`
  (config; default is `true`, had been explicitly `false`). This re-enables core routing's `binding.peer.parent`
  fallback (resolve-route.ts) so a threaded reply matches the channel's bound agent (scopelybot) instead of
  falling through to `main`, **and** lets the thread session inherit parent context (so follow-ups like "who?"
  are answerable). Global to all Zoom channels (no per-channel threading override exists) — restores the default
  and is more correct for every bot.
- **Outbound (was: spoke results delivered to channel root, not the thread)** — added a Zoom
  `subagent_delivery_target` hook (committed `873b731e18`, parity with discord/feishu) that resolves the
  requester session's reply-root (`getRememberedZoomSessionReplyRoot`) and returns it as the delivery origin's
  `threadId`; the Zoom outbound adapter now honors `threadId` as a `replyToMessageId` fallback. Spoke results
  land in the originating thread.

**Still deferred:** cold-start `memory_search readStringParam` warning in `extensions/memory-core` (vendored
SDK, tangential).

See [Hub-and-Spoke Pattern Playbook](/reference/hub-spoke-pattern-playbook) to apply this to other agents.

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

---

## Appendix — As-deployed configuration snapshot (2026-06-08)

> **Why this is here.** The hub-and-spoke *wiring* (agent definitions, allowlists, router/worker
> personas, plugin enablement) lives in **gitignored runtime state** — `~/.openclaw/openclaw.json`
> (`agents.list[]`, `plugins.entries`, `bindings`) and `~/.openclaw/workspace-*/IDENTITY.md` — so it
> is **not otherwise reviewable from this branch**. This appendix snapshots the live config verbatim
> for review/reproducibility. It is a record only; the running environment is unchanged.

### Agents (coordinator + 8 spokes), all `model.primary = openrouter/openai/gpt-5.4-mini`, fallback `openrouter/anthropic/claude-haiku-4.5`

```
scopelybot (COORDINATOR, router-only)  tools.allow(4): sessions_spawn, subagents,
                                       scopely_health_check, scopely_auth_status
  subagents.allowAgents: scopely-observe, scopely-admin, scopely-users, scopely-orgs,
                         scopely-pricing, scopely-vendors, scopely-deploy, scopely-github

scopely-observe  (15) active_users, auth_status, get_session, health_check, list_sessions,
                      list_users, recent_errors, recent_logins, search, user_activity,
                      extraction_detail, extraction_metrics, extraction_sessions,
                      wizard_funnel, correlate_errors
scopely-admin    (7)  audit_logs, dashboard_stats, pending_approvals, session_pricing,
                      vendor_config, passthrough_run_now, passthrough_status
scopely-users    (10) approve_access_request, create_invite, list_users, get_user,
                      list_access_requests, list_invites, reject_access_request,
                      reset_user_password, set_user_active, update_user
scopely-orgs     (8)  add_org_domain, create_org, delete_org, get_org, list_org_domains,
                      list_orgs, remove_org_domain, update_org
scopely-pricing  (15) create/update/delete {currency, pricing_default, pricing_item},
                      get_pricing_default, get_session_pricing_config, list_currencies,
                      list_pricing_defaults, list_pricing_items, update_session_pricing_config
scopely-vendors  (13) create/update/delete {vendor, project_type, vendor_term},
                      get_vendor, list_project_types, list_vendors, list_vendor_terms
scopely-deploy   (14) create/update/delete {deployment_type, deployment_type_template,
                      scoping_card}, get_scoping_card, list_deployment_types,
                      list_deployment_type_templates, list_project_types, list_scoping_cards
scopely-github   (6)  gh_add_comment, gh_close_issue, gh_create_issue, gh_get_issue,
                      gh_list_issues, gh_search_issues
```
(All tool names carry the `scopely_` prefix. Spokes are **unbound**; only the coordinator is bound.)

### Plugin enablement + binding
```
plugins.entries.scopelybot = { "enabled": true, "config": { "scopelyRepos": ["cloudwarriors-ai/scopely"] } }
binding: scopelybot <- zoom channel 575b23671d6b4b7f8c22b1924b6177fa@conference.xmpp.zoom.us
```

### Coordinator persona (`workspace-scopelybot/IDENTITY.md`) — router prompt
Key clauses (full text in runtime state):
- "You are a **router**, not a doer ... only liveness checks (`scopely_health_check`,
  `scopely_auth_status`). Classify into **one** domain and delegate to that domain's spoke."
- "**NEVER answer domain questions from memory** ... immediately spawn the relevant spoke and relay
  its fresh result." / "**Do not ask permission to route.** Just spawn and answer."
- Delegation: `sessions_spawn(runtime="subagent", agentId="<spoke>", task="<full restatement>")`;
  reply **exactly `NO_REPLY`** on the spawn turn; relay only on the result turn; never poll.
- A routing table (domain -> spoke).
- Confirm-gate: "the confirmation code is handled **entirely by the system - never by you** ... a
  spoke returns `awaiting_confirmation: true` and **no code** ... reply `NO_REPLY` ... never write a
  `CONFIRM <code>` line yourself."

### Spoke persona (`workspace-scopely-users/IDENTITY.md`) — worker prompt (representative)
- "You are a **worker subagent** ... do exactly that task using only your tools, then return the
  result. You do **not** talk to the channel."
- "If you lack an id/value ... look it up with your read tools first; ... rather than guessing."
- WARNING **known drift (cleanup item):** the spoke persona still says "Return that
  `Reply CONFIRM <code>` message **verbatim**." That predates the deterministic confirm-gate fix
  (`a8eb400b39`), where `stageWrite()` now posts the prompt itself and returns a **code-free**
  result — so the spoke no longer relays a code regardless of this line. The text is obsolete and
  should be reconciled with the coordinator's "no code" contract. Functionally harmless (the code
  path is deterministic), but worth cleaning up.
