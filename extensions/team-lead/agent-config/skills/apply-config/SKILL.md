---
name: apply-config
description: Apply a config profile from the cw-ai-configs registry to the current working directory. Pulls skills, rules, settings, and instructions from a named bundle.
---

# /apply-config — Apply Agent Config Profile

Apply a config bundle from the `cw-ai-configs` registry to the current project. Used when the team lead assigns a task with a specific `configProfile`.

## Usage

- `/apply-config <bundle>` — apply a specific config (e.g. `personal/chad`, `templates/django`)
- `/apply-config` — apply the config from the current project's `configProfile` field

## Procedure

### Step 1: Determine the config profile

Check for a config profile in this order:

1. **Argument**: If the user provided a bundle name (e.g. `/apply-config personal/chad`), use that.
2. **current-project.json**: Read `~/.openclaw/workspace/current-project.json`. If it has a `configProfile` field, use that.
3. **Lead gateway**: If `current-project.json` has a `projectId` and `leadGateway`, call the lead to fetch the project:
   ```bash
   curl -sS -X POST "${LEAD_GATEWAY}/tools/invoke" \
     -H "Authorization: Bearer ${LEAD_TOKEN}" \
     -H "Content-Type: application/json" \
     -d '{"tool": "team_lead_get_project", "args": {"projectId": "<projectId>"}}'
   ```
   Read `configProfile` from the response's `project` object.
4. **No config found**: If none of the above yields a config profile, report: "No config profile found. Provide one as an argument: `/apply-config personal/chad`"

### Step 2: Validate the format

The config profile must match one of these patterns:

- `_standards` (the team-wide baseline)
- `personal/<name>` (e.g. `personal/chad`)
- `projects/<name>` (e.g. `projects/zoomwarriors`)
- `templates/<name>` (e.g. `templates/django`)

Names may only contain letters, numbers, hyphens, and underscores. If the format is invalid, report the error and stop.

### Step 3: Locate the team-ai CLI

Check for the `team-ai` CLI in this order:

```bash
# Check PATH first
which team-ai 2>/dev/null

# Check common locations
test -x "$HOME/repos/cw-ai-configs/team-ai" && echo "$HOME/repos/cw-ai-configs/team-ai"
test -x "$HOME/.cw-ai-configs/team-ai" && echo "$HOME/.cw-ai-configs/team-ai"
```

Use the first one found. If none found, report:

> `team-ai` CLI not found. To set it up:
>
> ```
> gh repo clone cloudwarriors-ai/cw-ai-configs ~/repos/cw-ai-configs
> ```
>
> Then retry `/apply-config`.

### Step 4: Update the local repo

Before pulling, ensure the config repo is up to date:

```bash
cd <repo-directory-containing-team-ai> && git pull --ff-only 2>/dev/null
```

This is best-effort — if it fails (e.g. no network), continue with the local version.

### Step 5: Pull the config

Run the pull command from the **current working directory** (the project repo):

```bash
<team-ai-path> pull <config-profile> --host claude
```

Check the exit code:

- **Exit 0**: Config pulled successfully. Proceed to Step 6.
- **Non-zero**: Report the error. Common issues:
  - Bundle not found → "Bundle `<profile>` does not exist in cw-ai-configs. Check available bundles with: `<team-ai-path> show <profile> --host claude --facets`"
  - Manifest error → "The bundle manifest may be invalid. Check the repo."

### Step 6: Verify and report

Show what was applied:

```bash
<team-ai-path> show <config-profile> --host claude --facets 2>/dev/null
```

Report to the user:

- Config profile applied: `<profile>`
- What was installed (skills, rules, settings — from the show output)
- Current working directory where it was applied

### Step 7: Update current-project.json

If `~/.openclaw/workspace/current-project.json` exists and has a `projectId`, update it:

```json
{
  "configProfile": "<profile>",
  "configApplied": {
    "profile": "<profile>",
    "appliedAt": "<current ISO timestamp>"
  }
}
```

Merge these fields into the existing file — do not overwrite other fields.

### Step 8: Report to lead (if applicable)

If `current-project.json` has a `leadGateway` and `projectId`, send a status update confirming the config was applied:

```bash
curl -sS -X POST "${LEAD_GATEWAY}/tools/invoke" \
  -H "Authorization: Bearer ${LEAD_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "team_lead_update",
    "args": {
      "projectId": "<projectId>",
      "agent": { "name": "<agent-name>", "machine": "<hostname>" },
      "project": { "name": "<project-name>", "repo": "<repo>", "branch": "<branch>", "pr": null },
      "update": {
        "status": "in_progress",
        "summary": "Applied config profile: <profile>",
        "problem": "<existing problem from current-project.json>",
        "details": "Config bundle <profile> applied via team-ai pull. Ready to begin work."
      },
      "configProfile": "<profile>"
    }
  }'
```

## Removing a Config

To remove an applied config (e.g. when a task is completed):

```bash
<team-ai-path> remove <config-profile>
```

This is handled automatically by the `/report-status` skill when reporting `--status completed` or `--status cancelled`.

## Notes

- Each `team-ai pull` overwrites previously pulled configs for the same bundle. Pulling a different bundle does NOT remove the previous one — use `team-ai remove` for that.
- The `--host claude` flag tells team-ai to install Claude-specific artifacts (CLAUDE.md, skills, rules). Use `--host codex` for Codex environments.
- If the agent is running on a machine without the `cw-ai-configs` repo, the skill will provide clone instructions. The repo is at `github.com/cloudwarriors-ai/cw-ai-configs`.
