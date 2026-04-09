---
name: send-task
description: "Send a task or message to a remote agent over Tailscale using webhooks. Use when: user wants to assign work to another agent, send a message to a teammate's bot, or communicate with a remote OpenClaw instance. Usage: /send-task <person-name> [--wait] [--continue [session-name]] <message>"
user-invocable: true
metadata: { "openclaw": { "emoji": "📡", "requires": { "bins": ["curl"] } } }
---

# send-task — Send a Task to a Remote Agent via Webhook

Sends a message to a remote OpenClaw agent over Tailscale. The remote agent wakes up, processes the message with its AI model, and does the work. This is real agent-to-agent communication — both sides have a full AI agent that thinks.

## Arguments

- `<person-name>` — Name of the person/agent to send to (must be in team-roster.json)
- `<message>` — The task or message to send
- `--wait` — (Optional) Block and wait for the remote agent's response instead of fire-and-forget. Times out after 60 seconds.
- `--continue [session-name]` — (Optional) Send into a named persistent session. The remote agent remembers previous messages in that session. If no name is given, uses "default". Examples: `--continue deploy`, `--continue bugfix`, `--continue` (uses "default").

## How It Works

**Fire-and-forget (default):**

1. Look up the person in `~/.openclaw/workspace/team-roster.json`
2. POST to their gateway's `/hooks/agent` endpoint
3. Their agent receives the message, wakes up, and processes it independently
4. Log the task to `~/.openclaw/workspace/task-log.jsonl` for tracking

**With `--wait` (synchronous):**

1. Look up the person in the roster
2. Use `/tools/invoke` with the `sessions_send` tool instead of `/hooks/agent`
3. `sessions_send` sends the message into a session and blocks until the agent responds
4. The agent's actual reply is returned directly

## Steps

### Step 1: Parse Arguments

Parse the arguments to extract:

- `person-name` — always the first argument
- `--wait` — if present, will block for response
- `--continue [name]` — if present, use persistent session. The word after `--continue` is the session name ONLY if it doesn't start with `--` and isn't the message. If no session name follows, use "default".
- `message` — everything remaining after flags are extracted

### Step 2: Load the Team Roster

Read `~/.openclaw/workspace/team-roster.json` to find the recipient's gateway URL and tokens.

The roster has this format:

```json
{
  "members": {
    "name": {
      "gateway": "http://hostname:port",
      "hooks_token": "token-for-hooks-endpoint",
      "gateway_token": "token-for-tools-invoke-endpoint",
      "tailscale_ip": "100.x.y.z"
    }
  }
}
```

**Two tokens serve different purposes:**

- `hooks_token` — used for `POST /hooks/agent` (fire-and-forget dispatch)
- `gateway_token` — used for `POST /tools/invoke` (synchronous calls like `--wait`)

If only `hooks_token` is present and `--wait` was requested, fall back to fire-and-forget mode and tell the user that `gateway_token` is needed in the roster for `--wait` to work.

If the person isn't in the roster, tell the user and ask for their Tailscale hostname, gateway port, and hooks token.

If the person has `"status": "not-configured"` in their roster entry, tell the user that person hasn't enabled hooks yet and explain what they need to do (see Adding New Team Members section).

### Step 3: Verify Connectivity

```bash
curl -sS --connect-timeout 5 "<gateway-url>/health"
```

If this fails, the remote gateway is down or unreachable. Tell the user.

### Step 4: Build the Session Key

- **No `--continue`:** Don't include a `sessionKey` in the payload. Each task gets a fresh isolated session.
- **`--continue` without name:** Use `sessionKey: "hook:<person-name>-default"`
- **`--continue <name>`:** Use `sessionKey: "hook:<person-name>-<name>"`

Examples:

- `/send-task gerald "do something"` → no sessionKey (fresh session)
- `/send-task gerald --continue "follow up"` → `hook:gerald-default`
- `/send-task gerald --continue deploy "check status"` → `hook:gerald-deploy`

### Step 5: Send the Task

Choose the method based on whether `--wait` was used:

#### 5a: Fire-and-forget (no `--wait`)

Use `/hooks/agent` — sends the task and returns immediately:

