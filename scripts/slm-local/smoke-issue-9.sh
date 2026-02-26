#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_DIR="${ROOT_DIR}/.data/slm-local"
STATE_DIR="${DATA_DIR}/gateway-state"
GATEWAY_LOG="${DATA_DIR}/gateway.log"
GATEWAY_PID_FILE="${DATA_DIR}/gateway.pid"

KEEP_ENV_UP=0
KEEP_GATEWAY_UP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-up)
      KEEP_ENV_UP=1
      shift
      ;;
    --keep-gateway-up)
      KEEP_GATEWAY_UP=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  bash scripts/slm-local/smoke-issue-9.sh [--keep-up] [--keep-gateway-up]

Options:
  --keep-up           Leave Postgres + memory server running after completion.
  --keep-gateway-up   Leave gateway process running after completion.

Environment:
  SLM_SEED_SOURCE=fixture|forge    QA seed source (default: fixture).
  SLM_QA_FIXTURE_PATH=<path>       Fixture JSONL path when source=fixture.
  FORGE_DIR=<path>                 Forge workspace root when source=forge.
  SLM_START_ACCEPTANCE_TIMEOUT_SECONDS=<n>
                                   Timeout for pgvector bootstrap (default: 300s).
  SLM_SMOKE_SUMMARY_PATH=<path>    Optional path to write smoke JSON summary.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "${KEEP_GATEWAY_UP}" -eq 1 ]]; then
  KEEP_ENV_UP=1
fi

mkdir -p "${DATA_DIR}"
rm -rf "${STATE_DIR}"
mkdir -p "${STATE_DIR}"

cleanup() {
  if [[ "${KEEP_GATEWAY_UP}" -eq 0 ]]; then
    if [[ -f "${GATEWAY_PID_FILE}" ]]; then
      gateway_pid="$(cat "${GATEWAY_PID_FILE}" 2>/dev/null || true)"
      if [[ -n "${gateway_pid}" ]] && kill -0 "${gateway_pid}" >/dev/null 2>&1; then
        kill "${gateway_pid}" >/dev/null 2>&1 || true
      fi
      rm -f "${GATEWAY_PID_FILE}"
    fi
  fi
  if [[ "${KEEP_ENV_UP}" -eq 0 ]]; then
    bash "${ROOT_DIR}/scripts/slm-local/down.sh" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

TENANT_ID="${SLM_TEST_TENANT:-tenant-local}"
MEMORY_PORT="${SLM_INTEGRATION_MEMORY_PORT:-19190}"
export SLM_TEST_TENANT="${TENANT_ID}"
export SLM_MEMORY_SERVER_PORT="${MEMORY_PORT}"
export OPENCLAW_MEMORY_SERVER_TENANT="${OPENCLAW_MEMORY_SERVER_TENANT:-${TENANT_ID}}"
export OPENCLAW_MEMORY_SERVER_TOKEN="${OPENCLAW_MEMORY_SERVER_TOKEN:-moltbot-local-token}"
export OPENCLAW_MEMORY_SERVER_URL="http://127.0.0.1:${MEMORY_PORT}"

SLM_HTTP_AUTH_TOKEN="${SLM_HTTP_AUTH_TOKEN:-slm-local-http-token}"
GATEWAY_PORT="${SLM_GATEWAY_PORT:-28789}"
GATEWAY_AUTH_TOKEN="${SLM_GATEWAY_TOKEN:-slm-local-gateway-token}"
GATEWAY_HTTP_URL="http://127.0.0.1:${GATEWAY_PORT}"
GATEWAY_WS_URL="ws://127.0.0.1:${GATEWAY_PORT}"
SEED_SOURCE="${SLM_SEED_SOURCE:-fixture}"
FORGE_DIR="${FORGE_DIR:-}"
FIXTURE_PATH="${SLM_QA_FIXTURE_PATH:-${ROOT_DIR}/scripts/slm-local/fixtures/zoom-review-events.jsonl}"
SEED_OUT="${STATE_DIR}/zoom-review-events.jsonl"
GATEWAY_CONFIG_PATH="${STATE_DIR}/openclaw.json"
SEED_LIMIT="${SLM_SEED_MAX_PAIRS:-40}"
SEED_MAX_FILES="${SLM_SEED_MAX_FILES:-1200}"
SMOKE_SUMMARY_PATH="${SLM_SMOKE_SUMMARY_PATH:-}"
START_ACCEPTANCE_TIMEOUT_SECONDS="${SLM_START_ACCEPTANCE_TIMEOUT_SECONDS:-300}"

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  local cmd_pid
  "$@" &
  cmd_pid=$!

  local elapsed=0
  while kill -0 "${cmd_pid}" >/dev/null 2>&1; do
    if [[ "${elapsed}" -ge "${timeout_seconds}" ]]; then
      echo "Command timed out after ${timeout_seconds}s: $*" >&2
      kill "${cmd_pid}" >/dev/null 2>&1 || true
      wait "${cmd_pid}" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  wait "${cmd_pid}"
}

