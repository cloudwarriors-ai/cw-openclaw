#!/usr/bin/env bash
set -euo pipefail

# Team Lead Agent Config Setup
# Installs skills and REMOTE-AGENT.md so a remote agent can communicate
# with the team lead's gateway.
#
# Usage:
#   ./setup.sh                          # Interactive — prompts for values
#   ./setup.sh --lead-gateway URL       # Non-interactive with flags
#
# What this does:
#   1. Copies 6 skill files into ~/.openclaw/skills/
#   2. Templates REMOTE-AGENT.md with your lead's gateway URL/token
#   3. Creates team-roster.json and current-project.json
#   4. Tests connectivity to the lead gateway
#
# What this does NOT do:
#   - Install the team-lead extension (that runs on the LEAD's machine only)
#   - Modify your openclaw.json plugins (remote agents don't need the plugin)
#
# Prerequisites:
#   - OpenClaw installed (~/.openclaw/ directory exists)
#   - Tailscale connected to team tailnet
#   - Lead's gateway running and reachable

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_DIR="${HOME}/.openclaw"
SKILLS_DIR="${OPENCLAW_DIR}/skills"
WORKSPACE_DIR="${OPENCLAW_DIR}/workspace"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }
fatal() { error "$@"; exit 1; }

# --- Parse flags ---
LEAD_GATEWAY=""
LEAD_TOKEN=""
LEAD_MCP=""
LEAD_SESSION_KEY=""
LEAD_NAME=""
AGENT_NAME=""

derive_default_mcp_url() {
  local gateway="${1%/}"
  if [[ "$gateway" =~ ^http://[^/]+:[0-9]+$ ]]; then
    printf '%s\n' "${gateway%:*}:8400/mcp"
    return
  fi
  printf '\n'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lead-gateway) LEAD_GATEWAY="$2"; shift 2 ;;
    --lead-token)   LEAD_TOKEN="$2"; shift 2 ;;
    --lead-mcp)     LEAD_MCP="$2"; shift 2 ;;
    --lead-session-key) LEAD_SESSION_KEY="$2"; shift 2 ;;
    --lead-name)    LEAD_NAME="$2"; shift 2 ;;
    --agent-name)   AGENT_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ./setup.sh [OPTIONS]"
      echo ""
      echo "Installs team agent skills and configures reporting to the lead gateway."
      echo "This is for REMOTE AGENTS, not the lead. The lead runs the team-lead"
      echo "extension as an OpenClaw plugin — that's separate."
      echo ""
      echo "Options:"
      echo "  --lead-gateway URL    Lead's gateway URL (e.g. https://lead-host.tailnet.ts.net)"
      echo "  --lead-token TOKEN    Lead gateway token for /tools/invoke"
      echo "  --lead-mcp URL        Lead's MCP URL (required if not derivable from the gateway URL)"
      echo "  --lead-session-key KEY  Lead session key for /tools/invoke (default: agent:main:main)"
      echo "  --lead-name NAME      Lead's name (default: 'daniel')"
      echo "  --agent-name NAME     Your agent name (defaults to hostname)"
      exit 0
      ;;
    *) fatal "Unknown flag: $1. Use --help for usage." ;;
  esac
done

# --- Preflight checks ---
echo ""
echo "=== Team Agent Setup ==="
echo ""

if [[ ! -d "$OPENCLAW_DIR" ]]; then
  fatal "~/.openclaw/ not found. Install OpenClaw first."
fi
info "OpenClaw directory found"

# --- Gather inputs ---
if [[ -z "$AGENT_NAME" ]]; then
  DEFAULT_NAME="$(hostname -s | tr '[:upper:]' '[:lower:]')"
  read -rp "Agent name [$DEFAULT_NAME]: " AGENT_NAME
  AGENT_NAME="${AGENT_NAME:-$DEFAULT_NAME}"
fi

if [[ -z "$LEAD_GATEWAY" ]]; then
  read -rp "Lead gateway URL (e.g. https://lead-host.tailnet.ts.net): " LEAD_GATEWAY
fi
[[ -z "$LEAD_GATEWAY" ]] && fatal "Lead gateway URL is required."

if [[ -z "$LEAD_TOKEN" ]]; then
  read -rp "Lead gateway auth token: " LEAD_TOKEN
