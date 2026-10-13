# PK-7a: do not deploy without PK-7b-1, and the operator-layer preconditions

PK-7a (backend profile, guard, capability registry) must never ship alone. On its own:

- its audit rows go to the v1 `audit.jsonl`, which breaks the v1-freeze/epoch continuity;
- an allowed app request writes no HTTP audit row and sends no correlation header or parameter;
- an audit-write failure only reaches `console.error`.

PK-7b-1 resolves all three (details in `docs/audit-v2.md`):

- every row goes to the hash-chained `audit-v2.jsonl`; v1 is read once, for the epoch marker, and never written;
- every app request writes an `http_intent` row before it is sent and exactly one terminal row after, and carries `bot_audit_id` and `x-correlation-id`;
- if the intent row cannot be written, or the chain tail does not verify, the request is not sent.

## What changed with M13 slice 1 (operator-layer client)

The bot's app tools are now the slice-1 reads (`docs/ops-client.md`): `scopely_health_check`, `scopely_auth_status` (whoami) and ten catalog, pricing and session reads, each bound to one read capability of the operator layer and sent as `POST /api/spine/v1/ops/invoke/` with the bot's service token (`Authorization: Bearer zwops_...`), its audit id (`X-Ops-Bot-Audit-Id`) and the asking human's canonical Zoom user id (`X-Ops-Requester-Zoom-Id`, `IDENTITY-B-CONTRACT.md`). The request and answer shapes follow the kernel at zoomwarriors_2 `39140839`; its `capabilities.snapshot.json` is a test fixture that every tool binding is checked against. Everything else stays refused by the registry, and no write is live. This is pinned by capability-registry.test.ts, "only the slice-1 operator-layer reads and the local approver list run; no write is live", and the guard refuses any capability outside its read allow-list (scopely-api.ops-guard.test.ts).

The old M1a shape (one anonymous health GET to `/api/v1/health/`) is gone: under `authMode: "anonymous"` no app tool sends anything. M1a cannot be deployed from this code line; it deploys from the PK-7b-1 commit.

## Why attribution still holds, and what it now depends on

The app authorizes every invoke for the human named in `X-Ops-Requester` and audits it. The bot sends that header only for a call whose requester was resolved from the trusted tool-factory context (a human-triggered coordinator run), and whose sender is still the latest inbound sender of the run's session; the header is that sender's canonical Zoom user id, which the app maps through `ZoomIdentityLink.zoom_user_id`. A spoke, the coordinator's own subagent, an announce run, a run someone else has posted into, or an unknown sender sends no header, and the app answers whoami only. So a misrouted call is refused by the app, not attributed to the wrong person, provided:

