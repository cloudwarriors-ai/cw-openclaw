---
name: deploy-bot
description: Deploy a new OpenClaw agent bot with its own extension, workspace, Zoom channel binding, and tool suite. Use when the user wants to create a new bot agent like pulsebot, bigheadbot, or zoomwarriorssupportbot.
argument-hint: [bot-name]
---

# Deploy a New Bot Agent

You are deploying a new OpenClaw agent bot called `$ARGUMENTS`. Follow this checklist precisely.

## Step 0: Gather Requirements

Before creating anything, ask the user for:

1. **Zoom channel JID** — the `...@conference.xmpp.zoom.us` JID to bind the bot to (or skip binding for now)
2. **GitHub repo** — which repo the bot's GitHub issue tools should be scoped to (e.g., `cloudwarriors-ai/some-repo`)
3. **Tool scope** — which tool categories to include:
   - **Full stack** (recommended): Project Pulse API + GitHub issues + DevTools (containers/logs/DB) + comfort messages
   - **PP + GitHub only**: Project Pulse + GitHub, no DevTools
   - **Read-only + GitHub**: Project Pulse read tools only + GitHub

Use the bot name `$ARGUMENTS` throughout. Derive a short tool prefix from the name (e.g., `zoomwarriorssupportbot` → `zws_`, `bigheadbot` → `bh_`, `pulsebot` → `pp_`).

## Step 1: Create the Extension

Create `extensions/$ARGUMENTS/` with these files:

### `openclaw.plugin.json`
```json
{
  "id": "$ARGUMENTS",
  "name": "<DisplayName>",
  "description": "<Bot purpose> break/fix research agent tools",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "<prefix>Repos": {
        "type": "array",
        "items": { "type": "string" },
        "default": ["<github-org/repo>"],
        "description": "GitHub repos scoped for issue management"
      }
    }
  }
}
```

### `index.ts` — Main entry point
- Import and register all tool modules
- Hook `message_received` event for comfort messages
- Log registration count on startup

### `src/audit.ts` — Audit logger
- Write tool calls to `{workspaceDir}/$ARGUMENTS/audit.jsonl`
- `wrapToolWithAudit()` wrapper for all tools
- Sanitize params over 200 chars
- Actor field set to `$ARGUMENTS`

### `src/<prefix>-auth.ts` — Project Pulse session management
- 3-step NextAuth login: CSRF token → POST credentials → verify session
- Cookie caching with 25-min TTL
- Auto-refresh on 401
- Env vars: `<PREFIX>_PROJECT_PULSE_URL`, `<PREFIX>_PROJECT_PULSE_EMAIL`, `<PREFIX>_PROJECT_PULSE_PASSWORD` with fallbacks to `PROJECT_PULSE_*`

### `src/<prefix>-api.ts` — HTTP client
- `<prefix>Fetch(path, opts)` with auto-retry on 401
- `jsonResult()` and `errorResult()` helpers

### `src/<prefix>-tools.ts` — 11 Project Pulse tools
All wrapped with audit logger. Tools:
1. `<prefix>_auth_status` — Check session
2. `<prefix>_list_projects` — List with filters (status, search, limit)
3. `<prefix>_get_project` — Get by ID
4. `<prefix>_list_tasks` — Filter by project, status, assignee
5. `<prefix>_get_task` — Get by ID
6. `<prefix>_list_tickets` — Filter by status, priority, project
7. `<prefix>_create_ticket` — Create with title, projectId, priority, assignee
8. `<prefix>_update_ticket` — Update fields by ID
9. `<prefix>_list_users` — Filter by role, search
10. `<prefix>_get_timesheets` — Filter by user, project, date range
11. `<prefix>_search` — Full-text search (query, type, limit)

### `src/gh-tools.ts` — 6 GitHub issue tools
- `<prefix>_gh_list_issues` — List with state/label filters
- `<prefix>_gh_get_issue` — Get with stakeholder extraction
- `<prefix>_gh_create_issue` — Create with stakeholder metadata block
- `<prefix>_gh_add_comment` — Auto-mention stakeholders
- `<prefix>_gh_search_issues` — Keyword search
- `<prefix>_gh_close_issue` — Close + comment + DM stakeholders on Zoom

### `src/stakeholders.ts` — Stakeholder tracking
- HTML comment metadata blocks: `<!-- <prefix>:stakeholders:start -->` / `<!-- <prefix>:stakeholders:end -->`
- Extract from issue body + comments + assignees
- `upsertStakeholderBlock()`, `buildStakeholderWorkPrefix()`
- `resolveStakeholderDmTarget()` with map env + default domain fallback

### `src/zoom-dm.ts` — Zoom DM sender for stakeholder notifications
- S2S OAuth via `ZOOM_REPORT_CLIENT_ID/SECRET/ACCOUNT_ID`
- Token caching with 60s buffer

### `src/comfort.ts` — Comfort messages
- Hardcoded channel JID (the bound channel)
- Random comfort message on incoming messages
- Uses chatbot OAuth (`ZOOM_CLIENT_ID/SECRET`)
- Head text set to bot display name

