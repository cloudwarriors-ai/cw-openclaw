<!--
  Produced for the 2026-07-20 platform decision: whether CloudWarriors should keep
  investing in OpenClaw or evaluate "Hermes" as an alternative agent-gateway platform
  for the Zoom Team Chat admin-bot fleet (scopelybot et al.). Grounded per the
  deep-research skill — every load-bearing claim is tagged (curl)/[snippet]/[UNVERIFIED].
-->

# Hermes Agent vs. OpenClaw — grounded comparison for the Zoom Team Chat bot fleet

## Spine (the answer, up front)

"Hermes" is real and specific: **`hermes-agent`, built by Nous Research** (the org
behind the Nous/Hermes model fine-tunes), MIT-licensed, Python, actively released
roughly every 1-3 weeks. It is not vaporware and not a different-category product —
it is a direct architectural sibling to OpenClaw: a personal/team AI-agent runtime
with a CLI, a messaging gateway, a plugin/hook system, cron, skills, and memory. The
two projects already know about each other — OpenClaw ships a bundled Hermes migration
importer credited to `@NousResearch`, and Hermes ships an OpenClaw migration importer
in the other direction `(curl)`.

For CloudWarriors' specific decision, three grounded facts dominate everything else:

1. **Hermes has no Zoom or Zoom Team Chat connector**, native or documented, anywhere
   in its 20+-platform gateway `(curl)`. Neither does upstream OpenClaw — CloudWarriors'
   Zoom Team Chat channel is a bespoke 11,462-line in-house extension the team already
   built (repo-internal, `docs/reference/cw-fork-map.md:57`). Moving to Hermes does not
   inherit Zoom support; it means rebuilding that 11.4K-LOC connector a second time, in
   Python, on an unfamiliar plugin substrate.
2. **Neither platform's migration tooling ports custom extension code.** Both Hermes→OpenClaw
   and OpenClaw→Hermes importers move config, memories, skills-as-markdown, and
   allowlisted credentials — never hand-written plugin/extension logic `(curl)` +
   repo-internal. CloudWarriors' ~24 TypeScript OpenClaw extensions (Zoom included) do
   not carry over to Hermes's Python plugin system by any documented path.
3. **Neither platform ships a built-in response-verification/supervisor feature today.**
   Both expose raw hook primitives a plugin author could build one on top of. Read
   carefully, OpenClaw's own `before_agent_finalize` hook (general-purpose "ask for one
   more model pass before finalizing," with bounded `idempotencyKey`/`maxAttempts` retry
   metadata) is a _more_ general-purpose starting point for the supervisor Doug wants to
   build than Hermes's closest equivalent, which is scoped specifically to code-edit
   turns (repo-internal `(curl)`-equivalent Read of `docs/plugins/hooks.md`, vs. fetched
   Hermes hooks doc).

Recommendation implied by the above (inference, not a fetched fact): Hermes is a
legitimate, well-resourced, fast-moving project worth tracking, but it is not a
credible near-term replacement for OpenClaw as CloudWarriors' Zoom Team Chat bot
gateway — the Zoom connector and the 24-extension fleet are the whole investment, and
neither transfers. If the goal is the Aug 1 supervisor/verification feature, building
it on OpenClaw's existing `before_agent_finalize`/`reply_payload_sending` hooks is the
shorter path than a platform migration Hermes cannot shortcut.

---

## 1. Disambiguation — which "Hermes" is this

- `NousResearch/hermes-agent` — "The self-improving AI agent built by Nous Research,"
  MIT license, primary language Python, repo created 2025-07-22, last pushed
  2026-07-20 (today) `(curl` via GitHub API `)`.
- Confirmed as the correct candidate two independent ways:
  - OpenClaw's own `CHANGELOG.md:4473` (repo-internal, Read-verified): _"CLI/migration:
    add `openclaw migrate` with plan, dry-run, JSON, pre-migration backup, onboarding
    detection, archive-only report copies, and a bundled Hermes importer for
    configuration, memory/plugin hints, model providers, MCP servers, skills, and
    supported credentials. Thanks @NousResearch."_ — `@NousResearch` is the exact GitHub
    org handle.
  - The `hermes-agent` GitHub repo's own `topics` field lists: `clawdbot`, `moltbot`,
    `openclaw` alongside `hermes`, `hermes-agent`, `nous-research` `(curl` API `)` — the
    project explicitly tags itself against OpenClaw's current and former names.
