---
name: heartbeat
description: Send a periodic heartbeat to the team lead's gateway, reporting agent health and capacity status.
---

# /heartbeat — Send Agent Heartbeat to Team Lead

Send a heartbeat signal to the team lead coordinator. Reports that this agent is alive, along with current capacity and active project list.

## Usage

- `/heartbeat` — send a single heartbeat with auto-detected capacity
- `/heartbeat --capacity idle|busy|at_capacity` — override capacity signal
- `/heartbeat --start` — begin sending heartbeats every 60 seconds (background)
- `/heartbeat --stop` — stop periodic heartbeats

## Procedure

### Step 1: Determine the lead gateway

Read `~/.openclaw/workspace/team-roster.json` and use the `lead_gateway` top-level field. Extract the gateway URL and auth token (`gateway_token` or `hooks_token`).

### Step 2: Gather agent info

- Agent name: from openclaw config agent ID or hostname
- Machine: from system hostname
- Capacity: auto-detect based on active sessions, or use `--capacity` flag
  - `idle` — no active work
  - `busy` — working but can take more
  - `at_capacity` — cannot take new work
- Active projects: read `~/.openclaw/workspace/current-project.json` and any other tracked project IDs

### Step 3: Send heartbeat

```bash
curl -sS -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "team_lead_heartbeat",
    "args": {
      "agentName": "<agent name>",
      "machine": "<hostname>",
      "capacity": "<idle|busy|at_capacity>",
      "activeProjects": ["proj_abc123"]
    }
  }'
```

### Step 4: Report result

Display acknowledgment. If the heartbeat fails, warn the user that the lead may mark this agent as unresponsive after 180 seconds.

## Notes

- The coordinator marks agents as `unresponsive` if no heartbeat is received for 180 seconds. Their active projects get flagged as `blocked`.
- When using `--start`, the agent should send a heartbeat immediately and then every 60 seconds.
- Capacity detection heuristic: if `current-project.json` exists with status `in_progress`, report `busy`. If no active projects, report `idle`.