fi
[[ -z "$LEAD_TOKEN" ]] && fatal "Lead gateway auth token is required."

if [[ -z "$LEAD_SESSION_KEY" ]]; then
  read -rp "Lead session key [agent:main:main]: " LEAD_SESSION_KEY
  LEAD_SESSION_KEY="${LEAD_SESSION_KEY:-agent:main:main}"
fi

# Derive MCP URL from the raw gateway host:port when possible.
if [[ -z "$LEAD_MCP" ]]; then
  DEFAULT_LEAD_MCP="$(derive_default_mcp_url "$LEAD_GATEWAY")"
  if [[ -n "$DEFAULT_LEAD_MCP" ]]; then
    read -rp "Lead MCP URL [$DEFAULT_LEAD_MCP]: " LEAD_MCP_INPUT
    LEAD_MCP="${LEAD_MCP_INPUT:-$DEFAULT_LEAD_MCP}"
  else
    read -rp "Lead MCP URL (required when the gateway uses a Serve URL): " LEAD_MCP
  fi
fi

if [[ -z "$LEAD_MCP" ]]; then
  warn "Lead MCP URL not set; REMOTE-AGENT.md will keep a placeholder for MCP calls"
  LEAD_MCP="ASK_THE_LEAD_FOR_MCP_URL"
fi

if [[ -z "$LEAD_NAME" ]]; then
  read -rp "Lead's name [daniel]: " LEAD_NAME
  LEAD_NAME="${LEAD_NAME:-daniel}"
fi

# --- Step 1: Install skills ---
echo ""
echo "--- Installing skills ---"

SKILL_NAMES=(apply-config check-task check-team heartbeat report-status send-task)

for skill in "${SKILL_NAMES[@]}"; do
  src="${SCRIPT_DIR}/skills/${skill}/SKILL.md"
  dst="${SKILLS_DIR}/${skill}/SKILL.md"

  if [[ ! -f "$src" ]]; then
    warn "Skill source missing: $src (skipping)"
    continue
  fi

  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  info "$skill — installed"
done

# --- Step 2: Install REMOTE-AGENT.md ---
echo ""
echo "--- Installing REMOTE-AGENT.md ---"

mkdir -p "$WORKSPACE_DIR"
REMOTE_AGENT_SRC="${SCRIPT_DIR}/REMOTE-AGENT.md"
REMOTE_AGENT_DST="${WORKSPACE_DIR}/REMOTE-AGENT.md"

if [[ ! -f "$REMOTE_AGENT_SRC" ]]; then
  fatal "REMOTE-AGENT.md source missing at $REMOTE_AGENT_SRC"
fi

# Replace all placeholders with actual values
sed \
  -e "s|__LEAD_GATEWAY__|${LEAD_GATEWAY}|g" \
  -e "s|__LEAD_MCP__|${LEAD_MCP}|g" \
  -e "s|__LEAD_TOKEN__|${LEAD_TOKEN}|g" \
  -e "s|__LEAD_SESSION_KEY__|${LEAD_SESSION_KEY}|g" \
  "$REMOTE_AGENT_SRC" > "$REMOTE_AGENT_DST"

# Verify no placeholders remain
if grep -q '__LEAD_' "$REMOTE_AGENT_DST"; then
  fatal "REMOTE-AGENT.md still contains unreplaced placeholders"
fi
info "REMOTE-AGENT.md installed"

# --- Step 3: Create team-roster.json ---
echo ""
echo "--- Configuring team-roster.json ---"

ROSTER_FILE="${WORKSPACE_DIR}/team-roster.json"
cat > "$ROSTER_FILE" <<EOF
{
  "description": "Team configuration. Lead gateway and auth for status reporting.",
  "lead_gateway": "${LEAD_GATEWAY}",
  "lead_token": "${LEAD_TOKEN}",
  "gateway_token": "${LEAD_TOKEN}",
  "lead_session_key": "${LEAD_SESSION_KEY}",
  "lead": "${LEAD_NAME}",
  "members": {}
}
EOF
info "team-roster.json created"