- Other Hermes-branded Nous Research repos exist and are relevant context, not
  separate candidates: `hermes-example-plugins`, `hermes-paperclip-adapter`
  ("run Hermes as a managed employee in a Paperclip company"), `hermes-telegram-business`
  ("Observe-with-approval Telegram Business Mode — every drafted reply requires owner
  approval before it reaches the customer"), `hermes-agent-self-evolution`,
  `hermes-compression-eval` `(curl` API org listing `)`. These are plugins/companions to
  `hermes-agent`, not alternative gateways.
- Ruled out: no separate "Hermes" agent-gateway project surfaced anywhere in this
  research distinct from the NousResearch one. The well-known "Nous Hermes" _model_
  fine-tune family (`Hermes-Function-Calling`, etc., also in the same org) is a
  different product category (LLM weights, not a gateway) and is not the candidate
  here `(curl` — same org listing shows it as a separate repo `)`.

**Verdict: unambiguous, single credible candidate — `hermes-agent`.**

---

## 2. Architecture: routing, sessions, plugin hooks

### Hermes Agent

- Single-agent core (`AIAgent` in `run_agent.py`) is "platform-agnostic core... One
  AIAgent class serves CLI, gateway, ACP, batch, and API server. Platform differences
  live in the entry point, not the agent" `(curl,` architecture doc `)`. This is not a
  hub-and-spoke router in the sense of routing chat messages to different specialist
  agent personalities by default — each gateway channel dispatches to the same agent
  loop.
- Two distinct multi-agent primitives, not one:
  - `delegate_task` — in-process subagent, RPC-style (fork→join), anonymous, blocks
    the parent until the child returns, no resumability `(curl,` Kanban doc's
    comparison table `)`.
  - **Kanban** — a durable, SQLite-backed task board (`~/.hermes/kanban.db`) shared
    across named agent _profiles_ (each a full OS process with persistent identity/
    memory). Fire-and-forget, peer coordination (any profile reads/writes any task),
    human-in-the-loop via comment/unblock, crash-and-reclaim `(curl)`. This is
    architecturally a work-queue/task-board pattern (closer to a lightweight
    Jira-for-agents), not a chat-message hub-and-spoke router that decides which
    specialist agent should answer an incoming message.
- Plugin hooks (`ctx.register_hook()` in `plugins.py` — "PluginManager — discovery,
  loading, hooks") — three systems total: gateway hooks (drop-in `HOOK.yaml` +
  `handler.py`, observe-only), plugin hooks (`ctx.register_hook`, can block/rewrite),
  shell hooks (config-driven scripts) `(curl,` Event Hooks doc `)`.
- The **`pre_gateway_dispatch`** hook is the direct answer to "can a plugin intercept a
  message before dispatch, claim/suppress it": _"Gateway received a user message,
  before auth + dispatch → Returns `{"action": "skip" | "rewrite" | "allow", ...}` to
  influence flow"_ `(curl,` Event Hooks doc, "Quick reference" table `)`. Yes — Hermes
  has this capability.
- Other decision-capable hooks: `pre_tool_call` (block a tool call with a message),
  `pre_llm_call` (inject context), `pre_verify` (scoped to "when the agent edited
  code, before it verifies/finishes" — not general-purpose), `transform_tool_result`,
  `transform_terminal_output`, `transform_llm_output` (rewrite the final response
  text before delivery) `(curl)`. All other hooks are fire-and-forget observers.

### OpenClaw (repo-internal, `docs/plugins/hooks.md`, Read-verified)

- Explicitly documented hub-and-spoke pattern exists as first-class OpenClaw
  architecture (per the repo's own `docs/reference/hub-and-spoke-implementation-guide.md`
  and `hub-spoke-pattern-playbook.md`) — not independently re-verified in this pass
  since it is the platform CloudWarriors already knows; noted for contrast only.
- Hook catalog is materially larger and more typed than Hermes's: agent-turn hooks
  (`before_model_resolve`, `before_agent_run`, `before_agent_reply`,
  `before_agent_finalize`), tool hooks (`before_tool_call` with typed
  `requireApproval` objects — title/description/severity/timeoutMs/timeoutBehavior/
  allowedDecisions), message/delivery hooks (`inbound_claim`, `message_received`,
  `message_sending`, `reply_payload_sending`, `message_sent`, `before_dispatch`,
  `reply_dispatch`), session/subagent/lifecycle hooks.
- The direct equivalent of Hermes's `pre_gateway_dispatch` is **`inbound_claim`**:
  _"claim an inbound message before agent routing (synthetic replies)"_ — same
  capability, present on both platforms.
- OpenClaw hooks carry explicit priority ordering, per-hook timeout budgets
  (`timeoutMs`, operator-overridable per hook name), and a documented deprecation
  policy with a migration guide (`Plugin SDK migration`) — a materially more mature
  plugin-contract surface than Hermes's shorter "Quick reference" table with a
  `**kwargs` forward-compatibility convention.

**Comparison verdict:** both platforms have the requested claim/suppress-before-dispatch
capability. OpenClaw's hook surface is broader, more typed, and more operationally
mature (priority, timeouts, deprecation policy). Hermes's differentiator is Kanban —
a genuinely different multi-agent _task-queue_ primitive OpenClaw does not have an
equivalent for, but it solves a different problem (durable cross-agent work handoff)
than "route this chat message to the right bot."

---

## 3. Chat connectors: Zoom Team Chat, and posting as a real user

This is the decisive dimension for CloudWarriors.

- Hermes's own README platform table: _"Lives where you do: Telegram, Discord, Slack,
  WhatsApp, Signal, and CLI — all from a single gateway process."_ `(curl)`
- The full messaging-gateway doc lists every supported adapter in a platform-comparison
  table: **Telegram, Discord, Slack, Google Chat, WhatsApp, Signal, SMS, Email, Home
  Assistant, Mattermost, Matrix, DingTalk, Feishu/Lark, WeCom, WeCom Callback, Weixin,
  BlueBubbles (iMessage), QQ, Yuanbao, Microsoft Teams, LINE, ntfy, Raft, IRC.**
  **Zoom does not appear anywhere in this list** `(curl,` messaging doc, full text
  extracted and searched `)`.
- The architecture doc's directory listing independently confirms 20 platform adapter
  modules under `gateway/platforms/` — again, no `zoom` module `(curl)`.
- Grepped explicitly for "zoom" across every fetched Hermes doc page: zero matches.
- On OpenClaw's side, the same absence is true upstream: OpenClaw's public
  `docs/channels/` directory lists ~38 channel docs (Discord, Slack, Feishu, Google
  Chat, iMessage, IRC, LINE, Matrix, Mattermost, Microsoft Teams, Nextcloud Talk,
  Nostr, QQ, Signal, SMS, Synology Chat, Telegram, Tlon, Twitch, WeChat, WhatsApp,
  Yuanbao, Zalo...) and **no `zoom.md`** (repo-internal, directory listing).
- CloudWarriors' Zoom Team Chat integration is confirmed, repo-internal, as an
  in-house-built OpenClaw extension: `docs/reference/cw-fork-map.md:57` — _"**zoom**
  | 11,462 [LOC] | 13 [files] | The flagship: Zoom Team Chat channel plugin. Webhook
  intake, LLM prefilter gate (`ZOOM*PREFILTER*_`), agent routing, threading/thread-state,
conversation store, channel memory, monitor mode, trained answers, answer scrubbing,
file upload handler + upload pages, docx tools, send-as-user, action cards, user
directory, subagent completion hooks. Tools: `zoom_send_dm/\_to_channel/\_at_message/
  \_as_user`, `zoom_send_action_card`, `zoom_lookup_user`, `zoom_request_file_upload`,
`zoom_get/set_prefilter_config`, `docx_read/\_replace/\_get_download`"* — and line 9:
*"Upstream has deleted/renamed ~70 extensions that existed at our fork point —
including its `zoom`plugin (ours is an independent 11.4K-LOC implementation,
unaffected)."* This also confirms`send-as-user`(posting as a real Zoom user
account) is part of that bespoke build, plus a separate 2,229-LOC`catfish`
  extension described as "Privileged Zoom impersonation sender for admin workflows."

**Comparison verdict:** neither platform ships Zoom Team Chat support out of the box.
CloudWarriors' Zoom integration on OpenClaw is not a stock feature being "given up" by
staying — it is a large sunk investment that would need to be rebuilt from scratch on
Hermes, in Python, against an unfamiliar plugin API (`ctx.register_hook`,
`pre_gateway_dispatch`, `transform_llm_output`) with no prior art to port from.

**Bot-vs-real-user posting on Hermes generally:** [UNVERIFIED]. The fetched
messaging-gateway overview page does not describe per-platform auth mechanics (bot
token vs. personated account); that detail likely lives on per-platform setup pages
not fetched in this pass. Not load-bearing given the Zoom-absence finding above, so not
chased further under the research budget.

---

## 4. Safety / write-gating primitives

### Hermes (`(curl,` Security doc `)`

Eight-layer defense-in-depth model, explicitly enumerated: user authorization
(allowlists, DM pairing), dangerous-command approval (human-in-the-loop), file write
safety (denylist + optional write sandbox for `write_file`/`patch`), container
isolation (Docker/Singularity/Modal), MCP credential filtering, context-file scanning
(prompt-injection detection), cross-session isolation, input sanitization.

- Approval modes: `smart` (auxiliary LLM risk-assesses, auto-approves low-risk,
  auto-denies clearly dangerous, escalates uncertain cases), `manual` (always prompt),
  `off` (equivalent to `--yolo`).
- `cron_mode: deny|approve` — controls whether headless cron runs treat a dangerous
  command as blocked or auto-approved.
- Three-option approval dialog (Approve Once / Always Approve / Cancel) routed through
  native yes/no buttons on Telegram, Discord, and Slack.
- **Hardline blocklist** — a floor below `--yolo` that cannot be bypassed by any
  setting, including `--yolo`, `approvals.mode: off`, cron auto-approve, or "always
  approve" — for catastrophic operations (irreversible filesystem wipes, fork bombs,
  direct block-device writes).
