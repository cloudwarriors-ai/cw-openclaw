# SLM Dashboard

Standalone SLM control dashboard with:

- login auth + cookie sessions
- tenant-scoped BFF routes
- gateway method proxying to `slm.control.*`
- UI sections for Q&A registry, answer updates, and training studio

## Environment

Required:

- `SLM_DASHBOARD_USERS_JSON`
  - JSON array with `username`, `password_hash`, `tenant_id`, optional `display_name`
  - password hash format: `scrypt$N$r$p$<salt_base64>$<digest_base64>`

Generate a password hash:

```bash
pnpm --dir apps/slm-dashboard hash-password 'your-password'
```

Example user config:

```bash
export SLM_DASHBOARD_USERS_JSON='[{"username":"operator","password_hash":"scrypt$...","tenant_id":"tenant-a","display_name":"SLM Operator"}]'
```

Optional:

- `PORT` (default `3875`)
- `SLM_DASHBOARD_COOKIE_NAME` (default `slm_dashboard_session`)
- `SLM_DASHBOARD_COOKIE_SECURE` (default `true` in production, else `false`)
- `SLM_DASHBOARD_SESSION_TTL_SECONDS` (default `28800`)
- `SLM_DASHBOARD_GATEWAY_URL` (default `ws://127.0.0.1:18789`)
- `SLM_DASHBOARD_GATEWAY_TOKEN`
- `SLM_DASHBOARD_GATEWAY_PASSWORD`
- `SLM_DASHBOARD_GATEWAY_TIMEOUT_MS` (default `15000`)

## Commands

- `pnpm --dir apps/slm-dashboard dev`
- `pnpm --dir apps/slm-dashboard test`
- `pnpm --dir apps/slm-dashboard build`
- `pnpm --dir apps/slm-dashboard start`
