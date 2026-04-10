---
name: check-team
description: "Check which team members are online and reachable over Tailscale. Use when: user wants to see who's available, check connectivity before sending a task, or verify the team roster. Usage: /check-team"
user-invocable: true
metadata: { "openclaw": { "emoji": "👥", "requires": { "bins": ["curl"] } } }
---

# check-team — Check Team Member Connectivity

Pings each team member's gateway to see who's online and reachable. Reads the team roster and checks whether the HTTP `/tools/invoke` endpoint responds, which works with both raw host:port URLs and Tailscale Serve URLs.

## Arguments

None required. Optionally: `/check-team <person-name>` to check just one person.

## Steps

### Step 1: Load the Team Roster

Read `~/.openclaw/workspace/team-roster.json`.

### Step 2: Check Each Member

For each member in the roster (or just the specified person):

```bash
curl -sS --connect-timeout 3 -o /dev/null -w "%{http_code}" \
  -X POST "<gateway-url>/tools/invoke" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Record the result:

- **Online:** Any HTTP response is returned (for example `400` or `401`)
- **Offline:** Connection refused, timed out, or error

If a member has `"status": "not-configured"`, mark them as "Not configured (hooks not enabled)" without pinging.

### Step 3: Report Results

Display a table:

```
| Name     | Status          | Gateway                                           |
|----------|-----------------|---------------------------------------------------|
| gerald   | Online          | https://geralds-macbook-pro.tailnet.ts.net        |
| dev-test | Offline         | ws://127.0.0.1:19001                              |
| chad     | Not configured  | https://chads-macbook-pro.tailnet.ts.net          |
```

If everyone is offline, suggest checking Tailscale connectivity (`tailscale status`).

## Troubleshooting

- **All offline:** Check if Tailscale is connected: `tailscale status`
- **Specific person offline:** Their gateway may not be running. Ask them to start OpenClaw.
- **"Not configured":** That person hasn't enabled hooks yet. They need to add hooks config to their openclaw.json.
