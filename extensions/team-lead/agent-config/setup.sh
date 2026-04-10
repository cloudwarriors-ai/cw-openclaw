#!/usr/bin/env bash
set -euo pipefail

# Team Lead Agent Config Setup
# Installs skills, REMOTE-AGENT.md, and configures openclaw.json for team participation.
#
# Usage:
#   ./setup.sh                          # Interactive — prompts for values
#   ./setup.sh --lead-gateway URL       # Non-interactive with flags
#
# Prerequisites:
#   - OpenClaw installed and configured (~/.openclaw/openclaw.json exists)
#   - Tailscale connected to team tailnet
#   - gh CLI authenticated (for PR features)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OPENCLAW_DIR="${HOME}/.openclaw"
OPENCLAW_JSON="${OPENCLAW_DIR}/openclaw.json"
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
      echo "Installs team-lead agent skills and configures your OpenClaw instance"
      echo "for team participation."
      echo ""
      echo "Options:"
      echo "  --lead-gateway URL    Lead agent's gateway URL (e.g. http://host:18789)"
      echo "  --lead-token TOKEN    Auth token for the lead gateway"
      echo "  --lead-mcp URL        Lead's MCP URL (default: derived from gateway with port 8400)"
      echo "  --lead-name NAME      Lead's name (default: 'daniel')"
      echo "  --agent-name NAME     Your agent name (defaults to hostname)"
      exit 0
      ;;
    *) fatal "Unknown flag: $1. Use --help for usage." ;;
  esac
done

# --- Preflight checks ---
echo ""
echo "=== Team Lead Agent Config Setup ==="
echo ""

if [[ ! -f "$OPENCLAW_JSON" ]]; then
  fatal "OpenClaw not configured. Run 'openclaw configure' first."
fi
info "OpenClaw config found at $OPENCLAW_JSON"

if ! command -v jq &>/dev/null; then
  fatal "jq is required. Install with: brew install jq"
fi

# --- Gather inputs ---
if [[ -z "$AGENT_NAME" ]]; then
  DEFAULT_NAME="$(hostname -s | tr '[:upper:]' '[:lower:]')"
  read -rp "Agent name [$DEFAULT_NAME]: " AGENT_NAME
  AGENT_NAME="${AGENT_NAME:-$DEFAULT_NAME}"
fi

if [[ -z "$LEAD_GATEWAY" ]]; then
  read -rp "Lead gateway URL (e.g. http://daniels-macbook-pro.tailcc6c5f.ts.net:18789): " LEAD_GATEWAY
fi

if [[ -z "$LEAD_GATEWAY" ]]; then
  fatal "Lead gateway URL is required."
fi

if [[ -z "$LEAD_TOKEN" ]]; then
  read -rp "Lead gateway auth token: " LEAD_TOKEN
fi

if [[ -z "$LEAD_TOKEN" ]]; then
  fatal "Lead gateway auth token is required."
fi

# Derive MCP URL from gateway if not provided (replace port with 8400, append /mcp)
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

  if [[ -f "$dst" ]]; then
    if diff -q "$src" "$dst" &>/dev/null; then
      info "$skill — already up to date"
    else
      cp "$src" "$dst"
      info "$skill — updated"
    fi
  else
    cp "$src" "$dst"
    info "$skill — installed"
  fi
done

# --- Step 2: Install REMOTE-AGENT.md ---
echo ""
echo "--- Installing REMOTE-AGENT.md ---"

mkdir -p "$WORKSPACE_DIR"
REMOTE_AGENT_SRC="${SCRIPT_DIR}/REMOTE-AGENT.md"
REMOTE_AGENT_DST="${WORKSPACE_DIR}/REMOTE-AGENT.md"

if [[ ! -f "$REMOTE_AGENT_SRC" ]]; then
  warn "REMOTE-AGENT.md source missing (skipping)"
else
  # Replace all placeholders with actual values
  sed \
    -e "s|__LEAD_GATEWAY__|${LEAD_GATEWAY}|g" \
    -e "s|__LEAD_MCP__|${LEAD_MCP}|g" \
    -e "s|__LEAD_TOKEN__|${LEAD_TOKEN}|g" \
    "$REMOTE_AGENT_SRC" > "$REMOTE_AGENT_DST"
  info "REMOTE-AGENT.md installed (gateway: ${LEAD_GATEWAY}, mcp: ${LEAD_MCP})"
fi

# --- Step 3: Create/update team-roster.json ---
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