1. The coordinator (`scopelybot`) has no `sessions_spawn`, and no agent that can spawn may target it, so no spoke or own-agent subagent runs the slice-1 tools under the coordinator's allow list. (A spoke would be refused by the app as `requester_unresolved`; its `http_intent` rows would still be `requester.resolved: false`, which fails the Q1 gate.)
2. No allow list other than the coordinator's lists any slice-1 tool, `scopelybot`, `group:plugins`, or a wildcard.
3. Zoom ids are filled in for the intended users: each person who should act through the bot has an active `ZoomIdentityLink` with `zoom_user_id` set (canonical form) to an active user. An unlinked asker is answered whoami-only, and their whoami answer shows the id to give an admin. The approver ledger and its email recording play no part in the requester claim any more (the display-name spoofing, 500-key cap, last-writer-wins re-pointing and module-level directory gaps of the email design no longer apply to ops).
4. Concurrent senders. The host's default queue mode is `steer` (`src/auto-reply/reply/queue/settings.ts`): a second person's message can be injected into a run that is still active, and that run's tool-factory sender stays the first person. The plugin now records the latest inbound sender per session in the `message_received` hook and makes no requester claim when the run's sender is not that latest sender, or when nothing was recorded for the session (after a restart, for example): those calls are answered whoami-only (fail closed). This relies on two host facts, read in source but not yet seen on the production image: `message_received` handlers run synchronously before the message is dispatched (`src/auto-reply/reply/dispatch-from-config.ts`, `fireAndForgetHook(runMessageReceived(...))` before `markProcessing()`; `src/plugins/hooks.ts` `runVoidHook` calls each handler inside `hooks.map`), and the hook's `sessionKey` equals the run's tool-factory `sessionKey` (probe S0 saw the same hub key for overlapping senders). If PK-8 shows either fails, set a non-steer queue mode for the channel (`messages.queue.byChannel.zoom: "followup"`, which applies to every Zoom agent on that gateway; amendment A3 kept prod's queue untouched, so this is an owner decision).
5. Org membership. The app maps `X-Ops-Requester-Zoom-Id` with `bot_actor_for`, which refuses a mapped user who is not a member of the service principal's organization. The bot's principal must therefore belong to the organization its users belong to: the platform org for staff reads (every account is auto-enrolled there).
6. Token kind. The token file must hold a SERVICE token (`ops_mint_token --principal <org-slug>/<principal name>`). The token shape cannot tell the kinds apart, and a person token (`--user`) acts as its owner whenever no header is sent, so every unlinked or drifted asker would become that person.

The backend profile's `digestEnabled` must also stay `false` (the default): the daily digest sends timer GETs with a `system` requester (anonymous; the token is sent only on the invoke).

### PK-9 acceptance check: `check_m1a_config.mjs`

The checker (built outside this repository) must pass against the deployed `openclaw.json` and the backend profile before any deploy. For slice 1 it needs the change in `docs/pk9-check-ops-slice1.patch`, which adds the flag `--ops-slice1`:

- check 3 expects the coordinator's allow list to be exactly `scopely_health_check` plus the eleven other slice-1 tools (`OPS_SLICE1_ALLOW` in the patch, the same names as `OPS_READS` in `src/capability-registry.ts`);
- check 2 evaluates every expected tool for every other agent (not only the health check), so a deny that blocks one slice-1 tool cannot hide another;
- check 8 expects `authMode: "service-token"`.

Run: `node check_m1a_config.mjs <openclaw.json|-> --channel-id <id> --profile <path> --ops-slice1`. Without the flag the checker keeps its M1a behavior. The six runtime facts it covers (effective allow = `allow` + `alsoAllow`; trimmed, lowercased names; the global `tools` stage; per-provider policies; `agents.defaults.tools` inert; group and sender policies make the result UNKNOWN) are unchanged.

## Still required before deploying the slice-1 client

This is not a readiness claim. Before any deploy:

- the PK-9 check above with `--ops-slice1`, passing;
- the operator layer (kernel) deployed on the target app from `39140839` or later, with its parity and snapshot tests green; if its `capabilities.snapshot.json` differs from `src/fixtures/ops-capabilities.snapshot.json`, copy it in, update the pinned sha256 and rerun the scopelybot suite (the binding cross-check fails on any drift that breaks a tool);
- a service principal for the bot in its users' organization (condition 5), and `ZoomIdentityLink` rows with `zoom_user_id` filled in for its users (condition 3), created by the owner; the kernel's Zoom-id change (IDENTITY-B) deployed with it;
- the token file `<workspace>/scopelybot-ops-token`: a regular file owned by the gateway's user (root), mode `0600`, holding one SERVICE token minted by the owner with `ops_mint_token --principal` for the bot's service principal (condition 6) (`zwops_<12 hex>_<secret>`; it expires after at most 90 days, so put the renewal in the runbook). Check with `stat -c '%U %a %F' scopelybot-ops-token` (expect `root 600 regular file`); never `cat` it;
- the profile: `"authMode": "service-token"`, `env`, `baseUrl` and `allowedHosts` naming the stack;
- a check of the production image for the tool-factory context fields the attribution relies on (probe S0 used a source build of the same code line);
- PK-1: archive of the final v1 file off host (a regular file of at most 8 MiB);
- PK-9 window: `chattr +i` on v1 after the final snapshot, `chattr +a` on `audit-v2.jsonl`, an off-host anchor (`verify-audit-chain.mjs --emit-anchor`) and `--v1-file` against the PK-1 archive;
- PK-8: one live invoke per slice-1 tool on dev, with the bot's `http_intent.audit_id` found as `bot_audit_id` in the app's `OpsAuditEvent` and the app's `request_id` in the bot's outcome row; a kill-switch drill on both sides (`mode: "off"` in the profile; `OPS_KILL_ALL=1` on the app); an unlinked Zoom id answered whoami-only with its id echoed, and a linked one resolving; a header-less whoami (an unmapped asker) reporting `requester.kind: "bot"` and `status: "missing"` (proves condition 6); a mapped single sender's invoke with `requester_header: true`, and, while that person's run is active, a second person posting so that the run's next invoke shows `requester_header: false` (proves condition 4); a pricing-defaults answer under the 64 KB read for the vendors in use; `fsync` latency on the bind mount; the Q1 gate holds in the test window.

## What PK-7b-2 still gates

PK-7b-2 (parked, not in this tree) adds spoke requester attribution (spawn-label stamp, `subagent_spawned` cross-check, run binding) and the confirm/approver rows. It must ship before any of these happens:

- the coordinator gets `sessions_spawn`, so spokes or its own subagents can run;
- a tool run by a spoke or subagent should act for a human (today it is answered whoami-only);
- any write path is enabled (slice 2, the confirm engine).