# --- Step 4: Create current-project.json ---
CURRENT_PROJECT="${WORKSPACE_DIR}/current-project.json"
if [[ ! -f "$CURRENT_PROJECT" ]]; then
  cat > "$CURRENT_PROJECT" <<EOF
{
  "projectId": null,
  "leadGateway": "${LEAD_GATEWAY}",
  "projectName": null,
  "repo": null,
  "branch": null,
  "lastReported": null,
  "configProfile": null,
  "configApplied": null
}
EOF
  info "current-project.json created"
else
  info "current-project.json already exists (keeping)"
fi

# --- Step 5: Reachability + auth check ---
echo ""
echo "--- Testing connectivity to lead gateway ---"

INVOKE_HTTP_CODE=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" \
  -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{}' 2>/dev/null || echo "000")

if [[ "$INVOKE_HTTP_CODE" == "400" ]]; then
  info "Gateway HTTP reachability works via ${LEAD_GATEWAY}/tools/invoke"
elif [[ "$INVOKE_HTTP_CODE" == "401" ]] || [[ "$INVOKE_HTTP_CODE" == "403" ]]; then
  error "Lead gateway is reachable but auth failed (HTTP ${INVOKE_HTTP_CODE})"
  fatal "Setup incomplete — fix the gateway token and re-run"
else
  error "Cannot reach lead gateway at ${LEAD_GATEWAY}"
  error "Tried HTTP probe: ${LEAD_GATEWAY}/tools/invoke"
  error "Possible causes:"
  error "  - Tailscale not connected"
  error "  - Lead's gateway not running"
  error "  - Wrong gateway token"
  error "  - Wrong Serve URL or remote host:port"
  echo ""
  fatal "Setup incomplete — fix connectivity and re-run"
fi

# --- Step 6: Test actual tool invocation ---
echo ""
echo "--- Testing tool access ---"

SESSION_RESPONSE=$(curl -sS --max-time 10 -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"tool\":\"sessions_send\",\"sessionKey\":\"${LEAD_SESSION_KEY}\",\"args\":{\"sessionKey\":\"${LEAD_SESSION_KEY}\",\"message\":\"[setup] Connectivity check from ${AGENT_NAME}\",\"timeoutSeconds\":0}}" 2>/dev/null || echo '{"error":"connection_failed"}')

if echo "$SESSION_RESPONSE" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  info "sessions_send works — the lead should see a one-time setup ping"
elif echo "$SESSION_RESPONSE" | grep -q 'connection_failed'; then
  error "sessions_send failed — could not connect"
  fatal "Setup incomplete — fix connectivity and re-run"
elif echo "$SESSION_RESPONSE" | grep -q '"not_found"'; then
  error "sessions_send is blocked on the lead gateway"
  error "Lead needs gateway.tools.allow=[\"sessions_send\"] and tools.sessions.visibility=\"agent\""
  fatal "Setup incomplete — fix the lead gateway config and re-run"
else
  error "sessions_send returned unexpected response: ${SESSION_RESPONSE:0:200}"
  fatal "Setup incomplete — fix the lead gateway config and re-run"
fi

TEAM_LEAD_RESPONSE=$(curl -sS --max-time 10 -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"tool\":\"team_lead_list_projects\",\"sessionKey\":\"${LEAD_SESSION_KEY}\",\"args\":{}}" 2>/dev/null || echo '{"error":"connection_failed"}')

if echo "$TEAM_LEAD_RESPONSE" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
  info "team_lead_* tools are available on the lead gateway"
elif echo "$TEAM_LEAD_RESPONSE" | grep -q '"not_found"'; then
  warn "team_lead_* tools are not available yet"
  warn "Transport is working; the lead still needs the team-lead extension loaded"
else
  warn "team_lead_list_projects returned: ${TEAM_LEAD_RESPONSE:0:200}"
fi

# --- Done ---
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installed:"
echo "  - 6 skills in ${SKILLS_DIR}/"
echo "  - REMOTE-AGENT.md in ${WORKSPACE_DIR}/"
echo "  - team-roster.json in ${WORKSPACE_DIR}/"
echo "  - lead session key: ${LEAD_SESSION_KEY}"
echo ""
echo "Your agent (${AGENT_NAME}) can now:"
echo "  - Report status:  /report-status --new \"project\" \"description\""
echo "  - Send heartbeat: /heartbeat"
echo "  - Check team:     /check-team"
echo ""
echo "Tell the lead your hooks token so they can send you tasks."
echo ""
