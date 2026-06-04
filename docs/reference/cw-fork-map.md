# cw-openclaw Fork Map — CW Additions to OpenClaw

Generated 2026-06-04 against branch `development` @ `8809735`.
Fork point: upstream commit `67da67b61a` (~v2026.2.26). `development` is **66 commits ahead** of the fork point: **~38K LOC added** across extensions, core, apps, packages, scripts, and skills.

## Upstream divergence (snapshot 2026-06-04)

- Fork point date: **2026-03-18**. Upstream `main` (`fc7f96c826`, 2026-06-04) is **36,767 commits ahead** (~480 commits/day).
- Upstream has deleted/renamed ~70 extensions that existed at our fork point — including its `zoom` plugin (ours is an independent 11.4K-LOC implementation, unaffected).
- **Memory engine relocation** (`cad83db8b2`, 2026-03-26 — 8 days after our fork point): the 103-file `src/memory/` subsystem moved wholesale into `extensions/memory-core/src/memory/`; `src/memory/` now holds one file. Memory is now a plugin *kind* (`"kind": "memory"`) with a declared contract (`tools: memory_get, memory_search`; pluggable embedding providers). Engines on the slot: memory-core (default, + dreaming/concept-vocabulary/budgets), memory-lancedb, memory-wiki, active-memory; provider extensions ship `memory-embedding-adapter.ts`.
- Port implications: our 4 patched memory files exist upstream at the new path — re-apply ~120 diff lines to moved files. Our `memory-pgvector` already implements the exact contract tool pair (`memory_get`/`memory_search`) and would slot in as a memory-kind plugin.
- Re-sync cost assessment: the only true merge surface is the **19 CW-modified core files (+719 LOC)**; all other CW work is additive directories upstream never touches. A re-sync would be a port (core patches + extension tree onto a fresh snapshot, then fix against the current plugin SDK API), not a rebase. Staying pinned at the 2026-03-18 base is the cheaper position unless a specific upstream capability is needed.

Deployed as the `openclaw` container on noob-root (`/root/web/moltbot`), live at `molty-dev.cloudwarriors.ai`. `./src` and `./extensions` are volume-mounted into the running container.

## 1. Directory tree (curated)

```
cw-openclaw/
├── src/                     # OpenClaw core (upstream + 19 CW-modified files, see §4)
│   ├── agents/              #   agent runtime, tools, pi-embedded-runner
│   ├── auto-reply/          #   reply pipeline (CW: media-only replies, templating)
│   ├── config/              #   config + session metadata
│   ├── gateway/             #   ws/http gateway server
│   ├── memory/              #   memory managers (CW: scope resolution)
│   ├── plugin-sdk/          #   public plugin SDK surface (CW: +13 lines)
│   └── plugins/             #   plugin loader/registry/runtime
├── extensions/              # 93 plugins; 18 CW-built + 1 shared helper dir (see §2)
├── apps/
│   └── slm-dashboard/       # CW: standalone SLM pipeline dashboard (server + client)
├── packages/
│   └── memory-server/       # CW: SQL+vector memory HTTP server (pg/pgvector)
├── skills/                  # agent skills; CW added zw-new-order, zw-transcript-order
├── llm-skills/
│   └── deploy-bot/          # CW: bot deployment skill
├── scripts/                 # CW added ~32 files: zoom/agent test harnesses, slm-local, e2e
│   └── tests/               #   empire-e2e, csv/history ingest, report API tests
├── test/slm/                # CW: SLM e2e + playwright suites
├── docs/
│   ├── experiments/         # CW: SLM contracts + plans (issues 5/6, local staging)
│   └── reference/           # CW: hub-spoke playbook, scopelybot design docs
├── docker-compose.dev.yml   # CW: dev deployment (the one running on noob-root)
├── docker-compose.slm-local.yml  # CW: local SLM stack
├── .env-template            # CW: env contract for the dev deployment
├── .github/workflows/       # CW: slm-gates.yml, dev-image GHCR build
└── vitest.slm*.config.ts    # CW: SLM test configs
```