### `src/devtools-tools.ts` — 7 DevTools tools (if full stack)
- `<prefix>_devtools_list_containers`
- `<prefix>_devtools_get_logs` (tail, since, until)
- `<prefix>_devtools_list_files`
- `<prefix>_devtools_read_file`
- `<prefix>_devtools_db_tables`
- `<prefix>_devtools_db_table_schema`
- `<prefix>_devtools_db_query` (SELECT/WITH only, 1000 row limit)
- Env vars: `<PREFIX>_DEVTOOLS_API_URL` with fallback to `BIGHEAD_DEVTOOLS_API_URL`

### `src/correlation-tools.ts` — 1 correlation tool
- `<prefix>_correlate_logs` — Search container logs + GitHub issues for pattern

## Step 2: Update `openclaw.json`

File: `.data/openclaw/openclaw.json`

### Add agent entry to `agents.list`
```json
{
  "id": "$ARGUMENTS",
  "name": "<DisplayName>",
  "workspace": "~/.openclaw/workspace-$ARGUMENTS",
  "model": {
    "primary": "openrouter/anthropic/claude-sonnet-4-6",
    "fallbacks": ["openai/gpt-5.3-codex-spark", "openrouter/anthropic/claude-sonnet-4-5"]
  },
  "tools": {
    "allow": [
      // All <prefix>_ tools (25 total for full stack)
      // Plus existing read tools if applicable (e.g., zw2_search_orders, zw2_get_order, etc.)
      // Plus core tools: exec, web_fetch, web_search, message, memory_search, memory_get,
      //   sessions_list, session_status, zoom_send_action_card, zoom_send_dm,
      //   zoom_lookup_user, zoom_send_as_user, zoom_send_at_message, zoom_send_to_channel,
      //   zoom_request_file_upload, zoom_get_prefilter_config, zoom_set_prefilter_config,
      //   image, read, docx_read, docx_replace, docx_get_download
    ]
  }
}
```

### Add channel binding to `bindings`
```json
{
  "agentId": "$ARGUMENTS",
  "match": {
    "channel": "zoom",
    "peer": {
      "kind": "channel",
      "id": "<channel-jid>@conference.xmpp.zoom.us"
    }
  }
}
```

### Add channel config under `channels.zoom.channels`
```json
"<channel-jid>@conference.xmpp.zoom.us": {
  "requireMention": false
}
```

### Add plugin entry under `plugins.entries`
```json
"$ARGUMENTS": {
  "enabled": true,
  "config": {
    "<prefix>Repos": ["<github-org/repo>"]
  }
}
```

## Step 3: Create Workspace

Create `.data/openclaw/workspace-$ARGUMENTS/` with these files:

| File | Content |
|------|---------|
| `SOUL.md` | Bot identity, purpose, behavior guidelines, primary repo |
| `BOOTSTRAP.md` | First-conversation onboarding script (standard template) |
| `IDENTITY.md` | Name, creature type, vibe, emoji placeholder |
| `AGENTS.md` | Workspace guidelines for memory, audit, stakeholders |
| `MEMORY.md` | Fresh workspace placeholder |
| `TOOLS.md` | Local config notes placeholder |
| `USER.md` | User info placeholder |
| `HEARTBEAT.md` | Periodic check reminders (GH issues, PP tickets, container health) |

Create directories:
- `.data/openclaw/workspace-$ARGUMENTS/.openclaw/`
- `.data/openclaw/workspace-$ARGUMENTS/memory/`
- `.data/openclaw/agents/$ARGUMENTS/agent/`
- `.data/openclaw/agents/$ARGUMENTS/sessions/`

## Step 4: Deploy

Extensions are bind-mounted and loaded via jiti at runtime. No docker build needed.

```bash
docker-compose -f docker-compose.dev.yml restart openclaw
```

## Step 5: Verify

Check logs for successful registration:
```bash
docker exec openclaw grep "$ARGUMENTS" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -5
```

Expected: `[$ARGUMENTS] Registered N tools (...)`.

## Reference: Existing Bot Patterns

| Bot | Prefix | Tools | Channel | Repo |
|-----|--------|-------|---------|------|
| pulsebot | `pp_` | 25 (11 PP + 6 GH + 1 corr + 7 devtools) | `b6a0428c...` | cloudwarriors-ai/project-pulse |
| bigheadbot | `bh_` | 25 (11 BH + 6 GH + 1 corr + 7 devtools) | `567a6810...` | cloudwarriors-ai/bighead |
| zoomwarriorssupportbot | `zws_` | 25 (11 ZWS + 6 GH + 1 corr + 7 devtools) | `f1f7b4c3...` | cloudwarriors-ai/zoomwarriors2 |

## Environment Variables

These must be set in `docker-compose.dev.yml` or `.env`:
- `PROJECT_PULSE_URL`, `PROJECT_PULSE_EMAIL`, `PROJECT_PULSE_PASSWORD` — Project Pulse auth (shared)
- `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_ACCOUNT_ID`, `ZOOM_BOT_JID` — Chatbot OAuth
- `ZOOM_REPORT_CLIENT_ID`, `ZOOM_REPORT_CLIENT_SECRET`, `ZOOM_REPORT_ACCOUNT_ID`, `ZOOM_REPORT_USER` — S2S OAuth for DMs
- `GH_TOKEN` — GitHub CLI auth
- `BIGHEAD_DEVTOOLS_API_URL`, `BIGHEAD_DEV_TOOLS_API` — DevTools API (or bot-specific overrides)
- Bot-specific overrides: `<PREFIX>_PROJECT_PULSE_URL`, `<PREFIX>_DEVTOOLS_API_URL`, etc.
