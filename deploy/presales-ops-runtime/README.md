# Presales Ops Runtime Bundle

This bundle captures the OpenClaw runtime-only pieces for the PE and BigHead
presales support bots.

It is intentionally separated from the plugin code:

- plugin code lives in the `cw-openclaw` repo
- agent runtime config lives in `/root/.openclaw/openclaw.json`
- workspace persona files live in `/root/.openclaw/workspace-*`

On dev-box today those paths are persisted on the host at:

```text
/root/web/moltbot/.data/openclaw
```

and mounted into the OpenClaw container as:

```text
/root/.openclaw
```

## Contents

- `openclaw.presales-ops.fragment.json`
  - Contains the two hub agents, eight spoke agents, and two Zoom support-channel bindings.
  - Contains placeholders for the PE and BigHead support channel IDs.

- `merge-openclaw-presales-ops.mjs`
  - Safely upserts the fragment into the existing `openclaw.json`.
  - Backs up the original config first.
  - This is safer than `openclaw config patch` because OpenClaw config patch replaces arrays.

- `env.example`
  - Lists the backend URL/token env vars that must be present on the OpenClaw gateway.

- `workspaces/`
  - Workspace files for the two hubs and eight spokes.
  - Copy each directory to `/root/.openclaw/workspace-<agent-id>`.

## Dev Deploy Shape

1. Deploy PR #66 plugin code to dev OpenClaw.
2. Copy `workspaces/*` into `/root/.openclaw/`.
3. Export the two support-channel IDs.
4. Merge and validate config:

```bash
export PE_SUPPORT_ZOOM_CHANNEL_ID="<PE_SUPPORT_ZOOM_CHANNEL_ID>"
export BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID="<BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID>"
docker exec \
  -e PE_SUPPORT_ZOOM_CHANNEL_ID \
  -e BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID \
  openclaw node /tmp/presales-ops-runtime/merge-openclaw-presales-ops.mjs
docker exec openclaw openclaw config validate
```

5. Restart/reload OpenClaw using the normal dev deploy process.
6. Validate that only the two hub agents are bound to Zoom channels.

## Channel IDs Needed

Only these two are used by this bundle:

```text
PE_SUPPORT_ZOOM_CHANNEL_ID
BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID
```

The PE event/debug and BigHead event/debug channel IDs should be reserved for the
later event-dispatch/live-ticker phase. PR #66 is pull/query support bots, not
the event dispatcher.

Decoded dev/prod support channel IDs are recorded in `channel-ids.md`.
