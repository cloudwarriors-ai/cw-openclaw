---
title: "Hub-and-Spoke for Support Bots — Comprehensive Implementation Guide"
summary: "The canonical, end-to-end guide to splitting an overloaded OpenClaw support bot into a router coordinator + single-domain specialist spokes: when it's worth doing, the exact native primitives and config, confirm-gated writes, deploy, noise-free validation with the test-capture harness, and every failure mode we hit in production. Supersedes hub-spoke-pattern-playbook.md and folds in the scopelybot as-built record, confirm-gate fidelity, and test-harness docs."
status: reference
---

# Hub-and-Spoke for Support Bots — Comprehensive Implementation Guide

> **Scope.** A reusable, copy-this guide for applying the hub-and-spoke pattern to *any* OpenClaw
> support bot (scopelybot, pulsebot, bigheadbot, zoomwarriorssupportbot, …). First proven on
> `scopelybot` (86 tools → router + 8 spokes, live-validated). This is the single canonical
> reference; it supersedes `hub-spoke-pattern-playbook.md` and absorbs the lessons from
> `scopelybot-hub-spoke-recommendation.md`, `scopelybot-confirm-gate-fidelity.md`, and
> `agent-test-harness-design.md`. Read those only for deeper history.

---

## 1. What it is

One user-facing **coordinator** agent (bound to the channel) that owns *no domain tools* — it
classifies each request into one domain and delegates to a single-domain **specialist spoke** via
`sessions_spawn(runtime=subagent)`. Each spoke sees only its own small toolset; the coordinator
composes/relays the reply.

```
 user (channel) ─▶ coordinator (router; ~4 tools, no domain data)
                        │  sessions_spawn(runtime="subagent", agentId="<spoke>", task="…")
                        ▼
                   spoke (small exclusive toolset) ── runs tools, returns data ──┐
                        ▲                                                          │
 coordinator relays the spoke's result into the originating thread ◀──────────────┘
```

Built entirely on native OpenClaw primitives — **no custom orchestration**:
`sessions_spawn` + per-agent `tools.allow` allowlists + `subagents.allowAgents` + channel bindings.

---

## 2. When to use it (decision framework — read this BEFORE building)

Hub-and-spoke is **not free**: every delegated call costs a full subagent spawn round-trip
(latency + 2–3× model tokens), it needs a capable-enough coordinator model, and it adds deploy and
session-management complexity. Apply it only when the payoff is real.

**The trigger is confusable-tool density and *measured* misrouting — NOT raw tool count.**
A model selects reliably among 40–50 *distinct, well-known* tools (`read`, `exec`, `gh_create_issue`,
`zoom_send`, …). It fails among dozens of *near-synonym domain* tools in one menu (scopelybot's
`list_users` vs `active_users` vs `list_invites`; CRUD across orgs/pricing/vendors/deploy). Count the
**confusable domain surface**, not the menu size.

Decision checklist for a candidate bot:
1. **Measure first.** Use the test-capture harness (§8) to inject representative domain requests and
   inspect tool selection / routing. Only act on demonstrated misrouting.
2. **Is the confusable domain surface large (≈30+ same-domain tools with overlapping names)?** If no,
   prefer cheaper fixes: sharpen tool descriptions, consolidate thin CRUD wrappers, or split the
   *menu* with a shared tool bundle (§10) — not a full coordinator/spoke split.
3. **Is the bot unscoped (no `tools.allow`)?** Then its real problem is *missing scoping*, not
   confusability — give it an allowlist first (an unscoped agent sees every non-optional plugin tool
   across all bots; see §3). That alone may resolve it.
4. **Is the per-call spawn cost acceptable?** Hub-and-spoke doubles model turns per request. Fine for
   a research/admin bot; reconsider for a latency-sensitive, high-frequency bot.

If 1–4 say yes, proceed. Otherwise stop — the pattern will cost more than it saves.

---

## 3. How tool scoping actually works (the mechanism you must understand)

Source of truth: `src/plugins/tools.ts` (filtering at lines ~828–845; `isOptionalToolAllowed` ~277).

- A **non-optional** plugin tool is included for an agent iff its name is in that agent's resolved
  available set (derived from its `tools.allow` / profile). An agent with **no allowlist** gets the
  default profile = **every non-optional plugin tool across all loaded plugins** (this is why an
  unscoped bound agent like `customer-support`/`main` can silently see 150+ tools).
