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
LEAD_NAME=""
AGENT_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lead-gateway) LEAD_GATEWAY="$2"; shift 2 ;;
    --lead-token)   LEAD_TOKEN="$2"; shift 2 ;;
    --lead-mcp)     LEAD_MCP="$2"; shift 2 ;;
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
      echo "  --lead-gateway URL    Lead's gateway URL (e.g. http://host.tailnet:18789)"
      echo "  --lead-token TOKEN    Auth token for the lead gateway"
      echo "  --lead-mcp URL        Lead's MCP URL (default: derived from gateway, port 8400)"
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
  read -rp "Lead gateway URL (e.g. http://daniels-macbook-pro.tailcc6c5f.ts.net:18789): " LEAD_GATEWAY
fi
[[ -z "$LEAD_GATEWAY" ]] && fatal "Lead gateway URL is required."

if [[ -z "$LEAD_TOKEN" ]]; then
  read -rp "Lead gateway auth token: " LEAD_TOKEN
fi
[[ -z "$LEAD_TOKEN" ]] && fatal "Lead gateway auth token is required."

# Derive MCP URL from gateway if not provided (swap port to 8400, append /mcp)
if [[ -z "$LEAD_MCP" ]]; then
  LEAD_MCP="$(echo "$LEAD_GATEWAY" | sed 's|:[0-9]*$|:8400|')/mcp"
  read -rp "Lead MCP URL [$LEAD_MCP]: " LEAD_MCP_INPUT
  LEAD_MCP="${LEAD_MCP_INPUT:-$LEAD_MCP}"
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

# --- Step 5: Connectivity check ---
echo ""
echo "--- Testing connectivity to lead gateway ---"

HTTP_CODE=$(curl -sS --max-time 10 -o /dev/null -w "%{http_code}" \
  "${LEAD_GATEWAY}/health" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "200" ]]; then
  info "Lead gateway reachable (HTTP 200)"
elif [[ "$HTTP_CODE" == "000" ]]; then
  error "Cannot reach lead gateway at ${LEAD_GATEWAY}"
  error "Possible causes:"
  error "  - Tailscale not connected"
  error "  - Lead's gateway not running"
  error "  - Lead's gateway bound to loopback (needs 0.0.0.0)"
  echo ""
  fatal "Setup incomplete — fix connectivity and re-run"
elif [[ "$HTTP_CODE" == "401" ]] || [[ "$HTTP_CODE" == "403" ]]; then
  warn "Lead gateway reachable but auth failed (HTTP ${HTTP_CODE})"
  warn "The gateway URL works but the token may be wrong"
else
  warn "Lead gateway returned HTTP ${HTTP_CODE} (expected 200)"
  warn "Gateway may be reachable but not healthy"
fi

# --- Step 6: Test actual tool invocation ---
echo ""
echo "--- Testing tool access ---"

TOOL_RESPONSE=$(curl -sS --max-time 10 -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"tool": "team_lead_list_projects", "args": {}}' 2>/dev/null || echo '{"error":"connection_failed"}')

if echo "$TOOL_RESPONSE" | grep -q '"ok"'; then
  info "Tool invocation works — agent can communicate with lead"
elif echo "$TOOL_RESPONSE" | grep -q 'connection_failed'; then
  error "Tool invocation failed — could not connect"
  fatal "Setup incomplete — fix connectivity and re-run"
else
  warn "Tool invocation returned unexpected response: ${TOOL_RESPONSE:0:200}"
  warn "Gateway is reachable but tools may not be configured correctly on the lead's side"
fi

# --- Done ---
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installed:"
echo "  - 6 skills in ${SKILLS_DIR}/"
echo "  - REMOTE-AGENT.md in ${WORKSPACE_DIR}/"
echo "  - team-roster.json in ${WORKSPACE_DIR}/"
echo ""
echo "Your agent (${AGENT_NAME}) can now:"
echo "  - Report status:  /report-status --new \"project\" \"description\""
echo "  - Send heartbeat: /heartbeat"
echo "  - Check team:     /check-team"
echo ""
echo "Tell the lead your hooks token so they can send you tasks."
echo ""
