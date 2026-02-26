# SLM Local Staging and Acceptance Setup

This runbook starts a local acceptance environment for issue #5/#6/#7 work:

1. Local PostgreSQL with `pgvector` extension (Docker).
2. Local memory server for `memory-pgvector` extension wiring.
3. Local OpenClaw gateway with SLM env variables.

## Prerequisites

1. Docker + Docker Compose.
2. Bun.
3. Forge CLI available on PATH (or set `OPENCLAW_SLM_FORGE_BIN` explicitly).
4. OpenRouter API key if you want model selection and remote embedding execution.

## Start Dependencies

```bash
bash scripts/slm-local/start-acceptance.sh
```

This will:

1. Start `pgvector/pgvector:pg16` on `127.0.0.1:55432` (default).
2. Enable `vector` extension in the DB.
3. Start a local memory server on `127.0.0.1:19090` (default), backed by Postgres when `SLM_PG_URL`/`OPENCLAW_MEMORY_SERVER_DB_URL` is set.

## Select Embedding Model (OpenRouter)

```bash
OPENROUTER_API_KEY=... bash scripts/slm-local/select-embedding-model.sh
```

Default recommendation for quality-first retrieval:

1. `openai/text-embedding-3-large`

Common fallback for lower cost:

1. `qwen/qwen3-embedding-8b`

## Start Gateway for Acceptance

```bash
OPENCLAW_MEMORY_SERVER_URL=http://127.0.0.1:19090 \
OPENCLAW_MEMORY_SERVER_TOKEN=moltbot-local-token \
OPENCLAW_MEMORY_EMBEDDING_MODEL=openai/text-embedding-3-large \
OPENCLAW_SLM_FORGE_BIN=${OPENCLAW_SLM_FORGE_BIN:-/opt/homebrew/bin/forge} \
pnpm gateway:dev
```

## Start Standalone SLM Dashboard

Generate a password hash:

```bash
pnpm --dir apps/slm-dashboard hash-password 'replace-this-password'
```

Start dashboard:

```bash
SLM_DASHBOARD_USERS_JSON='[{"username":"operator","password_hash":"scrypt$...","tenant_id":"tenant-a","display_name":"SLM Operator"}]' \
SLM_DASHBOARD_GATEWAY_URL=ws://127.0.0.1:18789 \
SLM_DASHBOARD_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-} \
pnpm --dir apps/slm-dashboard dev
```

Open `http://127.0.0.1:3875` and sign in with the configured user.

## Validate Memory Server

```bash
curl -sS -X POST http://127.0.0.1:19090/memories \
  -H "Authorization: Bearer moltbot-local-token" \
  -H "Content-Type: application/json" \
  -d '{"namespace":"slm.test","kind":"note","content":"hello"}' | jq
```

Search validation:

```bash
curl -sS -X POST http://127.0.0.1:19090/memories/search \
  -H "Authorization: Bearer moltbot-local-token" \
  -H "Content-Type: application/json" \
  -d '{"namespace":"slm.test","query_text":"hello","top_k":3}' | jq
```

One-command smoke test (creates+searches+verifies SQL rows):

```bash
bash scripts/slm-local/smoke.sh
```

Issue #5/#6/#7 end-to-end smoke (Forge Q/A seed -> pipeline -> supervisor -> `slm.control.*` -> memory verification):

```bash
bash scripts/slm-local/smoke-issues-5-6-7.sh
```

Seed review events from Forge explicitly (writes `qa.approved` events to the gateway state directory):

```bash
bun scripts/slm-local/seed-forge-qa.ts \
  --forge-dir /Users/chadsimon/code/forge \
  --out .data/slm-local/gateway-state/zoom-review-events.jsonl \
  --tenant tenant-local \
  --limit 40
```

## Stop Environment

```bash
bash scripts/slm-local/down.sh
```
