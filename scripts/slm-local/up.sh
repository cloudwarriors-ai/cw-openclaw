#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.slm-local.yml"

PG_CONTAINER_NAME="${SLM_PG_CONTAINER_NAME:-moltbot-pgvector}"
PG_DB="${SLM_PG_DATABASE:-moltbot}"
PG_USER="${SLM_PG_USER:-moltbot}"
PG_PASSWORD="${SLM_PG_PASSWORD:-moltbot_dev_pw}"
PG_PORT="${SLM_PG_PORT:-55432}"

echo "Starting pgvector container..."
docker compose -f "${COMPOSE_FILE}" up -d pgvector

echo "Waiting for PostgreSQL healthcheck..."
for _ in $(seq 1 60); do
  status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PG_CONTAINER_NAME}" 2>/dev/null || true)"
  if [[ "${status}" == "healthy" || "${status}" == "running" ]]; then
    break
  fi
  sleep 1
done

status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${PG_CONTAINER_NAME}" 2>/dev/null || true)"
if [[ "${status}" != "healthy" && "${status}" != "running" ]]; then
  echo "PostgreSQL did not become healthy in time."
  exit 1
fi

echo "Ensuring pgvector extension is available..."
docker exec \
  -e PGPASSWORD="${PG_PASSWORD}" \
  "${PG_CONTAINER_NAME}" \
  psql -U "${PG_USER}" -d "${PG_DB}" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT extname FROM pg_extension WHERE extname='vector';" >/dev/null

PG_URL="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}"
MEMORY_TOKEN="${OPENCLAW_MEMORY_SERVER_TOKEN:-moltbot-local-token}"
MEMORY_PORT="${SLM_MEMORY_SERVER_PORT:-19090}"

cat <<EOF

pgvector is ready.

Local connection values:
  SLM_PG_URL=${PG_URL}
  OPENCLAW_MEMORY_SERVER_PORT=${MEMORY_PORT}
  OPENCLAW_MEMORY_SERVER_TOKEN=${MEMORY_TOKEN}

Next:
  1) Start memory server:
     OPENCLAW_MEMORY_SERVER_PORT=${MEMORY_PORT} OPENCLAW_MEMORY_SERVER_TOKEN=${MEMORY_TOKEN} bun ${ROOT_DIR}/scripts/slm-local/memory-server.ts
  2) Start local gateway with SLM env:
     OPENCLAW_MEMORY_SERVER_URL=http://127.0.0.1:${MEMORY_PORT} OPENCLAW_MEMORY_SERVER_TOKEN=${MEMORY_TOKEN} OPENCLAW_SLM_FORGE_BIN=\${OPENCLAW_SLM_FORGE_BIN:-/opt/homebrew/bin/forge} pnpm gateway:dev

EOF
