#!/bin/bash

set -euo pipefail

NGROK_API_BASE="${NGROK_API_BASE:-http://127.0.0.1:4040}"
WEBHOOK_PATH="${WEBHOOK_PATH:-/zoom/webhook}"
LIMIT="${LIMIT:-50}"
POLL_SECONDS="${POLL_SECONDS:-1}"
SHOW_BODY=true
SHOW_LOGS=true
RUN_ONCE=false

SEEN_FILE="$(mktemp -t zoom-webhooks-seen.XXXXXX)"
LOG_TAIL_PID=""

cleanup() {
  if [[ -n "${LOG_TAIL_PID}" ]]; then
    kill "${LOG_TAIL_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${SEEN_FILE}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

usage() {
  cat <<'EOF'
zoom-webhooks-live.sh - watch Zoom webhook traffic in real time

Usage:
  scripts/zoom-webhooks-live.sh [options]

Options:
  --once              Print newly seen requests once and exit
  --no-body           Do not print webhook JSON bodies
  --no-logs           Do not tail OpenClaw zoom handling logs
  --limit N           Number of ngrok requests to scan each poll (default: 50)
  --poll N            Poll interval in seconds (default: 1)
  --api URL           Ngrok inspector base URL (default: http://127.0.0.1:4040)
  --path PATH         Webhook path filter (default: /zoom/webhook)
  -h, --help          Show help

Environment overrides:
  NGROK_API_BASE, WEBHOOK_PATH, LIMIT, POLL_SECONDS
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)
      RUN_ONCE=true
      shift
      ;;
    --no-body)
      SHOW_BODY=false
      shift
      ;;
    --no-logs)
      SHOW_LOGS=false
      shift
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --poll)
      POLL_SECONDS="${2:-}"
      shift 2
      ;;
    --api)
      NGROK_API_BASE="${2:-}"
      shift 2
      ;;
    --path)
      WEBHOOK_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd rg

BASE64_DECODE_CMD=""
if printf 'dGVzdA==' | base64 --decode >/dev/null 2>&1; then
  BASE64_DECODE_CMD="base64 --decode"
elif printf 'dGVzdA==' | base64 -D >/dev/null 2>&1; then
  BASE64_DECODE_CMD="base64 -D"
elif command -v openssl >/dev/null 2>&1; then
  BASE64_DECODE_CMD="openssl base64 -d -A"
else
  echo "Missing base64 decoder (base64/openssl)." >&2
  exit 1
fi

decode_base64() {
  # shellcheck disable=SC2086
  ${BASE64_DECODE_CMD}
}

print_request() {
  local id="$1"
  local detail raw request_text body status method uri start sig ts event cmd user_jid user_email
  detail="$(curl -fsS "${NGROK_API_BASE}/api/requests/http/${id}")"

  status="$(printf '%s' "${detail}" | jq -r '.response.status_code // "-"')"
  method="$(printf '%s' "${detail}" | jq -r '.request.method // "-"')"
  uri="$(printf '%s' "${detail}" | jq -r '.request.uri // "-"')"
  start="$(printf '%s' "${detail}" | jq -r '.start // "-"')"
  sig="$(printf '%s' "${detail}" | jq -r '.request.headers["X-Zm-Signature"][0] // .request.headers["x-zm-signature"][0] // "-"')"
  ts="$(printf '%s' "${detail}" | jq -r '.request.headers["X-Zm-Request-Timestamp"][0] // .request.headers["x-zm-request-timestamp"][0] // "-"')"
  raw="$(printf '%s' "${detail}" | jq -r '.request.raw // empty')"

  request_text="$(printf '%s' "${raw}" | decode_base64 2>/dev/null || true)"
  body="${request_text#*$'\r\n\r\n'}"
  if [[ "${body}" == "${request_text}" ]]; then
    body="${request_text#*$'\n\n'}"
  fi

  event="$(printf '%s' "${body}" | jq -r '.event // "-"' 2>/dev/null || echo "-")"
  cmd="$(printf '%s' "${body}" | jq -r '.payload.object.cmd // .payload.cmd // .payload.object.text // .payload.text // "-"' 2>/dev/null || echo "-")"
  user_jid="$(printf '%s' "${body}" | jq -r '.payload.object.userJid // .payload.userJid // .payload.object.user_jid // .payload.user_jid // "-"' 2>/dev/null || echo "-")"
  user_email="$(printf '%s' "${body}" | jq -r '.payload.object.user_email // .payload.user_email // .payload.object.userEmail // .payload.userEmail // "-"' 2>/dev/null || echo "-")"

  printf '\n[%s] id=%s %s %s status=%s\n' "$(date '+%H:%M:%S')" "${id}" "${method}" "${uri}" "${status}"
  printf '  start=%s\n' "${start}"
  printf '  event=%s cmd=%s\n' "${event}" "${cmd}"
  printf '  userJid=%s userEmail=%s\n' "${user_jid}" "${user_email}"
  printf '  sigPrefix=%s ts=%s\n' "${sig:0:18}" "${ts}"

  if [[ "${SHOW_BODY}" == true && -n "${body}" ]]; then
    echo "  body:"
    printf '%s\n' "${body}" | jq . 2>/dev/null || printf '%s\n' "${body}"
  fi
}

already_seen() {
  local id="$1"
  rg -qx --fixed-strings "${id}" "${SEEN_FILE}" >/dev/null 2>&1
}

mark_seen() {
  local id="$1"
  printf '%s\n' "${id}" >> "${SEEN_FILE}"
}

poll_once() {
  local list_json id
  list_json="$(curl -fsS "${NGROK_API_BASE}/api/requests/http?limit=${LIMIT}")"

  while IFS= read -r id; do
    [[ -z "${id}" ]] && continue
    if already_seen "${id}"; then
      continue
    fi
    mark_seen "${id}"
    print_request "${id}"
  done < <(
    printf '%s' "${list_json}" \
      | jq -r --arg path "${WEBHOOK_PATH}" '.requests | reverse | .[] | select(.request.uri == $path) | .id'
  )
}

start_log_tail() {
  if [[ "${SHOW_LOGS}" != true ]]; then
    return
  fi

  local log_file
  log_file="$(ls -1t /tmp/openclaw/openclaw-*.log 2>/dev/null | head -n 1 || true)"
  if [[ -z "${log_file}" || ! -f "${log_file}" ]]; then
    echo "No OpenClaw log file found under /tmp/openclaw; skipping --logs stream." >&2
    return
  fi

  echo "Tailing OpenClaw zoom handling logs from ${log_file}"
  tail -n 0 -F "${log_file}" \
    | rg --line-buffered 'webhook event received|bot_notification event|invalid webhook signature|missing webhook signature|zoom sender email|bot_notification missing required fields|delivered [0-9]+ reply|sending message|sent message' \
    | while IFS= read -r line; do
        printf '[openclaw] %s\n' "${line}"
      done &
  LOG_TAIL_PID="$!"
}

echo "Watching ngrok webhooks at ${NGROK_API_BASE} (path=${WEBHOOK_PATH}, limit=${LIMIT}, poll=${POLL_SECONDS}s)"
start_log_tail

while true; do
  if ! poll_once; then
    echo "Failed to fetch ngrok requests (is ngrok inspect API up at ${NGROK_API_BASE}?). Retrying..." >&2
  fi

  if [[ "${RUN_ONCE}" == true ]]; then
    break
  fi
  sleep "${POLL_SECONDS}"
done