- Delivery reliability: a durable delivery ledger in `state.db` gives at-least-once
  redelivery semantics on gateway crash mid-send, with an honest "may be a duplicate"
  label rather than silent resend; bounded to 3 attempts / 24-hour freshness.

### OpenClaw (repo-internal comparandum, not independently re-verified this pass —

CloudWarriors already operates this system; see `docs/reference/
scopelybot-confirm-gate-fidelity.md` for the existing confirm-gate design)

**Comparison verdict:** Hermes's write-gating is real, specific, and reasonably mature
— the `smart` mode's LLM-risk-triage plus a non-bypassable hardline blocklist is a
genuinely distinct design choice worth noting. It is a comparable _category_ of
protection to what a confirm-gate system provides, but this research did not
re-verify OpenClaw's own confirm-gate depth against it line-by-line; that comparison
should be done directly against `scopelybot-confirm-gate-fidelity.md` rather than
assumed here.

---

## 5. Supervision hooks (the feature Doug wants to build next)

Neither platform ships a complete built-in "verify the agent's response before
sending, retry if it's bad" supervisor feature as a product. Both expose primitives:

**Hermes:**

- `pre_verify` — "Once per turn **when the agent edited code**, before it
  verifies/finishes" → `{"action": "continue", "message": str}`. Explicitly scoped to
  code-edit turns, not general chat replies `(curl)`.
