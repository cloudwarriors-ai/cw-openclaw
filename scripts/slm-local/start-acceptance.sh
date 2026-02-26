#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${ROOT_DIR}/.data/slm-local"
PID_FILE="${DATA_DIR}/memory-server.pid"
LOG_FILE="${DATA_DIR}/memory-server.log"

WITH_GATEWAY=0
if [[ "${1:-}" == "--with-gateway" ]]; then
  WITH_GATEWAY=1
fi

mkdir -p "${DATA_DIR}"

"${ROOT_DIR}/scripts/slm-local/up.sh"

MEMORY_PORT="${SLM_MEMORY_SERVER_PORT:-19090}"
MEMORY_TOKEN="${OPENCLAW_MEMORY_SERVER_TOKEN:-moltbot-local-token}"
MEMORY_TENANT="${OPENCLAW_MEMORY_SERVER_TENANT:-${SLM_TEST_TENANT:-tenant-a}}"
PG_USER="${SLM_PG_USER:-moltbot}"
PG_PASSWORD="${SLM_PG_PASSWORD:-moltbot_dev_pw}"
PG_PORT="${SLM_PG_PORT:-55432}"
PG_DB="${SLM_PG_DATABASE:-moltbot}"
SLM_PG_URL="${SLM_PG_URL:-postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}}"
MEMORY_DB_URL="${OPENCLAW_MEMORY_SERVER_DB_URL:-${SLM_PG_URL}}"

if [[ -f "${PID_FILE}" ]]; then
  old_pid="$(cat "${PID_FILE}")"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" >/dev/null 2>&1; then
    echo "Stopping old memory server process ${old_pid}..."
    kill "${old_pid}" || true
  fi
fi

echo "Starting local memory server on port ${MEMORY_PORT}..."
OPENCLAW_MEMORY_SERVER_PORT="${MEMORY_PORT}" \
OPENCLAW_MEMORY_SERVER_TOKEN="${MEMORY_TOKEN}" \
OPENCLAW_MEMORY_SERVER_TENANT="${MEMORY_TENANT}" \
OPENCLAW_MEMORY_SERVER_DB_URL="${MEMORY_DB_URL}" \
bun "${ROOT_DIR}/scripts/slm-local/memory-server.ts" >"${LOG_FILE}" 2>&1 &
echo $! >"${PID_FILE}"

sleep 1
if ! kill -0 "$(cat "${PID_FILE}")" >/dev/null 2>&1; then
  echo "Memory server failed to start. Check ${LOG_FILE}"
  exit 1
fi

cat <<EOF

Local staging dependencies are up.

Memory server:
  pid: $(cat "${PID_FILE}")
  log: ${LOG_FILE}
  url: http://127.0.0.1:${MEMORY_PORT}
  token: ${MEMORY_TOKEN}
  tenant: ${MEMORY_TENANT}
  db: ${MEMORY_DB_URL}

EOF

if [[ "${SLM_SHOW_EMBEDDING_MODEL_HINT:-0}" == "1" ]] && [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
  if model_line="$(bash "${ROOT_DIR}/scripts/slm-local/select-embedding-model.sh" 2>/dev/null | head -n 1)"; then
    if [[ -n "${model_line}" ]]; then
      echo "${model_line}"
      echo
    fi
  fi
fi

if [[ "${WITH_GATEWAY}" -eq 1 ]]; then
  echo "Starting gateway in foreground..."
  OPENCLAW_MEMORY_SERVER_URL="http://127.0.0.1:${MEMORY_PORT}" \
  OPENCLAW_MEMORY_SERVER_TOKEN="${MEMORY_TOKEN}" \
  OPENCLAW_SLM_FORGE_BIN="${OPENCLAW_SLM_FORGE_BIN:-/opt/homebrew/bin/forge}" \
  pnpm gateway:dev
else
  cat <<EOF
To run gateway now:
  OPENCLAW_MEMORY_SERVER_URL=http://127.0.0.1:${MEMORY_PORT} OPENCLAW_MEMORY_SERVER_TOKEN=${MEMORY_TOKEN} OPENCLAW_SLM_FORGE_BIN=\${OPENCLAW_SLM_FORGE_BIN:-/opt/homebrew/bin/forge} pnpm gateway:dev

To run standalone SLM dashboard:
  export SLM_DASHBOARD_USERS_JSON='[{"username":"operator","password_hash":"scrypt$...","tenant_id":"tenant-a"}]'
  export SLM_DASHBOARD_GATEWAY_URL='ws://127.0.0.1:18789'
  export SLM_DASHBOARD_GATEWAY_TOKEN="\${OPENCLAW_GATEWAY_TOKEN:-}"
  pnpm --dir apps/slm-dashboard dev

To run issues #5/#6/#7 integration smoke (fixture-first, Forge optional):
  bash ${ROOT_DIR}/scripts/slm-local/smoke-issues-5-6-7.sh

To tear down everything:
  ${ROOT_DIR}/scripts/slm-local/down.sh
EOF
fi
