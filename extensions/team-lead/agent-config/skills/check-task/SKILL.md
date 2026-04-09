---
name: check-task
description: "Check the status or result of a previously sent task. Use when: user wants to see if a remote agent finished, get results from a task, or review task history. Usage: /check-task <person-name> --latest or /check-task --history"
user-invocable: true
metadata: { "openclaw": { "emoji": "🔍", "requires": { "bins": ["curl"] } } }
---

# check-task — Check Status of a Remote Agent Task

Checks on previously sent tasks by querying the session on the remote gateway. Uses `sessions_send` via `/tools/invoke` to ping the session and get a response.

## Arguments

- `<person-name> --latest` — Look up the most recent task sent to this person from the task log and check its session
- `<person-name> --session <name>` — Check a specific named session (e.g., `deploy`, `bugfix`)
- `--history` — Show recent task history from the log

## Steps

### Step 1: Determine What to Check

**If `--history` is used:**

- Read `~/.openclaw/workspace/task-log.jsonl`
- Show the last 10 entries in a table: timestamp, to, sessionKey, message preview, mode

**If person name with `--latest`:**

- Read `~/.openclaw/workspace/task-log.jsonl`
- Find the most recent entry where `to` matches the person name
- Use that entry's `sessionKey`

**If person name with `--session <name>`:**

- Build the session key as `hook:<person-name>-<name>`

### Step 2: Load the Team Roster

Read `~/.openclaw/workspace/team-roster.json` to get the gateway URL and `gateway_token` for the person. The `gateway_token` is required for `/tools/invoke` calls. If only `hooks_token` is available, tell the user that `gateway_token` is needed in the roster for this skill to work.

### Step 3: Query the Session

If we have a `sessionKey`, use `sessions_send` via `/tools/invoke` to ask the remote agent about the task status:

```bash
curl -sS -X POST "<gateway-url>/tools/invoke" \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "sessions_send",
    "args": {
      "sessionKey": "<session-key>",
      "message": "What is the status of your current task? Briefly summarize what you have done and whether you are finished.",
      "timeoutSeconds": 30
    }
  }'
```

The response includes the agent's reply:

```json
{
  "ok": true,
  "result": {
    "status": "ok",
    "reply": "The agent's status update",
    "sessionKey": "hook:..."
  }
}
```

If no `sessionKey` is available (task was sent as fire-and-forget without `--continue` or `--wait`), tell the user the session key is unknown. Suggest using `--wait` or `--continue` with `/send-task` next time.

### Step 4: Report Back

Display:

- **Person:** who the task was sent to
- **Session:** the session key
- **Response:** the remote agent's reply
- **Original task:** from the task log entry (message preview)
- **Sent at:** timestamp from task log

## Troubleshooting

- **"No task log found":** No tasks have been sent yet. Use `/send-task` first.
- **"No entry for this person":** No tasks sent to this person in the log.
- **"Connection refused":** Remote gateway is down.
- **"No session key":** Task was sent without `--continue` or `--wait`, so there's no known session to query. Use those flags next time.
- **Timeout:** The agent may be busy processing. Try again in a moment.
