# ScopelyBot backend profile

The backend profile decides which ZW app host the bot may reach and whether it may change anything. The guard (`src/scopely-api.ts`), the CONFIRM path and the capability registry read it on every request, so an edit applies to the next request with no restart.

## Location

`<workspace>/scopelybot-backend.json`, next to `scopelybot-approvers.json`. The workspace is `$OPENCLAW_WORKSPACE`, or `/root/.openclaw/workspace` when that variable is unset or empty.

## Production

```json
{
  "profile": "zw2",
  "env": "prod",
  "mode": "read-only",
  "authMode": "anonymous",
  "baseUrl": "https://api.vip.pscx.ai",
  "allowedHosts": ["api.vip.pscx.ai"],
  "digestEnabled": false
}
```

Keep `digestEnabled` false on production. With `true` (and the digest timer armed by `SCOPELYBOT_DAILY_DIGEST=1`), the daily digest sends 4 extra GETs a day to legacy admin paths the new app does not serve, and the health GET is no longer the bot's only app request. M1a's audit-attribution claim depends on it too (`docs/PK-7a-DO-NOT-DEPLOY-ALONE.md`).

## Dev (zw2 sprint stack on noob-root)

```json
{
  "profile": "zw2",
  "env": "dev",
  "mode": "read-only",
  "authMode": "anonymous",
  "baseUrl": "http://100.114.142.100:8022",
  "allowedHosts": ["100.114.142.100:8022"],
  "hostHeader": "vip.localhost",
  "digestEnabled": false
}
```

## Rules the bot enforces

- `mode` is `off` (kill switch: no app request, and no staged change runs on CONFIRM), `read-only` (GET/HEAD only; the default) or `read-write`.
- `read-write` is accepted only with `env: "dev"`. Production stays read-only: lifting that cap for a tool family is a reviewed code change (PK-14), never a profile edit.
- `allowedHosts` must come from the env's host table in the code (prod: `api.vip.pscx.ai`; dev: `100.114.142.100:8022`), and `baseUrl` must be a bare origin on one of them (https; http only for dev).
- `hostHeader` is dev-only and must be one of the dev stack's virtual hosts in the code (`vip.localhost`, `noob-root`), so it cannot pick another service behind the same proxy.
- `authMode` is `anonymous` until PK-12 adds the bot's own sign-in.
- `maxRequestsPerMinute` (1 to 600, default 20) caps the bot's app requests.
- `issueLinks` maps a family id (for example `F7`) to a `https://github.com/cloudwarriors-ai/` issue URL in canonical form. Without one, a refusal names only the manual path and makes no tracking claim.
- Unknown keys are ignored.

## Editing the file

The bot re-reads the file on every request, so never edit it in place. Write the new content to a temporary file in the same directory, then move it over the old one in one step:

```sh
cd /root/.openclaw/workspace          # or the deployment's $OPENCLAW_WORKSPACE
cat > scopelybot-backend.json.tmp     # paste the new JSON, then Ctrl-D
mv scopelybot-backend.json.tmp scopelybot-backend.json
```

To stop anything but an owner from changing the file, the host owner can make it immutable with `chattr +i scopelybot-backend.json` (Linux, root), and remove the flag with `chattr -i` before the next edit. This is a host step; the bot never does it.

Each content change writes one `policy_change` row to the audit-v2 chain `<workspace>/scopelybot/audit-v2.jsonl` (valid, or the error and the fail-closed default). Nothing writes the v1 `audit.jsonl` any more.

## env is self-declared

The bot cannot tell which stack it runs on: `env` is whatever the file says. A prod file copied onto a dev stack is valid there and points that stack at the production API (read-only). The deploy runbook must check `env`, `baseUrl` and `allowedHosts` on every stack.

## Rollout checks

1. On every stack, check that `env`, `baseUrl` and `allowedHosts` name that stack (see above), and that the newest `policy_change` row says `valid: true` with the same `env` and `allowedHosts`.
2. Kill-switch drill: replace the file with the same content plus `"mode": "off"`. The next health check must answer that the connection is switched off by the operator, with a `backend_off` row in the audit log and no request to the app. Put `"mode": "read-only"` back and check that the health check answers again.
3. Rollback is `"mode": "off"`, which applies on the next request with no restart. It is NOT a revert of this change: a revert brings back the deleted legacy login that used the env credentials.

## Missing or invalid file

A missing file, an invalid value anywhere in it, invalid JSON, or anything at the path that is not a regular file of at most 64 KB (a directory or a FIFO, for example) makes the bot apply the fail-closed default: read-only, digest off, and no allowed host, so it sends no request to the app at all. The health check then answers that there is no valid backend profile, and the reason is in the `policy_change` row.