- An **optional** plugin tool (registered `optional: true`) is included **only if explicitly allowed**
  (by tool name, plugin id, `group:plugins`, or `*`). If the allowlist doesn't name it, it's hidden —
  even from unscoped agents.

**Consequence for hub-and-spoke:** register the bot's tools `optional: true` so per-agent allowlists
actually scope them and they don't leak into other agents' default profiles. Then the coordinator's
tiny allowlist and each spoke's exclusive allowlist do real work.

```ts
// extensions/<bot>/index.ts — wrap registerTool so every tool is optional.
const optionalApi: OpenClawPluginApi = {
  ...api,
  registerTool: (tool, opts) => api.registerTool(tool, { ...opts, optional: true }),
};
registerXxxTools(optionalApi, logger); // ...register all the bot's tools through optionalApi
```

> **Verify after wiring:** the tool-policy log line `tool policy removed N tool(s) via
> agents.<id>.tools.allow: …` shows the allowlist filtering. Model self-reports about "which tools do
> you have" are unreliable — trust the gateway log / the harness trace, not the agent.

---

## 4. Prerequisites (channel-level; shared, mostly already shipped)

For a Zoom bot these already exist (landed during the scopelybot build) and a new hub-and-spoke bot
inherits them for free:
1. **Subagent spawn unblock** — `sessions_spawn` ignores acp-only `streamTo` for `runtime=subagent`.
2. **Inbound threading** — `channels.zoom.threading.inheritParent: true` routes threaded replies to
   the channel-bound agent with parent context.
3. **Outbound in-thread delivery** — the Zoom `subagent_delivery_target` hook lands spoke results in
   the originating thread, not channel root.

For a **non-Zoom** channel, verify the equivalent `subagent_delivery_target` hook exists (discord/
feishu ship one; others may need it).

---

## 5. Per-bot implementation recipe

### 5a. Define the spokes (one unbound agent per domain)
Each spoke is an entry in `agents.list[]` in `~/.openclaw/openclaw.json`
(`.data/openclaw/openclaw.json` in the dev container):

```jsonc
{
  "id": "scopely-users",
  "model": { "primary": "openrouter/openai/gpt-5.4-mini",
             "fallbacks": ["openrouter/anthropic/claude-haiku-4.5"] },
  "tools": { "allow": [            // EXCLUSIVE allowlist = exactly this domain's tools
    "scopely_list_users", "scopely_get_user", "scopely_reset_user_password",
    "scopely_set_user_active", "scopely_update_user", "scopely_create_invite",
    "scopely_list_invites", "scopely_list_access_requests",
    "scopely_approve_access_request", "scopely_reject_access_request"
  ] }
}
```
Each spoke gets a `workspace-<spoke>/IDENTITY.md` worker prompt (template in §11). Same model as the
coordinator is fine. Spokes are **unbound** (no `bindings` entry) — only the coordinator is bound.

### 5b. Make the coordinator router-only
Shrink the coordinator's `tools.allow` to *just* routing + at most 1–2 trivial liveness reads, and
set `subagents.allowAgents` to the spoke ids:

```jsonc
{
  "id": "scopelybot",
  "model": { "primary": "openrouter/openai/gpt-5.4-mini",
             "fallbacks": ["openrouter/anthropic/claude-haiku-4.5"] },
  "tools": { "allow": ["sessions_spawn", "subagents",
                       "scopely_health_check", "scopely_auth_status"] },
  "subagents": { "allowAgents": ["scopely-observe","scopely-admin","scopely-users","scopely-orgs",
                                 "scopely-pricing","scopely-vendors","scopely-deploy","scopely-github"] }
}
```

> ### THE critical lesson (cost 4 failed live tests on scopelybot)
> The coordinator must have **NO general tools** — no `read`, `memory_search`, `memory_get`,
> `web_*`, `exec`. If it can read anything, a weak model uses that to answer domain questions from
> its own memory/history instead of delegating, and tends to ask permission instead of acting.
> `sessions_spawn` must be its **only** path to domain data. **Prompt hardening alone is not enough —
> remove the tools.**

### 5c. Enable the bot in discovery
An extension only loads if its id is in `plugins.entries` in `openclaw.json` — having the dir +
manifest + `OPENCLAW_BUNDLED_PLUGINS_DIR` is **not** enough, and discovery skips unlisted plugins
*silently* (no log, no error):
```jsonc
"plugins": { "entries": { "<bot>": { "enabled": true }, /* … */ } }
```