- `transform_llm_output` — "After the tool-calling loop completes, before the final
  response is delivered" → returns a replacement string or `None`. Blunt: it can
  rewrite the outgoing text but the hook contract shown carries no retry/re-generate
  semantics (no bounded-attempts metadata) `(curl)`.
- Transport-level **circuit breaker**: each gateway platform adapter is individually
  wrapped in a circuit breaker that auto-pauses on repeated retryable failures
  (network blips, rate limits, 5xx, websocket disconnects), sends an operator
  notification to another live platform's home channel, and requires manual
  `/platform resume <name>` — it does not auto-resume by design `(curl,` messaging doc
  `)`. This is connection reliability, not response-quality supervision — a distinct
  concept from what Doug is describing, but a genuinely well-built piece of
  infrastructure worth noting on its own.
- Grepped OpenClaw's docs tree for "circuit breaker": one unrelated hit in
  `docs/concepts/active-memory.md`. No adapter-level circuit breaker appears to be
  documented for OpenClaw's channel adapters (repo-internal grep, absence is
  suggestive, not proof of non-existence).

**OpenClaw** (repo-internal, `docs/plugins/hooks.md`):

- `before_agent_finalize` — _"runs only when a harness is about to accept a natural
  final assistant answer... Return `{ action: "revise", reason }` to ask the harness
  for one more model pass before finalization... plugins can include `retry` metadata
  to make the extra model pass bounded and replay-safe"_ with a typed
  `{ instruction, idempotencyKey?, maxAttempts? }` shape. This is general-purpose
  (any final answer, not just code edits) and has built-in bounded-retry semantics —
  strictly more capable as a supervisor foundation than Hermes's `pre_verify` +
  `transform_llm_output` combination.
