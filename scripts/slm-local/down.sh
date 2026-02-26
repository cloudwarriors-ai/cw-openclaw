#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.slm-local.yml"
PID_FILE="${ROOT_DIR}/.data/slm-local/memory-server.pid"

if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
    echo "Stopping memory server process ${pid}..."
    kill "${pid}" || true
  fi
  rm -f "${PID_FILE}"
fi

echo "Stopping pgvector container..."
docker compose -f "${COMPOSE_FILE}" down

echo "Done."