### 5d. Bind the coordinator to the channel
```jsonc
"bindings": [ { "agentId": "<bot>",
  "match": { "channel": "zoom", "peer": { "kind": "channel", "id": "<channelJid>" } } } ]
```

---

## 6. Spoke partitioning rules

The recurring failure mode (documented in `scopelybot-spoke-partitioning-problem.md`) is splitting
tools by **action-class** (list / summary / CRUD / telemetry) instead of by the **domain noun the
coordinator routes on**. Get this right:

- **Routing axis == partitioning axis.** A request classified to a domain noun ("users", "pricing")
  must land on a spoke holding the *full* surface to answer it — reads **and** writes **and** the
  lookups those depend on. The coordinator must never need to know which sibling holds a dependency.
- **Each spoke owns its full CRUD.** Don't split "read pricing" and "edit pricing" across spokes.
- **No cross-domain dependency reaches.** If a write needs an id from a lookup, that lookup lives in
  the *same* spoke (scopelybot bug: scoping cards needed `list_project_types`, which lived in a
  different spoke → the deploy spoke brute-forced ids 0–10 and gave up).
- **Cross-cutting reads** (telemetry, dashboards, audit) get a dedicated `observe`/`admin` spoke —
  but keep their charter crisp, or you reintroduce routing ambiguity ("active users" → users *or*
  observe?).
- **Keep each spoke ≲ 30 tools.** Merge thin wrappers / sharpen descriptions first if a single domain
  is still too big.
- **One spoke = one unambiguous intent.** If a request could plausibly route to two spokes, the split
  is wrong.

There is no shared source of truth between the coordinator's routing table (prose in `IDENTITY.md`)
and the spoke allowlists (`openclaw.json`) — they drift. After any change, **prove with the harness
(§8) that every representative intent the table routes to spoke S is answerable by S's tools.**

---

## 7. Confirm-gated writes (deterministic, LLM-out-of-the-loop)

Any destructive write must be confirm-gated, and — critically — the confirmation code must **never
pass through the LLM** (a small coordinator model fabricates, rewrites, re-relays, and duplicates
codes; observed live). The proven pattern (scopelybot `gated.ts` + `index.ts`):

1. **Single staging chokepoint.** Every write tool calls one `stageWrite(summary, run)` helper that:
   generates the code, `putPending({code, summary, run})` (in-memory, single-use, 5-min TTL), and
   **delivers the `⚠️ Confirm … CONFIRM <code>` prompt to the channel itself** (threaded), returning
   a **code-free** `{staged, awaiting_confirmation}` result to the model. The model never sees a code.
