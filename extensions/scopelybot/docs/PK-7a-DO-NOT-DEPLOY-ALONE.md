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

The bot's app tools are now the slice-1 reads (`docs/ops-client.md`): `scopely_health_check`, `scopely_auth_status` (whoami) and ten catalog, pricing and session reads, each bound to one read capability of the operator layer and sent as `POST /api/spine/v1/ops/invoke/` with the bot's service token and the asking human's Zoom email. Everything else stays refused by the registry, and no write is live. This is pinned by capability-registry.test.ts, "only the slice-1 operator-layer reads and the local approver list run; no write is live", and the guard refuses any capability outside its read allow-list (scopely-api.ops-guard.test.ts).

The old M1a shape (one anonymous health GET to `/api/v1/health/`) is gone: under `authMode: "anonymous"` no app tool sends anything. M1a cannot be deployed from this code line; it deploys from the PK-7b-1 commit.

## Why attribution still holds, and what it now depends on

The app authorizes every invoke for the human named in `X-Ops-Requester` and audits it. The bot sends that header only for a call whose requester was resolved from the trusted tool-factory context (a human-triggered coordinator run) and whose Zoom operator id has exactly one email in the identity ledger. A spoke, the coordinator's own subagent, an announce run or an unknown sender sends no header, and the app answers whoami only. So a misrouted call is refused by the app, not attributed to the wrong person, provided:

1. The coordinator (`scopelybot`) has no `sessions_spawn`, and no agent that can spawn may target it, so no spoke or own-agent subagent runs the slice-1 tools under the coordinator's allow list. (A spoke would be refused by the app as `requester_unresolved`; its `http_intent` rows would still be `requester.resolved: false`, which fails the Q1 gate.)
2. No allow list other than the coordinator's lists any slice-1 tool, `scopelybot`, `group:plugins`, or a wildcard.
3. The identity ledger's emails are trustworthy. They are NOT verified today: the ledger records `metadata.senderName` when it contains `@`, which is the account email on Zoom's team-chat path but the sender-controlled display name on the chatbot path. Before production, either the app matches the Zoom operator id (`zoom_user_id` on `ZoomIdentityLink`), or the ledger records only the account email, or the deploy proves the bot's channel delivers team-chat events only.

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
- the operator layer (kernel) deployed on the target app with the slice-1 capabilities, its parity and snapshot tests green, and `capabilities.snapshot.json` compared with `src/ops-kernel.test-helpers.ts` (capability names, arg schemas, error codes, token header name);
- a service principal for the bot and `ZoomIdentityLink` rows for its users, created by the owner, and condition 3 above closed;
- the token file `<workspace>/scopelybot-ops-token`: a regular file owned by the gateway's user (root), mode `0600`, one token. Check with `stat -c '%U %a %F' scopelybot-ops-token` (expect `root 600 regular file`); never `cat` it;
- the profile: `"authMode": "service-token"`, `env`, `baseUrl` and `allowedHosts` naming the stack;
- a check of the production image for the tool-factory context fields the attribution relies on (probe S0 used a source build of the same code line);
- PK-1: archive of the final v1 file off host (a regular file of at most 8 MiB);
- PK-9 window: `chattr +i` on v1 after the final snapshot, `chattr +a` on `audit-v2.jsonl`, an off-host anchor (`verify-audit-chain.mjs --emit-anchor`) and `--v1-file` against the PK-1 archive;
- PK-8: one live invoke per slice-1 tool on dev, with the bot's `http_intent.audit_id` found as `bot_audit_id` in the app's `OpsAuditEvent` and the app's `request_id` in the bot's outcome row; a kill-switch drill on both sides (`mode: "off"` in the profile; `OPS_KILL_ALL=1` on the app); an unmapped sender answered whoami-only; `fsync` latency on the bind mount; the Q1 gate holds in the test window.

## What PK-7b-2 still gates

PK-7b-2 (parked, not in this tree) adds spoke requester attribution (spawn-label stamp, `subagent_spawned` cross-check, run binding) and the confirm/approver rows. It must ship before any of these happens:

- the coordinator gets `sessions_spawn`, so spokes or its own subagents can run;
- a tool run by a spoke or subagent should act for a human (today it is answered whoami-only);
- any write path is enabled (slice 2, the confirm engine).