- `reply_payload_sending` / `message_sending` give a second, independent seam to
  intercept and cancel or rewrite outbound content immediately before channel
  delivery.

**Comparison verdict:** for the specific feature Doug wants to build, OpenClaw's
existing hook surface is a stronger substrate than Hermes's, not a weaker one. Hermes's
one genuine edge here is the shipped transport-level circuit breaker per adapter,
which OpenClaw does not appear to document an equivalent for — worth importing as an
idea regardless of the platform decision.

---

## 6. Maturity: releases, maintainers, community, production evidence

`(curl,` GitHub REST API — repo metadata, releases, contributors `)`:

- Created 2025-07-22 (~1 year old as of 2026-07-20). Default branch `main`. Not
  archived. Last push: today.
- License: MIT.
- **217,640 stargazers, 41,028 forks, 24,019 open issues** (raw API values as
  fetched). This is an extraordinary scale for a ~1-year-old CLI agent project — larger
  than most mainstream, long-established open-source projects. Flagging this
  explicitly rather than treating it as face-value proof of organic production
  adoption: it is what the GitHub API returned at fetch time, but a number this large
  this fast warrants independent sanity-checking (e.g., cross-referencing against
  GitHub's own trending/star-history tooling) before using it as a maturity argument
  in a decision doc. **`[UNVERIFIED — magnitude plausibility]`**, everything else about
  the repo (existence, license, activity, docs) is independently `(curl)`-confirmed.
- Release cadence (last 5 tags): `v2026.6.5` (Jun 6) → `v2026.6.19` (Jun 19) →
  `v2026.7.1` (Jul 1, "The Judgment Release") → `v2026.7.7` (Jul 8) → `v2026.7.7.2`
  (Jul 8). Roughly every 1-2 weeks, consistent, no long gaps `(curl)`.
- Contributor count: GitHub API pagination on `/contributors?per_page=1&anon=true`
  reports a `last` page of 2096, implying roughly that many distinct
  contributors-or-anonymous-commit-authors. `anon=true` inflates this relative to
  named/verified contributors, so treat as an upper-bound signal, not a precise count
  `[snippet-tier — Link-header pagination inference, not a direct count]`.
- Backed by Nous Research, a known, funded AI research organization (also behind the
  Nous/Hermes model fine-tunes, Forge API, DisTrO, Atropos RL framework, and dozens of
  other active repos in the same GitHub org) `(curl,` org repo listing `)`.
- Production usage evidence specific to CloudWarriors' use case (chat-platform ops
  bots at scale) was not found or searched for beyond the plugin ecosystem signals
  already covered in §1 (e.g., `hermes-telegram-business`'s "every drafted reply
  requires owner approval" framing implies at least one real deployed
  observe-with-approval chat-bot pattern in the wild) `[snippet]`.

