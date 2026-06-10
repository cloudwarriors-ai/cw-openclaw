# Production deployment — cw-openclaw

The flip-switch model: **dev and prod run the same SHA**; only three things
differ per box — `.env`, the compose profile, and the box's `openclaw.json`
runtime config. No prod-only branches, no image surgery.

| Surface       | Dev box (noob-root)         | Prod box (Linode)                                  |
| ------------- | --------------------------- | -------------------------------------------------- |
| Compose       | `docker-compose.dev.yml`    | `docker-compose.prod.yml`                          |
| Env           | `.env` from `.env-template` | `.env` from `.env.prod-template`                   |
| Plugin policy | all bundled extensions      | `plugins.deny` via `deploy/prod-plugin-policy.mjs` |
| Domain        | molty-dev.cloudwarriors.ai  | `$OPENCLAW_PUBLIC_DOMAIN`                          |

## What prod excludes (and how)

`claude-mem`, `slm-pipeline`, `slm-supervisor`, `2fa-github`, `test-capture`
are excluded at the **loader level**: `plugins.deny` in the box's
`openclaw.json` removes them from the effective-enabled set
(`src/plugins/effective-plugin-ids.ts`) and `enable.ts` refuses to re-enable a
denied id. Defense in depth for the test harness: `OPENCLAW_TEST_CAPTURE` is
absent from the prod compose, which keeps `test-capture` fully inert even if
the deny were removed. The slm-dashboard app is never started (no service in
the prod compose; dev's `claude-mem-chroma` service is also absent).

## First-time bring-up (ordered)

1. **Checkout + env.** Clone/fetch the repo on the box, check out `development`
   (or the release SHA), `cp .env.prod-template .env`, fill EVERY value.
   There are no fallbacks: missing secrets fail closed — the gateway boots, but
   that feature errors or stays disabled. Pay attention to:
   - `ZOOM_WEBHOOK_SECRET_TOKEN` — unset means **all** Zoom webhooks are 401'd.
   - the six `*_ZOOM_CHANNEL` JIDs — must be **prod** channels (the in-code
     fallback constants are dev channels); unset disables that bot's write
     staging (fail-closed).
   - `OPENCLAW_PUBLIC_DOMAIN` — the Zoom marketplace app's event subscription
     URL must be `https://$OPENCLAW_PUBLIC_DOMAIN/zoom/webhook`.
2. **Build.** `docker compose -f docker-compose.prod.yml build`
3. **Runtime config.** Provision `.data/openclaw/openclaw.json` (agents list,
   bindings). Then run BOTH config scripts (idempotent, backup-first):
   - `node deploy/prod-plugin-policy.mjs ./.data/openclaw/openclaw.json`
     (prod deny list)
   - `node extensions/test-capture/harness/fix-allow.mjs` against the same file
     (adds each bot's plugin id to its agent `tools.allow` — REQUIRED before
     boot: bot tools are registered `optional:true` and an agent without its
     plugin id in the allowlist loses its own tools).
4. **Up.** `docker compose -f docker-compose.prod.yml up -d`
   No host ports are published — Traefik (on the external `proxy` network)
   terminates TLS and routes `/` → 18789 and `/zoom/` → 4000.
5. **Zoom URL validation.** In the Zoom marketplace app, point the event
   subscription at the prod webhook URL and run validation (the fail-closed
   handler answers the challenge only when the secret is configured).

## Smoke checklist (after every deploy)

- `docker logs openclaw | grep -E "Registered .* tools"` — each bot banner
  appears on first dispatch with the counted total; no module-load crashes.
- Denied plugins absent: `docker logs openclaw | grep -Ei "claude-mem|slm-|2fa|test-capture"`
  shows no activation.
- Webhook fail-closed: `curl -s -o /dev/null -w "%{http_code}" -X POST
https://$OPENCLAW_PUBLIC_DOMAIN/zoom/webhook -H 'content-type: application/json' -d '{}'`
  → **401** (unsigned must be rejected).
- One read-tool round trip per bot from its prod channel; one staged write →
  threaded `CONFIRM <code>` prompt → `CONFIRM 0000` from the wrong code is
  refused ("No pending action").

## Routine deploy (the switch)

```sh
git fetch && git checkout <sha-or-development>
docker compose -f docker-compose.prod.yml build   # only when Dockerfile/dist changed
docker restart openclaw                            # extensions are mounted source
```

Rollback = `git checkout <previous sha>` + restart. `.env` and
`openclaw.json` are not tracked by git and survive checkouts.