2. **Execution in `before_dispatch`, not an observe hook.** A `before_dispatch` hook matches
   `^CONFIRM\s+\d{4}` and runs the staged action, returning `{handled: true, text: <result>}`.
   `handled:true` **suppresses the coordinator** (so the CONFIRM can't re-stage) and the result is
   delivered threaded by core. (`message_received` is fire-and-forget and runs *before*
   `before_dispatch` — do **not** execute there, or it consumes the pending first.)
3. **Persona guard (defense-in-depth).** Coordinator `IDENTITY.md`: "never emit/relay/invent a
   `CONFIRM <code>`; on `awaiting_confirmation` reply `NO_REPLY`; if a message is `CONFIRM <code>`,
   reply `NO_REPLY`."

Invariants: fail-closed (single-use, TTL, human-typed; the LLM cannot fabricate the inbound CONFIRM),
and the **whole write class** routes through the one chokepoint so no tool relies on LLM relay.

Key source: `before_dispatch` fires at `src/auto-reply/reply/dispatch-from-config.ts:~2082`
(`handled` → threaded `sendFinalPayload` + early return); `message_received` is fire-and-forget at
`~1893`; void/early-return hooks are safe (`src/plugins/hooks.ts` `runClaimingHooksList ~737`).

---

## 8. Validation — noise-free, with the test-capture harness

Use `extensions/test-capture/` (see `agent-test-harness-design.md`) to drive the bot's **real**
pipeline and capture+suppress all channel egress — **no writes to the live channel** — while
recording the routing/tool trace. To onboard a new bot:

1. Add a profile to `extensions/test-capture/harness/profiles.mjs`:
   `{ agentId, channelIdRaw, channelJid, sessionKey, operator, routerTools }`.
2. Enable capture: `OPENCLAW_TEST_CAPTURE=1` (dev compose) + the bot is in `plugins.entries`.
3. Run in-container (host Node 20 can't open the `node:sqlite` capture DB):
   `docker exec openclaw sh -lc 'cd /app && node extensions/test-capture/harness/cases.mjs'`

Assertions the harness makes possible (all payload/trace-level, no screenshots):
- **Routing discrimination** — request X spawned spoke Y (`sessions_spawn` `params.agentId`).
- **Router-only coordinator** — coordinator's tool calls ⊆ `{sessions_spawn, subagents, liveness}`.
- **Per-spoke tool use / no cross-spoke reach** — spoke Y answered with only its own tools.
- **Confirm-gate fidelity** — confirm prompt posted *with* a code; coordinator reply code-free;
  in-thread; wrong code = no-op (fail-closed).
- **Safety guard** — a *read* request triggered *no* write/staging tool (catches the contamination
  class directly).

Validation gates to run in order: spawn round-trip → routing discrimination → in-thread delivery →
confirm-gate. The harness covers all four.

---

## 9. Deploy model + gotchas

- **Extensions are jiti-live** from the `./extensions` bind-mount: edit `extensions/<bot>/**`, then
  restart the container. **Core `src/**` changes need a `docker build`** (the container runs baked
  `dist/`). A full `pnpm build` can OOM the box — avoid unless necessary.
- **NEVER `rm -rf /tmp/jiti/*`** — it forces a cold re-transpile of *every* extension on the next
  message (~70s + a memory spike to critical). jiti re-transpiles only changed files by mtime; just
  restart. (Wiping the whole cache caused a self-inflicted "bot hung" stall.)
- **First message after a restart is slow** (~70s cold load of all extensions); subsequent messages
  are fast. Tooling/timeouts must tolerate this.
- **Spoke/coordinator config + IDENTITY.md live in gitignored runtime state** (`.data/openclaw/…`).
  Back up before/after (`.bak-*`); that's the rollback.
- **`plugins.entries` and `tools.allow`/`subagents` changes need a container restart** (tool policy
  loads at start). Moving a tool between spokes = edit the spoke's `tools.allow` + restart.

---

## 10. Shared bundles vs shared spokes (modularization guidance)

Support bots heavily duplicate shared capabilities — `gh-tools.ts` is copy-pasted across **7**
extensions (already drifting: 401 vs 223 lines), `comfort.ts` ×6, `zoom-dm.ts` ×5, `correlation` ×4,
`devtools` ×3. Two different reuse units solve two different problems — don't conflate them:

| | **Shared bundle** (shared *code*) | **Shared spoke** (shared *agent*) |
|---|---|---|
| What | one `registerGithubTools(api,{prefix})` imported by all bots | a `github` agent the coordinator spawns |
| Per-call cost | zero (in-process, direct) | a full spawn round-trip (latency + tokens) |
| Reduces coordinator menu | no | yes |
| Best for | **frequent, distinct** shared tools (GH, devtools) | **infrequent, large/confusable** shared clusters |

- Fix duplication with a **shared bundle** (prefix-parameterized so `bh_gh_*` / `gh_*` /
  `scopely_gh_*` still work). This is the plug-and-play win at the *code* layer; no spawn cost.
- Promote a shared capability to a **shared spoke** only when a bot is *both* demonstrably overloaded
  *and* uses that capability infrequently enough to absorb the spawn. The bundle is the prerequisite
  either way (a shared spoke also needs one implementation).
- Deciding factor per capability: **frequency × confusability.** Frequent+distinct → bundle.
  Infrequent+large/confusable → spoke.

---

## 11. Templates

### Coordinator `IDENTITY.md` (router)
```markdown
# IDENTITY.md — <Bot> Coordinator
- Role: router for <product> administration in this channel. You are a ROUTER, not a doer.
- You own NO domain tools (only liveness checks). For every real request, classify into ONE
  domain and delegate to that domain's spoke.

## Never answer from memory — always route, never ask
History/notes/memory may be stale. Never answer a domain question from recall/`read`/`memory_*`/
assumption. For ANY domain question, immediately spawn the relevant spoke and relay its fresh result.
Do not ask permission ("would you like me to…"); just spawn and answer.

## How to delegate
1. Pick the single best spoke from the routing table.
2. sessions_spawn(runtime="subagent", agentId="<spoke>", task="<full restatement incl. every
   id/name/value the spoke needs — it cannot see the channel or history>").
3. On the SPAWN turn, reply exactly `NO_REPLY` (no summary/preview).
4. Wait — the spoke's result is auto-delivered back (push-based). Do NOT poll.
5. On the result turn, relay the spoke's fresh result clearly.

## Routing table
| Spoke | Use when the request is about… |
|---|---|
| <spoke-a> | … |

## Confirm-gate (writes)
Writes are confirm-gated; the code is handled entirely by the system. A staging spoke returns
`awaiting_confirmation` and NO code (the system posts the `CONFIRM <code>` prompt directly). On that
turn reply `NO_REPLY`. Never write/invent/relay a `CONFIRM <code>` line. If a message is just
`CONFIRM <code>`, reply `NO_REPLY`.
```

### Spoke `IDENTITY.md` (worker)
```markdown
# IDENTITY.md — <Bot> <Domain> Specialist
- You run only your domain's tools and return the result to your coordinator.
- You NEVER address the channel directly; the coordinator owns all user-facing replies.
- Writes are confirm-gated: stage via the write tool (which posts the CONFIRM prompt) and return its
  result. Never execute a mutation directly; never fabricate a code.
- If you lack a tool to answer, say so plainly — do not guess ids or approximate from proxy data.
```

---

## 12. Quick-start checklist
1. **Measure** the candidate bot with the harness; confirm real confusable-domain misrouting (§2).
2. Make the bot's tools `optional: true` (§3).
3. Partition tools into domain spokes by the **routing noun**, full CRUD per spoke (§6).
4. Add spoke agents (`agents.list[]`, exclusive `tools.allow`, worker `IDENTITY.md`) (§5a).
5. Make the coordinator router-only (`tools.allow` = routing only; `subagents.allowAgents`; router
   `IDENTITY.md`) — **remove all general tools** (§5b).
6. Confirm-gate writes through one `stageWrite` chokepoint + `before_dispatch` execution (§7).
7. Add the bot to `plugins.entries`; bind the coordinator to the channel (§5c–d).
8. Deploy (restart; don't wipe jiti) (§9).
9. Validate with the harness: routing, in-thread, confirm-gate, safety guard — zero channel writes (§8).
10. If the bot also duplicates shared tools, consolidate into shared **bundles** (§10).

---

## 13. Failure modes we actually hit (and the fix)
- **Coordinator answers from memory instead of routing** → it still had general tools. Remove them (§5b).
- **Weak coordinator fabricates/relays confirm codes** → deterministic confirm delivery; code never
  through the LLM (§7).
- **Read request stages a write** (model fixates on recent write history) → context contamination;
  clear with a session `/reset`; the harness safety-guard assertion catches it (§8). Root cause is the
  weak model + co-located read/write tools — a reason to keep spokes small and consider splitting
  destructive tools out.
- **Bot "hung" / no model request after tool-policy** → bloated coordinator session (context-build
  stalls). Reset the session: `docker exec openclaw node dist/entry.js agent --session-key
  '<key>' --message '/reset'` (CLI times out on teardown but the reset completes server-side).
- **Extension silently not loaded** → missing from `plugins.entries` (§5c).
- **Self-inflicted ~70s stall + memory spike** → someone wiped `/tmp/jiti/*`. Don't (§9).
- **Spoke can't answer an in-domain question** → a needed lookup/read tool lives in another spoke;
  re-partition by domain noun, not action class (§6).

---

## 14. References
- As-built record: `scopelybot-hub-spoke-recommendation.md`
- Confirm-gate detail: `scopelybot-confirm-gate-fidelity.md`
- Partitioning problem: `scopelybot-spoke-partitioning-problem.md`
- Test harness: `agent-test-harness-design.md`
- Source anchors: `src/plugins/tools.ts` (scoping ~828–845, `isOptionalToolAllowed` ~277),
  `src/auto-reply/reply/dispatch-from-config.ts` (`before_dispatch` ~2082, `message_received` ~1893),
  `src/plugins/hook-types.ts` (`PluginHookToolContext` ~501), `extensions/scopelybot/` (reference impl).