---

## 7. Migration cost from the OpenClaw extension fleet (~24 TypeScript extensions)

- **Language mismatch is the headline fact.** `hermes-agent`'s GitHub-reported primary
  language is Python `(curl)`. Its plugin system is Python-native
  (`ctx.register_hook()`, `plugin.yaml` manifests, `provides_tools`/`provides_hooks`
  fields) `(curl,` Plugin Guide doc `)`. OpenClaw's extensions, including CloudWarriors'
  fleet, are TypeScript (repo-internal — the `migrate-hermes` extension itself, and
  every file under `extensions/`, is TypeScript). There is no automatic
  transpilation path between the two; a port is a rewrite.
- **Bidirectional migration tooling exists but explicitly does not move plugin code:**
  - OpenClaw → imports FROM Hermes: model config, MCP server definitions, `SOUL.md`/
    `AGENTS.md`, memory files (appended), skills with a `SKILL.md`, and — separately —
    archives (copies for manual review only, never loads) Hermes's `plugins/`,
    `sessions/`, `logs/`, `cron/`, `mcp-tokens/`, `state.db` (repo-internal,
    `docs/install/migrating-hermes.md`, Read-verified).
  - Hermes → imports FROM OpenClaw (`hermes claw migrate`): `SOUL.md`, memories
    (`MEMORY.md`/`USER.md`), user-created skills (copied to
    `~/.hermes/skills/openclaw-imports/`), command allowlist/approval patterns,
    messaging settings (platform configs, allowed users, working directory),
    allowlisted API keys, TTS assets, `AGENTS.md` `(curl,` README §"Migrating from
    OpenClaw" `)`. No mention anywhere of importing OpenClaw's `extensions/`/plugin
    directory.
  - Net: **in both directions, hand-written extension/plugin logic is archive-only or
    entirely absent from the migration scope.** Config, prompts, memory, and
    credentials move; code does not.
- Concretely for CloudWarriors: migrating means re-authoring ~24 TypeScript extensions
  as Python `plugin.yaml` + `ctx.register_hook()` plugins, including rebuilding the
  11.4K-LOC Zoom Team Chat connector (webhook intake, prefilter gate, threading,
  channel memory, file uploads, docx tools, send-as-user, action cards) from scratch
  against Hermes's `gateway/platforms/` adapter pattern, which has no existing Zoom
  adapter to extend or reference (repo-internal + `(curl)` combined, see §3).

---

## Sources

