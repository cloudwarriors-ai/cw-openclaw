# Team Agent Setup

This directory contains everything a remote agent needs to join the team and communicate with the lead's gateway.

## Quick Start

```bash
cd extensions/team-lead/agent-config
./setup.sh \
  --lead-gateway "http://daniels-macbook-pro.tailcc6c5f.ts.net:18789" \
  --lead-token "7473becb31f9da2ba22763f3c6d893219941ab3dd8833b4a" \
  --agent-name "$(hostname -s | tr '[:upper:]' '[:lower:]')"
```

Or run `./setup.sh` with no flags for interactive mode.

## What gets installed

| File                 | Location                 | Purpose                                                                                         |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| 6 skill files        | `~/.openclaw/skills/`    | Slash commands: /report-status, /heartbeat, /check-team, /check-task, /send-task, /apply-config |
| REMOTE-AGENT.md      | `~/.openclaw/workspace/` | Instructions for how to report to the lead gateway (with concrete curl commands)                |
| team-roster.json     | `~/.openclaw/workspace/` | Lead gateway URL and auth token                                                                 |
| current-project.json | `~/.openclaw/workspace/` | Tracks the active project being worked on                                                       |

## What this does NOT install

The **team-lead extension** (the TypeScript plugin in the parent directory) runs on the **lead's machine only**. Remote agents don't need it. They communicate with the lead via HTTP using the skills and REMOTE-AGENT.md installed by this script.

## Prerequisites

- `~/.openclaw/` directory must exist (OpenClaw installed)
- Tailscale connected to the team tailnet
- Lead's gateway must be running and bound to a non-loopback interface

## Verification

The setup script tests connectivity automatically. If it says "Tool invocation works", you're good. If not, check:

1. Is Tailscale connected? (`tailscale status`)
2. Is the lead's gateway running?
3. Is the lead's gateway bound to `0.0.0.0` (not `loopback`)?

After setup, test with:

```
/report-status --new "Setup Test" "Verifying team connectivity"
```