if ! run_with_timeout "${START_ACCEPTANCE_TIMEOUT_SECONDS}" \
  bash "${ROOT_DIR}/scripts/slm-local/up.sh" >/dev/null; then
  echo "pgvector bootstrap failed or timed out (${START_ACCEPTANCE_TIMEOUT_SECONDS}s)" >&2
  exit 1
fi

PG_USER="${SLM_PG_USER:-moltbot}"
PG_PASSWORD="${SLM_PG_PASSWORD:-moltbot_dev_pw}"
PG_PORT="${SLM_PG_PORT:-55432}"
PG_DB="${SLM_PG_DATABASE:-moltbot}"
SLM_PG_URL="${SLM_PG_URL:-postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}}"
MEMORY_PID_FILE="${DATA_DIR}/memory-server.pid"
MEMORY_LOG_FILE="${DATA_DIR}/memory-server.log"

if [[ -f "${MEMORY_PID_FILE}" ]]; then
  existing_pid="$(cat "${MEMORY_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" >/dev/null 2>&1; then
    kill "${existing_pid}" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

OPENCLAW_MEMORY_SERVER_PORT="${MEMORY_PORT}" \
OPENCLAW_MEMORY_SERVER_TOKEN="${OPENCLAW_MEMORY_SERVER_TOKEN}" \
OPENCLAW_MEMORY_SERVER_TENANT="${OPENCLAW_MEMORY_SERVER_TENANT}" \
OPENCLAW_MEMORY_SERVER_DB_URL="${OPENCLAW_MEMORY_SERVER_DB_URL:-${SLM_PG_URL}}" \
OPENROUTER_API_KEY="" \
nohup bun "${ROOT_DIR}/scripts/slm-local/memory-server.ts" >"${MEMORY_LOG_FILE}" 2>&1 &
memory_pid=$!
echo "${memory_pid}" >"${MEMORY_PID_FILE}"
disown "${memory_pid}" 2>/dev/null || true
sleep 1
if ! kill -0 "$(cat "${MEMORY_PID_FILE}")" >/dev/null 2>&1; then
  echo "Memory server failed to start. Tail of ${MEMORY_LOG_FILE}:" >&2
  tail -n 120 "${MEMORY_LOG_FILE}" >&2 || true
  exit 1
fi

cat >"${GATEWAY_CONFIG_PATH}" <<EOF
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "port": ${GATEWAY_PORT}
  },
  "plugins": {
    "allow": ["slm-pipeline"],
    "load": {
      "paths": [
        "${ROOT_DIR}/extensions/slm-pipeline"
      ]
    }
  }
}
EOF