| URL                                                                                                                                  | Tier                     | What it grounded                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://github.com/NousResearch/hermes-agent (README fetched via raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md) | (curl)                   | Identity, feature summary, install, CLI/messaging reference, migration-from-OpenClaw section                                                                                                                     |
| https://api.github.com/repos/NousResearch/hermes-agent                                                                               | (curl, API)              | Repo metadata: language, license, stars/forks/issues, created/pushed dates, topics                                                                                                                               |
| https://api.github.com/repos/NousResearch/hermes-agent/releases                                                                      | (curl, API)              | Release cadence, version scheme                                                                                                                                                                                  |
| https://api.github.com/orgs/NousResearch/repos                                                                                       | (curl, API)              | Confirmed `hermes-agent` exists; found related Hermes-branded repos; confirmed Nous Research's broader active portfolio                                                                                          |
| https://hermes-agent.nousresearch.com/docs/user-guide/messaging                                                                      | (curl)                   | Full platform-adapter list (no Zoom), architecture ("routes through session store, dispatches to AIAgent"), intentional silence tokens, delivery reliability, per-adapter circuit breaker, restart notifications |
| https://hermes-agent.nousresearch.com/docs/user-guide/security                                                                       | (curl)                   | Eight-layer security model, approval modes, YOLO mode, hardline blocklist                                                                                                                                        |
| https://hermes-agent.nousresearch.com/docs/developer-guide/architecture                                                              | (curl)                   | System diagram, directory structure (`gateway/hooks.py`, `gateway/platforms/` with 20 adapters), plugin system summary, design principles                                                                        |
| https://hermes-agent.nousresearch.com/docs/developer-guide/plugins                                                                   | (curl)                   | Plugin manifest format, `provides_hooks`, pluggable-interfaces map, third-party plugin distribution policy                                                                                                       |
| https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks                                                                 | (curl)                   | Three hook systems, full hook quick-reference table incl. `pre_gateway_dispatch`, `pre_tool_call`, `transform_llm_output`, `pre_verify`                                                                          |
| https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban                                                                | (curl)                   | Kanban multi-agent task-board architecture, comparison table vs. `delegate_task`                                                                                                                                 |
| `/Users/chadsimon/chad_work/moltbot/CHANGELOG.md` (lines 268, 4473, 8256)                                                            | repo-internal, Read      | `@NousResearch` credit confirming Hermes identity; migration feature history                                                                                                                                     |
| `/Users/chadsimon/chad_work/moltbot/docs/install/migrating-hermes.md`                                                                | repo-internal, Read      | What OpenClaw imports from Hermes and what stays archive-only                                                                                                                                                    |
| `/Users/chadsimon/chad_work/moltbot/docs/plugins/reference/migrate-hermes.md`                                                        | repo-internal, Read      | migrate-hermes plugin distribution/surface                                                                                                                                                                       |
| `/Users/chadsimon/chad_work/moltbot/extensions/migrate-hermes/source.ts`, `config.ts`                                                | repo-internal, Read      | Exact Hermes on-disk config shape (`~/.hermes`, `config.yaml`, archive dirs) OpenClaw's importer expects                                                                                                         |
| `/Users/chadsimon/chad_work/moltbot/docs/plugins/hooks.md`                                                                           | repo-internal, Read      | OpenClaw's own hook catalog for architecture/supervision comparison                                                                                                                                              |
| `/Users/chadsimon/chad_work/moltbot/docs/reference/cw-fork-map.md` (lines 9, 57, 58)                                                 | repo-internal, Read      | CloudWarriors' 11.4K-LOC bespoke Zoom Team Chat extension; confirms upstream OpenClaw has no stock Zoom plugin either                                                                                            |
| `/Users/chadsimon/chad_work/moltbot/docs/channels/` (directory listing)                                                              | repo-internal, Bash `ls` | Confirms no `zoom.md` in OpenClaw's stock channel docs                                                                                                                                                           |

## Unverified / weak

- Hermes per-platform authentication mechanics (bot API token vs. personated real-user
  account) for Slack/Teams/etc. — not found in the fetched overview doc; would need
  per-platform setup pages not pulled in this pass. `[UNVERIFIED]`
- The magnitude of Hermes's GitHub star/fork/issue counts (217,640 / 41,028 / 24,019)
  is taken directly from the API response but is anomalously large for a ~1-year-old
  project; flagged for independent sanity-check rather than used as an unqualified
  maturity signal. `[UNVERIFIED — plausibility]`
- Contributor count (~2096) is inferred from GitHub API Link-header pagination with
  `anon=true`, not a direct verified count. `[snippet-tier]`
- `hermes-telegram-business` and `hermes-paperclip-adapter` were identified and their
  one-line GitHub descriptions read, but their full READMEs were not fetched — the
  "approval-gated secretary bot" and "managed employee" framings are taken from the
  repo description field only, not the full plugin documentation. `[snippet]`
- `docs/hermes-kanban-v1-spec.pdf` (referenced in the Kanban doc as containing a
  comparative analysis against "Cline Kanban / Paperclip / NanoClaw / Google Gemini
  Enterprise" and the "eight canonical collaboration patterns") was not fetched.
  `[UNVERIFIED]`
- OpenClaw's own confirm-gate depth (`docs/reference/scopelybot-confirm-gate-fidelity.md`)
  was not re-read in this pass and not compared line-by-line against Hermes's approval
  system; §4's OpenClaw side is asserted by reference, not independently re-verified
  here. `[UNVERIFIED — deferred to existing doc]`
- Real-world production usage of `hermes-agent` for anything resembling CloudWarriors'
  use case (multi-tenant ops chat bots) was not independently found; only the
  `hermes-telegram-business` plugin description hints at a similar pattern.
  `[UNVERIFIED]`