## 2. CW-built extensions (18 + shared)

Naming convention: each "bot" extension is a tool-pack for one customer/platform, prefixed tools (`bh_`, `pp_`, `zws_`, `cf_`, `scopely_`, `eoa_`…). The break/fix bots (bigheadbot, pulsebot, zoomwarriorssupportbot) share an identical shape: platform CRUD + GitHub issues + devtools (db/logs/files) + log correlation.

### Channel / messaging

| Extension | LOC | Tools | Purpose |
|---|---|---|---|
| **zoom** | 11,462 | 13 | The flagship: Zoom Team Chat channel plugin. Webhook intake, LLM prefilter gate (`ZOOM_PREFILTER_*`), agent routing, threading/thread-state, conversation store, channel memory, monitor mode, trained answers, answer scrubbing, file upload handler + upload pages, docx tools, send-as-user, action cards, user directory, subagent completion hooks. Tools: `zoom_send_dm/_to_channel/_at_message/_as_user`, `zoom_send_action_card`, `zoom_lookup_user`, `zoom_request_file_upload`, `zoom_get/set_prefilter_config`, `docx_read/_replace/_get_download` |
| **catfish** | 2,229 | 1 | Privileged Zoom impersonation sender for admin workflows (`catfish_send`) |
| **2fa-github** | 1,929 | 2 | GitHub Mobile 2FA gate for sensitive tool calls; OAuth callback flow (`manage_2fa_trust`) |

### Customer / platform bots (hub-and-spoke pattern — see docs/reference/hub-spoke-pattern-playbook.md)

| Extension | LOC | Tools | Purpose |
|---|---|---|---|
| **scopelybot** | 5,839 | 86 | Scopely VIP observability + break/fix + full admin CRUD (orgs, pricing, vendors, deployment types, scoping cards, users), passthrough alert runner, audit logs, error correlation. Router-only hub per as-built doc |
| **tesseract** | 1,996 | 26 | Tesseract ETL platform: company onboarding, Zoom Phone provisioning (sites, users, call queues, AR/IVR), ETL channel bindings, credential flows, platform API passthrough |
| **bigheadbot** | 1,770 | 25 | Bighead break/fix: project/task/ticket CRUD + GitHub issues + devtools + log correlation (`bh_*`) |
| **pulsebot** | 1,900 | 18 | Project Pulse break/fix, same shape (`pp_*`, `gh_*`) |
| **zoomwarriorssupportbot** | 1,554 | 25 | ZoomWarriors2 break/fix, same shape (`zws_*`) |
| **external-org-autopilot** | 1,464 | 23 | External org onboarding/sync/execution/reporting with locks, evidence, smoke tests (`eoa_*`) |
| **cloudflow-support** | 1,165 | 15 | CloudFlow support + ops API discovery/execution + deployments + GitHub issues (`cf_*`) |
| **zoomwarriors** | 387 | 5 | ZW2 presales quoting, read side (`zw2_get_order/_pricing/_sow_link`, search) |
| **zoomwarriors-write** | 380 | 6 | ZW2 write side: create orders, extractions, refresh pricing |
| **bighead** | 271 | 4 | Bighead AI avatar: join/leave meetings, analyze transcript, control Rebecca |

### Memory / infra

| Extension | LOC | Tools | Purpose |
|---|---|---|---|
| **claude-mem** | 7,176 | — | Bundled claude-mem integration (modes, ui, worker; entry at committed source) |
| **memory-pgvector** | 347 | 2 | Memory slot plugin backed by `packages/memory-server` (`memory_get`, `memory_search`); pairs with the `moltbot-pgvector` container |
| **devtools** | 250 | 7 | Docker container mgmt + codebase file browsing + db query against devtools-api (`devtools_*`) — base layer the break/fix bots wrap with prefixed variants |
| **shared** | 211 | — | Cross-extension helpers: channel-status-summary, config-schema-helpers, deferred, passive-monitor, runtime, status-issues |

