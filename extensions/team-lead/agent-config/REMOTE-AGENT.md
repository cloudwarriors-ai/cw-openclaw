# Team Status Reporting

You are part of a team. You have two ways to report status:

1. **Notify the lead** — send a signal to the lead agent's gateway (quick, fire-and-forget)
2. **Log to the team MCP** — create/update tasks in the shared task tracker (persistent, queryable)

Do both when you make meaningful progress.

## Gateway URL and Auth

- **Gateway:** `http://geralds-macbook-pro.tailcc6c5f.ts.net:18789`
- **MCP:** `http://geralds-macbook-pro.tailcc6c5f.ts.net:8400/mcp`
- **Auth token:** `4c5d25693d05a27341b55cc650d008d66b37673fd13e4e4b`

---

## 1. Notify the Lead (sessions_send)

Sends a message to the lead agent's session. The lead sees it immediately.

```bash
curl -sS http://geralds-macbook-pro.tailcc6c5f.ts.net:18789/tools/invoke \
  -H 'Authorization: Bearer 4c5d25693d05a27341b55cc650d008d66b37673fd13e4e4b' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_send",
    "args": {
      "sessionKey": "main",
      "message": "{\"type\":\"status_update\",\"from\":\"YOUR_NAME\",\"project\":\"PROJECT_NAME\",\"signal\":\"SIGNAL\",\"summary\":\"ONE_LINE_SUMMARY\",\"timestamp\":\"ISO_TIMESTAMP\"}",
      "timeoutSeconds": 0
    }
  }'
```

### Signal Values

- `progress` — made meaningful progress
- `blocked` — stuck, need help
- `complete` — finished a task or milestone
- `needs_review` — ready for review
- `deployed` — shipped to staging or production

---

## 2. Log to Team MCP (persistent task tracking)

The MCP uses Streamable HTTP. Every call needs an MCP session: initialize first, then call tools with the session ID.

### Step 1: Initialize a session

```bash
SESSION_ID=$(curl -sS -X POST http://geralds-macbook-pro.tailcc6c5f.ts.net:8400/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"remote-agent","version":"0.1"}}}' \
  -D /dev/stderr 2>&1 1>/dev/null | grep -i 'mcp-session-id' | awk '{print $2}' | tr -d '\r')
```

### Step 2: Create or update a task

```bash
curl -sS -X POST http://geralds-macbook-pro.tailcc6c5f.ts.net:8400/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "task_upsert_tool",
      "arguments": {
        "api_key": "4c5d25693d05a27341b55cc650d008d66b37673fd13e4e4b",
        "task_uuid": "UNIQUE_TASK_ID",
        "project_id": "PROJECT_NAME",
        "agent_id": "YOUR_NAME",
        "title": "Short task title",
        "status": "running",
        "summary": "What you are doing",
        "is_current": true
      }
    }
  }'
```

**Status values:** `queued`, `running`, `blocked`, `completed`, `cancelled`

### Step 3: Add a note to a task

```bash
curl -sS -X POST http://geralds-macbook-pro.tailcc6c5f.ts.net:8400/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "task_note_add_tool",
      "arguments": {
        "api_key": "4c5d25693d05a27341b55cc650d008d66b37673fd13e4e4b",
        "task_uuid": "UNIQUE_TASK_ID",
        "agent_id": "YOUR_NAME",
        "content": "Finished the auth endpoints. Moving to integration tests."
      }
    }
  }'
```

---

## 3. Config Profiles

Tasks assigned by the lead may include a `configProfile` — a reference to a config bundle from the `cw-ai-configs` repo (e.g. `personal/chad`, `templates/django`, `projects/zoomwarriors`). This config provides project-specific skills, rules, and settings.

### Prerequisites

You need the `cw-ai-configs` repo cloned on your machine:

```bash
gh repo clone cloudwarriors-ai/cw-ai-configs ~/repos/cw-ai-configs
```

### When to apply

When you receive a task with a `configProfile`:

1. The task response (from `team_lead_start_task` or `team_lead_assign_task`) includes a `configProfile` field
2. Run `/apply-config <profile>` to pull and apply the config
3. The config installs skills, rules, and settings into your current project directory

### Available bundles

- `personal/chad`, `personal/trent`, `personal/matt` — personal agent profiles
- `projects/zoomwarriors`, `projects/cloudwarriors-team-default`, etc. — project-specific configs
- `templates/django`, `templates/react-vite` — stack templates
- `_standards` — team-wide baseline

### Cleanup

When you finish a task (`/report-status --status completed`), the config is automatically cleaned up via `team-ai remove`.

---

## 4. Check Existing Architecture Docs

When you start a new task, check if previous agents documented the architecture for this repo. This gives you context on patterns, decisions, and pitfalls.

**Note:** If you received `existingDocs` in the `team_lead_start_task` response, those are the docs — you already have the metadata. Skip to "Read a specific doc" below.

### Find docs for your repo

```bash
curl -sS ${GATEWAY_URL}/tools/invoke \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "team_lead_get_docs",
    "args": {
      "repo": "org/repo-name"
    }
  }'
```

Replace `org/repo-name` with the actual repo (e.g. `cloudwarriors-ai/zoomwarriors_2`).

### Read a specific doc

```bash
curl -sS ${GATEWAY_URL}/tools/invoke \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "team_lead_get_docs",
    "args": {
      "projectId": "<projectId from doc metadata>",
      "slug": "<slug from doc metadata>"
    }
  }'
```

If docs exist for your repo, **read them before starting work**. They contain architecture decisions and patterns from previous work that you should follow or build on — not contradict.

---

## When to Report

- **Notify the lead** — when you need immediate attention (blocked, needs_review) or want to flag a milestone
- **Log to MCP** — whenever you start, update, or finish a task. This is the persistent record.
- Do both for important events. The notification is instant; the MCP entry is the audit trail.
- You do NOT need to report every small step — use judgment

---

## Workflow Example

Starting a new task:

1. Create the task in MCP with `status: "running"`, `is_current: true`
2. Check for existing architecture docs for this repo (Section 4)
3. Apply config profile if assigned (Section 3)
4. Read relevant architecture docs to understand existing patterns
5. Notify the lead with `signal: "progress"`

Getting blocked:

1. Update the task in MCP with `status: "blocked"`
2. Add a note explaining what's wrong
3. Notify the lead with `signal: "blocked"`

Finishing:

1. Update the task in MCP with `status: "completed"`
2. Notify the lead with `signal: "complete"`