```bash
curl -sS -X POST "<gateway-url>/hooks/agent" \
  -H "Authorization: Bearer <hooks-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "<the message or task>",
    "agentId": "main",
    "name": "task-from-daniel"
  }'
```

If using a persistent session (`--continue`), add `"sessionKey": "<session-key>"` to the JSON payload.

A successful response looks like:

```json
{ "ok": true, "runId": "some-uuid" }
```

Save the `runId` from the response.

#### 5b: Synchronous with response (`--wait`)

Use `/tools/invoke` with the `sessions_send` tool — this sends a message into a session and **blocks until the agent responds**, returning the actual reply:

First, determine the session key:

- If `--continue` was used: use the session key from Step 4
- If no `--continue`: generate one as `hook:send-task-<person-name>-<timestamp>` so we have a known key for the session

```bash
curl -sS -X POST "<gateway-url>/tools/invoke" \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "sessions_send",
    "args": {
      "sessionKey": "<session-key>",
      "message": "<the message or task>",
      "timeoutSeconds": 30
    }
  }'
```

The response includes the agent's reply:

```json
{
  "ok": true,
  "result": {
    "runId": "uuid",
    "status": "ok",
    "reply": "The agent's actual response text",
    "sessionKey": "hook:...",
    "delivery": { "status": "sent", "mode": "session" }
  }
}
```

- If `status` is `"ok"` and `reply` is present: display the reply to the user
- If `status` is `"timeout"`: tell the user the agent is still working, provide the session key for follow-up
- If `status` is `"error"`: report the error

**Note:** `sessions_send` with `timeoutSeconds: 30` will block for up to 30 seconds waiting for the agent to finish. If the task takes longer, it returns `"accepted"` or `"timeout"` status — the agent is still working but didn't finish in time. The user can follow up with `--continue` using the same session key.

### Step 6: Log the Task

Append an entry to `~/.openclaw/workspace/task-log.jsonl`:

```bash
echo '{"timestamp":"<ISO-NOW>","to":"<person-name>","runId":"<runId>","sessionKey":"<session-key-or-null>","message":"<first-80-chars-of-message>","mode":"<wait|fire-and-forget>"}' >> ~/.openclaw/workspace/task-log.jsonl
```

This creates an audit trail and enables `/check-task --latest`.

### Step 7: Report Back

**Fire-and-forget mode (no `--wait`):**

- The task was sent successfully
- The run ID (for tracking with `/check-task <runId>`)
- That the remote agent is now processing it independently
- If using `--continue`, mention which session it was sent to

**Wait mode (`--wait`):**

- The remote agent's actual response (from `reply` field)
- The session key used
- If it timed out: explain the agent is still working and suggest following up with `--continue`

## Optional: Send with Channel Delivery

If you want the remote agent to post its response to a Discord/Slack channel:

```bash
curl -sS -X POST "<gateway-url>/hooks/agent" \
  -H "Authorization: Bearer <hooks-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "<the message or task>",
    "agentId": "main",
    "name": "task-from-daniel",
    "deliver": true,
    "channel": "discord",
    "to": "<channel-id>"
  }'
```

## Adding New Team Members

To add someone to the roster, update `~/.openclaw/workspace/team-roster.json`:

```json
{
  "name": {
    "gateway": "http://<their-tailscale-hostname>:18789",
    "hooks_token": "<their-hooks-token>",
    "tailscale_ip": "<their-tailscale-ip>"
  }
}
```

The person needs hooks enabled in their openclaw.json:

```json
{
  "hooks": {
    "enabled": true,
    "token": "<their-hooks-token>",
    "allowRequestSessionKey": true,
    "allowedAgentIds": ["*"],
    "mappings": [{ "action": "agent", "agentId": "main", "name": "remote-task" }]
  }
}
```

## Troubleshooting

- **Connection refused:** Remote gateway is down. Ask the person to check their OpenClaw.
- **401 Unauthorized:** Wrong hooks token. Check the roster.
- **404 Not Found:** Hooks not enabled on the remote instance. They need to add hooks config.
- **Person not in roster:** Ask the user for their Tailscale hostname and hooks token, then add them.
- **Timeout on `--wait`:** The agent is still working. Follow up with `--continue` using the same session name.
- **`sessions_send` returns error:** The remote agent hit an error during processing. Check the error message.