### SLM training stack

| Extension | LOC | Tools | Purpose |
|---|---|---|---|
| **slm-pipeline** | 7,187 | (gateway methods + HTTP routes, not chat tools) | SLM training pipeline: QA ingest/extract/categorize, dataset builder, feedback merge, human eval, review events, training orchestrator, state store |
| **slm-supervisor** | 2,476 | (gateway methods + HTTP routes) | SLM-first answer orchestration: primary-answer, scoring, policy, command mode, trace store/exporter, training studio |

Supporting surfaces: `apps/slm-dashboard` (auth'd web dashboard over the gateway), `docker-compose.slm-local.yml`, `test/slm/` e2e + playwright suites, `vitest.slm*.config.ts`, `.github/workflows/slm-gates.yml`, contracts in `docs/experiments/contracts/` (openapi + definition-of-done).

## 3. CW-built packages & apps

- **packages/memory-server** (~15 files): standalone HTTP memory server — Postgres store + embeddings + auth, OpenAPI spec. Backend for `memory-pgvector` extension.
- **apps/slm-dashboard** (~20 files): Express-ish server (session cookies, password auth) + static client; talks to the gateway via `gateway-client.ts`.

## 4. Core `src/` modifications (19 files, +719/−29)

Deliberately small footprint — fork keeps core close to upstream, bulk of CW logic lives in extensions.

| Area | Files | What changed |
|---|---|---|
| Plugin SDK/runtime | `plugin-sdk/index.ts` (+13), `plugins/types.ts` (+5) | New SDK surface for extensions (small type/export additions) |
| Agents | `agents/pi-embedded-runner/run/tool-hook-wrapper.ts` (new, 78), `agents/tools/sessions-spawn-tool.ts` (+20/−x), `memory-tool.scope.test.ts` (new, 245) | Tool-call hook wrapper (the 2FA/gating hook point); subagent spawn changes (thread-delivery of subagent results) |
| Auto-reply | `auto-reply/reply/get-reply-run.ts` (+23), `queue/types.ts` (+5), `templating.ts` (+10), media-only test | Media-only reply handling, template additions |
| Memory | `memory/types.ts` (+47), `manager-search.ts` (+43), `qmd-manager.ts` (+27), `scope-resolution.test.ts` (new, 127), `search-manager.ts` | Memory scope resolution (per-channel/agent scoping) |
| Config | `config/sessions/metadata.ts` (+11) | Session metadata extension |
| Gateway | `openresponses-http.ts` (+4), `ws-connection/message-handler.ts` (+8) | Small hooks |

## 5. Other CW additions

- **skills/zw-new-order, skills/zw-transcript-order**: conversational order-capture skills for ZW2 (api-fields refs, capture templates, verification checklist).
- **llm-skills/deploy-bot**: SKILL.md for deploying new bots (234 lines).
- **scripts/**: `test-zoom-pulsebot.ts` (+scenarios), `test-agents-inference.ts`, `test-memory-search.py`, `slm-local/up.sh`, `scripts/tests/*` (empire-e2e, ingest/report API tests).
- **docs/reference/**: `hub-spoke-pattern-playbook.md`, `scopelybot-hub-spoke-design.md`, `scopelybot-hub-spoke-recommendation.md`.
- **docs/experiments/**: SLM control-plane OpenAPI, ids-tenancy contract, plans for issues 5/6, slm-local-staging.
- **Dockerfile**: rewritten (−214/+49) for the dev image; `.github/workflows` builds dev images on GHCR so deployment hosts stop building.

## 6. Known deltas not in git

The deployed checkout on noob-root carries ~18 uncommitted modified files (plugin loader/registry/runtime, channel-resolution, several extensions, compose + env) — in-flight devrelay integration dated 2026-06-04. Not present in this clone.