# --- Step 4: Register the team-lead extension ---
echo ""
echo "--- Registering team-lead extension ---"

# Check if the extension code is accessible
if [[ ! -f "${EXTENSION_DIR}/index.ts" ]] && [[ ! -f "${EXTENSION_DIR}/index.js" ]]; then
  warn "team-lead extension code not found at ${EXTENSION_DIR}"
  warn "The team-lead plugin requires the extension to be built."
fi

# Check if node_modules exist (extension needs to be installed)
if [[ ! -d "${EXTENSION_DIR}/node_modules" ]]; then
  warn "team-lead extension dependencies not installed."
  echo "  Run: cd ${EXTENSION_DIR} && npm install"
fi

# Add team-lead to plugins with the extension path so OpenClaw can find it
if jq -e '.plugins.entries["team-lead"]' "$OPENCLAW_JSON" &>/dev/null; then
  info "team-lead plugin already configured"
else
  # Backup
  cp "$OPENCLAW_JSON" "${OPENCLAW_JSON}.backup.$(date +%s)"
  info "Backed up openclaw.json"

  jq --arg path "$EXTENSION_DIR" \
    '.plugins.entries["team-lead"] = {"enabled": true, "path": $path}' \
    "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp" \
    && mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"
  info "team-lead plugin enabled (path: ${EXTENSION_DIR})"
fi

# --- Step 5: Update openclaw.json — gateway tools ---
echo ""
echo "--- Updating openclaw.json ---"

# Add doc tools to gateway allow-list if gateway exists
if jq -e '.gateway.tools.allow' "$OPENCLAW_JSON" &>/dev/null; then
  TOOLS_TO_ADD=("team_lead_upload_doc" "team_lead_get_docs")
  for tool in "${TOOLS_TO_ADD[@]}"; do
    if jq -e --arg t "$tool" '.gateway.tools.allow | index($t)' "$OPENCLAW_JSON" &>/dev/null; then
      info "Gateway tool $tool already in allow-list"
    else
      jq --arg t "$tool" '.gateway.tools.allow += [$t]' "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp" \
        && mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"
      info "Added $tool to gateway allow-list"
    fi
  done
else
  info "No gateway configured (normal for remote agents)"
fi

# Add team-lead to agent tools allow-list
if jq -e '.agents.list[0].tools.alsoAllow' "$OPENCLAW_JSON" &>/dev/null; then
  if jq -e '.agents.list[0].tools.alsoAllow | index("team-lead")' "$OPENCLAW_JSON" &>/dev/null; then
    info "team-lead already in agent tools allow-list"
  else
    jq '.agents.list[0].tools.alsoAllow += ["team-lead"]' "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp" \
      && mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"
    info "Added team-lead to agent tools allow-list"
  fi
fi

# Enable hooks if not already enabled
if jq -e '.hooks.enabled == true' "$OPENCLAW_JSON" &>/dev/null; then
  info "Hooks already enabled"
else
  warn "Hooks not enabled. The lead needs your hooks token to send you tasks."
  warn "Run 'openclaw configure' and enable hooks, then share your token with the lead."
fi

# --- Step 6: Create current-project.json template ---
echo ""
echo "--- Setting up workspace ---"

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
  info "current-project.json template created"
else
  info "current-project.json already exists"
fi

# --- Step 7: Connectivity check ---
echo ""
echo "--- Testing connectivity ---"

if curl -sS --max-time 5 -o /dev/null -w "%{http_code}" \
  "${LEAD_GATEWAY}/health" 2>/dev/null | grep -q "200"; then
  info "Lead gateway reachable"
else
  warn "Could not reach lead gateway at ${LEAD_GATEWAY}"
  warn "Make sure Tailscale is connected and the lead's gateway is running"
fi

# --- Done ---
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Installed:"
echo "  - 6 skills in ${SKILLS_DIR}/"
echo "  - REMOTE-AGENT.md in ${WORKSPACE_DIR}/"
echo "  - team-roster.json in ${WORKSPACE_DIR}/"
echo "  - team-lead extension registered from ${EXTENSION_DIR}"
echo ""
echo "Next steps:"
echo "  1. Install extension dependencies: cd ${EXTENSION_DIR} && npm install"
echo "  2. Make sure Tailscale is connected to the team tailnet"
echo "  3. If hooks aren't enabled, run 'openclaw configure' and enable them"
echo "  4. Share your hooks token with the lead so they can add you to the roster"
echo "  5. Test with: /report-status --new \"test\" \"Testing team connectivity\""
echo ""
