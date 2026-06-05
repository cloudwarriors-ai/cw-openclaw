---
name: report-status
description: Send a structured project status update to the team lead's gateway. Gathers git context automatically and tracks project IDs across updates.
---

# /report-status — Report Project Status to Team Lead

Send a structured project update to the team lead. Automatically gathers git branch, repo, and PR info from the current working directory.

## Usage

- `/report-status <message>` — send a status update for current work (defaults to `in_progress`)
- `/report-status --new "project name" <message>` — start tracking a new project
- `/report-status --status queued|assigned|blocked|completed|needs_review|cancelled <message>` — update with explicit status
- `/report-status --group "Tesseract" <message>` — tag the project under a parent initiative/program

## Procedure

### Step 1: Determine the lead gateway

Read `~/.openclaw/workspace/team-roster.json` and find the member with `"role": "lead"`, or use the `lead_gateway` top-level field. Extract:

- the gateway URL
- the gateway auth token (`gateway_token`, or `lead_token` for older files)
- the lead session key (`lead_session_key`, default `agent:main:main`)

### Step 2: Gather git context automatically

Run these commands to collect project context from the current working directory:

```bash
# Current branch
git rev-parse --abbrev-ref HEAD

# Repo from remote
git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||'

# Check for open PR (if gh CLI available)
gh pr view --json number,title 2>/dev/null
```

### Step 2.5: Detect PR info for current branch

Run:

```bash
gh pr view --json url,number,state,title,statusCheckRollup 2>/dev/null
```

If this succeeds (exit code 0), parse the output and build a `pullRequest` object for the payload:

- `url`: use the `url` field directly
- `number`: use the `number` field directly
- `status`: **lowercase** the `state` field (`"OPEN"` → `"open"`, `"MERGED"` → `"merged"`, `"CLOSED"` → `"closed"`)
- `title`: use the `title` field directly
- `checksStatus`: reduce the `statusCheckRollup` array:
  - If any item has `conclusion: "FAILURE"` → `"failing"`
  - Else if any item has `status: "IN_PROGRESS"` or `status: "QUEUED"` or `conclusion` is null → `"pending"`
  - Else if all items have `conclusion: "SUCCESS"` → `"passing"`
  - Else if array is empty or null → `null`

If `gh pr view` fails (no PR for this branch), omit the `pullRequest` field entirely. This is normal for branches without PRs.

### Step 3: Check for existing project ID

Read `~/.openclaw/workspace/current-project.json` if it exists. If it contains a `projectId` for the current repo+branch, use that ID. Otherwise, set `projectId` to `null` to create a new project.

Also read the `configProfile` and `configApplied` fields if present — these track what config bundle was assigned and whether it has been applied.

### Step 4: Build the JSON payload

Construct the project update payload:

```json
{
  "projectId": "<from current-project.json or null>",
  "agent": {
    "name": "<agent name from openclaw config or hostname>",
    "machine": "<machine hostname>"
  },
  "project": {
    "name": "<from --new flag, or current-project.json, or repo name>",
    "repo": "<org/repo from git remote>",
    "branch": "<current branch>",
    "pr": "<PR number from gh or null>"
  },
  "update": {
    "status": "<from --status flag or 'in_progress'>",
    "summary": "<the user's message>",
    "problem": "<from current-project.json or the user's message on first report>",
    "details": "<expanded details — can include recent git log summary>"
  },
  "configProfile": "<from current-project.json or null — only include if set>",
  "pullRequest": "<from Step 2.5 — only include if a PR exists>",
  "timestamp": "<current ISO timestamp>"
}
```

### Step 5: Send to lead via /tools/invoke

```bash
curl -sS -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "${LEAD_SESSION_KEY}",
    "tool": "team_lead_update",
    "args": <payload from step 4>
  }'
```

### Step 6: Store the returned project ID

Parse the response. If successful, save or update `~/.openclaw/workspace/current-project.json`:

```json
{
  "projectId": "<returned projectId>",
  "leadGateway": "<gateway URL used>",
  "projectName": "<project name>",
  "repo": "<org/repo>",
  "branch": "<branch>",
  "lastReported": "<timestamp>",
  "configProfile": "<config profile from task assignment, or null>",
  "configApplied": { "profile": "<profile>", "appliedAt": "<ISO timestamp>" }
}
```

### Step 6.5: Apply config profile (if assigned)

If `configProfile` is set and `configApplied` is null or missing, this project has a config profile that hasn't been applied yet. Run `/apply-config` to apply it before starting work.

This typically happens when the agent first picks up a task that was assigned with a config profile by the lead.

### Step 6.6: Clean up config on completion

If the status being reported is `completed` or `cancelled`, and `configApplied` is set in `current-project.json`, clean up the applied config:

1. Locate the `team-ai` CLI (check PATH, `~/repos/cw-ai-configs/team-ai`, `~/.cw-ai-configs/team-ai`)
2. Run: `<team-ai-path> remove <configApplied.profile>`
3. Clear the `configApplied` field in `current-project.json`

This is best-effort — if removal fails, the next `/apply-config` will overwrite anyway.

### Step 7: Generate and Upload Architecture Docs

**Only run this step when status is `completed` or `needs_review`.**

1. Read the `projectId` from `current-project.json` (stored in Step 6). If missing, skip this step.

2. Read the lead gateway URL and auth token from `team-roster.json` (same as Step 1).

3. Gather context (keep output bounded):

```bash
git log main..HEAD --oneline | head -20
git diff main..HEAD --stat | tail -20
```

Also read any existing README.md, ARCHITECTURE.md, or docs/ files in the repo root.

4. Generate a doc following this template (max ~2000 words):

```markdown
# <Project Name> — Architecture

## Purpose

One paragraph: what was built and why.

## Key Files

List the 5-10 most important files changed, with one-line descriptions.

## Architecture

How the components fit together. Data flow, dependencies, API contracts.

## Decisions & Trade-offs

Non-obvious choices and why they were made.

## API Changes

New or modified endpoints/tools/interfaces (if any).

## How to Test

Commands or steps to verify this work.
```

5. Upload via the lead gateway. **Use this exact curl command:**

```bash
curl -sS -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "${LEAD_SESSION_KEY}",
    "tool": "team_lead_upload_doc",
    "args": {
      "projectId": "<projectId from current-project.json>",
      "title": "Architecture",
      "content": "<generated markdown — escape for JSON>",
      "author": "<your agent name>",
      "branch": "<current git branch>"
    }
  }'
```

6. If the project has clearly separate backend/frontend/infra components, upload additional docs (e.g., "Backend Architecture", "Frontend Architecture") using the same curl pattern with different titles.

7. If any upload fails, log the error but do not block the status report. Architecture docs are best-effort.

### Step 8: Report back to user

Display:

- Project ID (new or existing)
- Acknowledgment from lead
- Status sent
- Any notes

## Notes

- If `current-project.json` exists but the branch has changed, ask the user if this is the same project or a new one.
- If no team-roster.json or no lead gateway is configured, report the error and suggest configuring one.
- The `problem` field should persist across updates — only change it if the user explicitly provides a new problem statement.