if [[ "${SEED_SOURCE}" == "forge" ]]; then
  if [[ -z "${FORGE_DIR}" ]]; then
    echo "FORGE_DIR is required when SLM_SEED_SOURCE=forge" >&2
    exit 1
  fi
  bun "${ROOT_DIR}/scripts/slm-local/seed-forge-qa.ts" \
    --forge-dir "${FORGE_DIR}" \
    --out "${SEED_OUT}" \
    --tenant "${TENANT_ID}" \
    --limit "${SEED_LIMIT}" \
    --max-files "${SEED_MAX_FILES}" >/dev/null
else
  bun "${ROOT_DIR}/scripts/slm-local/seed-fixture-qa.ts" \
    --fixture "${FIXTURE_PATH}" \
    --out "${SEED_OUT}" \
    --tenant "${TENANT_ID}" \
    --limit "${SEED_LIMIT}" >/dev/null
fi

if [[ -f "${GATEWAY_PID_FILE}" ]]; then
  existing_pid="$(cat "${GATEWAY_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" >/dev/null 2>&1; then
    kill "${existing_pid}" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

OPENCLAW_SKIP_CHANNELS=1 \
CLAWDBOT_SKIP_CHANNELS=1 \
OPENCLAW_STATE_DIR="${STATE_DIR}" \
OPENCLAW_CONFIG_PATH="${GATEWAY_CONFIG_PATH}" \
OPENCLAW_GATEWAY_TOKEN="${GATEWAY_AUTH_TOKEN}" \
OPENCLAW_MEMORY_SERVER_URL="${OPENCLAW_MEMORY_SERVER_URL}" \
OPENCLAW_MEMORY_SERVER_TOKEN="${OPENCLAW_MEMORY_SERVER_TOKEN}" \
OPENCLAW_SLM_HTTP_REQUIRE_AUTH=1 \
OPENCLAW_SLM_HTTP_AUTH_TOKEN="${SLM_HTTP_AUTH_TOKEN}" \
OPENCLAW_SLM_FORGE_BIN="" \
OPENCLAW_SLM_FORGE_DOMAIN="" \
pnpm openclaw gateway run --dev --allow-unconfigured --bind loopback --port "${GATEWAY_PORT}" \
  >"${GATEWAY_LOG}" 2>&1 &
echo $! >"${GATEWAY_PID_FILE}"

sleep 1
if ! kill -0 "$(cat "${GATEWAY_PID_FILE}")" >/dev/null 2>&1; then
  echo "Gateway failed to start. Tail of ${GATEWAY_LOG}:" >&2
  tail -n 120 "${GATEWAY_LOG}" >&2 || true
  exit 1
fi

smoke_output="$(
  SLM_GATEWAY_HTTP_URL="${GATEWAY_HTTP_URL}" \
  SLM_GATEWAY_WS_URL="${GATEWAY_WS_URL}" \
  SLM_GATEWAY_TOKEN="${GATEWAY_AUTH_TOKEN}" \
  SLM_GATEWAY_PASSWORD="${OPENCLAW_GATEWAY_PASSWORD:-}" \
  OPENCLAW_CONFIG_PATH="${GATEWAY_CONFIG_PATH}" \
  OPENCLAW_STATE_DIR="${STATE_DIR}" \
  SLM_HTTP_AUTH_TOKEN="${SLM_HTTP_AUTH_TOKEN}" \
  SLM_QA_EVENTS_PATH="${SEED_OUT}" \
  OPENCLAW_MEMORY_SERVER_URL="${OPENCLAW_MEMORY_SERVER_URL}" \
  OPENCLAW_MEMORY_SERVER_TOKEN="${OPENCLAW_MEMORY_SERVER_TOKEN}" \
  bun "${ROOT_DIR}/scripts/slm-local/run-issue-9-check.ts"
)"

echo "${smoke_output}"

if [[ -n "${SMOKE_SUMMARY_PATH}" ]]; then
  mkdir -p "$(dirname "${SMOKE_SUMMARY_PATH}")"
  printf '%s\n' "${smoke_output}" > "${SMOKE_SUMMARY_PATH}"
fi
