# PK-7a: do not deploy without PK-7b-1

PK-7a (backend profile, guard, capability registry) must never ship alone. On its own:

- its audit rows go to the v1 `audit.jsonl`, which breaks the v1-freeze/epoch continuity;
- the allowed health GET writes no HTTP audit row and sends no correlation header or parameter;
- an audit-write failure only reaches `console.error`.

PK-7b-1 resolves all three (details in `docs/audit-v2.md`):

- every row goes to the hash-chained `audit-v2.jsonl`; v1 is read once, for the epoch marker, and never written;
- every app request writes an `http_intent` row before it is sent and exactly one terminal row after, and carries `bot_audit_id` and `x-correlation-id`;
- if the intent row cannot be written, or the chain tail does not verify, the request is not sent.

## What PK-7b-2 still gates

PK-7b-2 (parked, not in this tree) adds spoke requester attribution (spawn-label stamp, `subagent_spawned` cross-check, run binding) and the confirm/approver rows (`confirm_denied`, `confirm_expired`, `approver_change`, requester and approval on CONFIRM rows, the unattributed-write refusal). It must ship before any of these happens:

- the coordinator gets `sessions_spawn`, so spokes or its own subagents can run;
- a tool run by a spoke or subagent makes app requests;
- any write path is enabled (PK-13).

## Why M1a needs only PK-7b-1

M1a's audit attribution holds only if no spoke and no subagent can run `scopely_health_check`, the one tool that makes app requests in M1. Every other tool is refused by the registry and no write is live; this is pinned by capability-registry.test.ts, "only the health check and the local approver list run in M1; no write is live". The health check run by the coordinator itself is attributed from the trusted tool-factory context. A spoke or subagent running it would write `requester.reason: missing` rows: the Q1 gate (0 unresolved rows) would fail, but nothing would be attributed to the wrong person.

Two conditions make that hold, and the plugin cannot see either:

1. The coordinator (`scopelybot`) has no `sessions_spawn` in M1a, so no spoke or own-agent subagent exists. An own-agent subagent inherits the coordinator's allow list, which includes `scopely_health_check`.
2. No allow list other than the coordinator's lists `scopely_health_check`, `scopelybot`, `group:plugins`, or a wildcard.

The backend profile's `digestEnabled` must also stay `false` (the default): the daily digest sends timer GETs with a `system` requester.

### PK-9 acceptance check (not yet automated)

Run against the deployed `openclaw.json`. Each command must print nothing:

```sh
# 1. The coordinator cannot spawn (directly, through a group, a profile or a wildcard).
jq -r '.agents.list[] | select(.id == "scopelybot")
  | ((.tools.allow // [])[] | select(. == "sessions_spawn" or . == "group:sessions" or . == "group:openclaw" or test("[*?]"))),
    (.tools.profile // empty | select(. == "coding" or . == "full"))' openclaw.json

# 2. No other agent, and no default, can run the health check.
jq -r '(.agents.list[] | select(.id != "scopelybot") | .id as $id | (.tools.allow // [])[] | "\($id)\t\(.)"),
  ((.agents.defaults.tools.allow // [])[] | "defaults\t\(.)")
  | select(test("\t(scopely_health_check|scopelybot|group:plugins)$") or test("\t.*[*?]"))' openclaw.json

# 3. The digest stays off (prints nothing when digestEnabled is false or absent).
jq -r 'select(.digestEnabled == true) | "digestEnabled is true"' "$OPENCLAW_WORKSPACE/scopelybot-backend.json"
```

## Still required before deploying PK-7a + PK-7b-1

This is not a readiness claim. Before any deploy:

- the PK-9 acceptance check above;
- a check of the production image for the tool-factory context fields the attribution relies on (probe S0 used a source build of the same code line);
- PK-1: archive of the final v1 file off host (it must be a regular file of at most 8 MiB);
- PK-9 window: `chattr +i` on v1 after the final snapshot, `chattr +a` on `audit-v2.jsonl`, an off-host anchor (`verify-audit-chain.mjs --emit-anchor`) and `--v1-file` against the PK-1 archive;
- PK-8: each M1 endpoint accepts `bot_audit_id`; `fsync` latency on the bind mount; the Q1 gate holds in the test window.
