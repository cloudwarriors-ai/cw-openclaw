#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEP_ENV_UP=0
SMOKE_SUMMARY_PATH="${SLM_SMOKE_SUMMARY_PATH:-}"
START_ACCEPTANCE_TIMEOUT_SECONDS="${SLM_START_ACCEPTANCE_TIMEOUT_SECONDS:-180}"

if [[ "${1:-}" == "--keep-up" ]]; then
  KEEP_ENV_UP=1
fi

cleanup() {
  if [[ "${KEEP_ENV_UP}" -eq 0 ]]; then
    bash "${ROOT_DIR}/scripts/slm-local/down.sh" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_with_timeout() {
  local timeout_seconds="$1"
  shift
  perl -e 'alarm shift @ARGV; exec @ARGV' "${timeout_seconds}" "$@"
}

if ! run_with_timeout "${START_ACCEPTANCE_TIMEOUT_SECONDS}" \
  bash "${ROOT_DIR}/scripts/slm-local/up.sh" >/dev/null; then
  echo "pgvector bootstrap failed or timed out (${START_ACCEPTANCE_TIMEOUT_SECONDS}s)" >&2
  exit 1
fi

MEMORY_PORT="${SLM_MEMORY_SERVER_PORT:-19090}"
MEMORY_TOKEN="${OPENCLAW_MEMORY_SERVER_TOKEN:-moltbot-local-token}"
MEMORY_TENANT="${OPENCLAW_MEMORY_SERVER_TENANT:-${SLM_TEST_TENANT:-tenant-local}}"
PG_USER="${SLM_PG_USER:-moltbot}"
PG_PASSWORD="${SLM_PG_PASSWORD:-moltbot_dev_pw}"
PG_PORT="${SLM_PG_PORT:-55432}"
PG_DB="${SLM_PG_DATABASE:-moltbot}"
SLM_PG_URL="${SLM_PG_URL:-postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}}"
MEMORY_DB_URL="${OPENCLAW_MEMORY_SERVER_DB_URL:-${SLM_PG_URL}}"
DATA_DIR="${ROOT_DIR}/.data/slm-local"
MEMORY_PID_FILE="${DATA_DIR}/memory-server.pid"
MEMORY_LOG_FILE="${DATA_DIR}/memory-server.log"

mkdir -p "${DATA_DIR}"

if [[ -f "${MEMORY_PID_FILE}" ]]; then
  existing_pid="$(cat "${MEMORY_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" >/dev/null 2>&1; then
    kill "${existing_pid}" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

OPENCLAW_MEMORY_SERVER_PORT="${MEMORY_PORT}" \
OPENCLAW_MEMORY_SERVER_TOKEN="${MEMORY_TOKEN}" \
OPENCLAW_MEMORY_SERVER_TENANT="${MEMORY_TENANT}" \
OPENCLAW_MEMORY_SERVER_DB_URL="${MEMORY_DB_URL}" \
OPENROUTER_API_KEY="" \
nohup bun "${ROOT_DIR}/scripts/slm-local/memory-server.ts" >"${MEMORY_LOG_FILE}" 2>&1 &
memory_pid=$!
echo "${memory_pid}" >"${MEMORY_PID_FILE}"
disown "${memory_pid}" 2>/dev/null || true
sleep 1
if ! kill -0 "$(cat "${MEMORY_PID_FILE}")" >/dev/null 2>&1; then
  echo "memory server failed to start. tail of ${MEMORY_LOG_FILE}:" >&2
  tail -n 120 "${MEMORY_LOG_FILE}" >&2 || true
  exit 1
fi

BASE_URL="http://127.0.0.1:${MEMORY_PORT}"
TOKEN="${MEMORY_TOKEN}"
NAMESPACE="acceptance.smoke"
SOURCE_TAG="smoke-$(date +%s)"

create_payload="$(cat <<EOF
{"namespace":"${NAMESPACE}","kind":"fact","content":"SLM local smoke validation record","metadata":{"source":"${SOURCE_TAG}"}}
EOF
)"

create_response="$(
  curl -sS -X POST "${BASE_URL}/memories" \
    -H "content-type: application/json" \
    -H "authorization: Bearer ${TOKEN}" \
    --data "${create_payload}"
)"

memory_id="$(bun -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.record?.id||"")' "${create_response}")"
if [[ -z "${memory_id}" ]]; then
  echo "create failed: ${create_response}" >&2
  exit 1
fi

search_payload="$(cat <<EOF
{"namespace":"${NAMESPACE}","query_text":"smoke validation record","top_k":5,"min_score":0.0,"metadata_filters":{"source":"${SOURCE_TAG}"}}
EOF
)"

search_response="$(
  curl -sS -X POST "${BASE_URL}/memories/search" \
    -H "content-type: application/json" \
    -H "authorization: Bearer ${TOKEN}" \
    --data "${search_payload}"
)"

search_count="$(bun -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(String(v.records?.length??0))' "${search_response}")"
if [[ "${search_count}" -lt 1 ]]; then
  echo "search failed: ${search_response}" >&2
  exit 1
fi

memory_count="$(
  docker compose -f "${ROOT_DIR}/docker-compose.slm-local.yml" exec -T \
    -e PGPASSWORD="${SLM_PG_PASSWORD:-moltbot_dev_pw}" \
    pgvector \
    psql -U "${SLM_PG_USER:-moltbot}" -d "${SLM_PG_DATABASE:-moltbot}" -Atc \
    "SELECT COUNT(*) FROM memories WHERE id = '${memory_id}';"
)"
vector_count="$(
  docker compose -f "${ROOT_DIR}/docker-compose.slm-local.yml" exec -T \
    -e PGPASSWORD="${SLM_PG_PASSWORD:-moltbot_dev_pw}" \
    pgvector \
    psql -U "${SLM_PG_USER:-moltbot}" -d "${SLM_PG_DATABASE:-moltbot}" -Atc \
    "SELECT COUNT(*) FROM memory_vectors WHERE memory_id = '${memory_id}';"
)"

if [[ "${memory_count}" != "1" || "${vector_count}" != "1" ]]; then
  echo "postgres verification failed for memory_id=${memory_id} (memories=${memory_count}, vectors=${vector_count})" >&2
  exit 1
fi

query_model="$(bun -e 'const v=JSON.parse(process.argv[1]); process.stdout.write(v.query_embedding_model||"")' "${search_response}")"

summary_json="$(cat <<EOF
{
  "ok": true,
  "stage": "memory",
  "memory_id": "${memory_id}",
  "query_embedding_model": "${query_model}",
  "search_count": ${search_count},
  "keep_env_up": ${KEEP_ENV_UP}
}
EOF
)"

if [[ -n "${SMOKE_SUMMARY_PATH}" ]]; then
  mkdir -p "$(dirname "${SMOKE_SUMMARY_PATH}")"
  printf '%s\n' "${summary_json}" > "${SMOKE_SUMMARY_PATH}"
fi

printf '%s\n' "${summary_json}"
