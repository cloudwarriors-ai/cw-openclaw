# Team Agent Setup

This directory contains everything a remote agent needs to join the team and communicate with the lead's gateway.

## Quick Start

```bash
cd extensions/team-lead/agent-config
./setup.sh \
  --lead-gateway "https://lead-host.tailnet.ts.net" \
  --lead-token "$OPENCLAW_GATEWAY_TOKEN" \
  --lead-session-key "agent:main:main" \
  --lead-mcp "http://lead-host.tailnet:8400/mcp" \
  --agent-name "$(hostname -s | tr '[:upper:]' '[:lower:]')"
```

Or run `./setup.sh` with no flags for interactive mode.

## What gets installed

| File                 | Location                 | Purpose                                                                                         |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| 6 skill files        | `~/.openclaw/skills/`    | Slash commands: /report-status, /heartbeat, /check-team, /check-task, /send-task, /apply-config |
| REMOTE-AGENT.md      | `~/.openclaw/workspace/` | Instructions for how to report to the lead gateway (with concrete curl commands)                |
| team-roster.json     | `~/.openclaw/workspace/` | Lead gateway URL, gateway token, and lead session key                                           |
| current-project.json | `~/.openclaw/workspace/` | Tracks the active project being worked on                                                       |

## What this does NOT install

The **team-lead extension** (the TypeScript plugin in the parent directory) runs on the **lead's machine only**. Remote agents don't need it. They communicate with the lead via HTTP using the skills and REMOTE-AGENT.md installed by this script.

## Prerequisites

- `~/.openclaw/` directory must exist (OpenClaw installed)
- Tailscale connected to the team tailnet
- Lead's gateway must be running
- If the lead uses Tailscale Serve, use the Serve URL here and keep the gateway loopback-bound on the lead machine
- If the lead uses a raw tailnet host:port instead, make sure that port is actually reachable from other machines

## Lead-side Requirements

Modern `/tools/invoke` usage needs these lead-side settings:

```json
{
  "gateway": { "tools": { "allow": ["sessions_send"] } },
  "tools": { "sessions": { "visibility": "agent" } }
}
```

## Verification

The setup script tests connectivity automatically:

1. HTTP reachability and auth on `/tools/invoke`
2. A real `sessions_send` ping into the lead session
3. An optional `team_lead_list_projects` probe if the extension is loaded

If it says `sessions_send works`, the transport path to the lead is ready. If the final `team_lead_*` probe warns, the gateway path is still good and the lead just needs the `team-lead` extension loaded.

If something fails, check:

1. Is Tailscale connected? (`tailscale status`)
2. Is the lead's gateway running?
3. Is the gateway token correct?
4. Does the lead allow `sessions_send` over `/tools/invoke`?
5. On macOS, if the service is loaded but not responding, try `openclaw gateway start` or `launchctl kickstart -kp gui/$UID/ai.openclaw.gateway`

The script intentionally avoids `openclaw gateway health` for first-time remote setup, because remote unpaired clients can be rejected even when the HTTP tool path is working correctly.

After setup, test with:

```
/report-status --new "Setup Test" "Verifying team connectivity"
```
