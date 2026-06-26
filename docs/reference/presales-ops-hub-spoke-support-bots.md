---
title: "Presales Ops Support Bots Hub and Spoke"
summary: "Proposed PE and Bighead support-bot split using the same router and specialist-spoke pattern proven by scopelybot."
status: draft
---

# Presales Ops Support Bots Hub and Spoke

This is the proposed support-bot shape for Presales Knowledge Expert and Bighead presales ops.
It mirrors the proven `scopelybot` pattern: plugin code registers a full optional tool catalog, then
runtime agent config turns that catalog into a small router hub plus narrow worker spokes.

## Goal

Keep the user-facing support bot easy to reason with while still giving operators deep visibility
into customer engagements, Zoom channel flow, SMS delivery, meeting health, audio, transcript, and
Scopely writeback state.

The coordinator should not hold every diagnostic tool. It should classify the request and delegate
to exactly one focused spoke. This avoids the failure mode where a support bot sees a large mixed
tool menu and guesses the wrong surface.

## Presales Knowledge Expert Split

Recommended agents:

```
presales-pebot (coordinator)
  tools.allow: sessions_spawn, subagents, pe_ops_health
  subagents.allowAgents: pe-observe, pe-channel, pe-schema, pe-sms

pe-observe
  pe_ops_health
  pe_ops_active_engagements
  pe_ops_stuck_engagements

pe-channel
  pe_ops_engagement_status
  pe_ops_channel_status
  pe_ops_engagement_timeline

pe-schema
  pe_ops_schema_status
  pe_ops_field_summary

pe-sms
  pe_ops_sms_status
```

Routing intent:

- `pe-observe`: fleet health, active engagements, stuck engagements, broad triage.
- `pe-channel`: one engagement or Zoom channel, current stage, timeline, what happened.
- `pe-schema`: schema freshness, missing fields, captured field quality.
- `pe-sms`: SMS lifecycle, delivery status, SOW delivery through SMS.

## Bighead Presales Split

Recommended agents:

```
bighead-presales (coordinator)
  tools.allow: sessions_spawn, subagents, bh_presales_ops_health
  subagents.allowAgents: bighead-observe, bighead-meeting, bighead-audio, bighead-writeback

bighead-observe
  bh_presales_ops_health
  bh_presales_active_sessions
  bh_presales_stuck_sessions

bighead-meeting
  bh_presales_session_status
  bh_presales_meeting_status
  bh_presales_session_timeline

bighead-audio
  bh_presales_audio_status
  bh_presales_transcript_status
  bh_presales_transcript_text

bighead-writeback
  bh_presales_writeback_status
```

Routing intent:

- `bighead-observe`: fleet health, active sessions, stuck sessions, broad triage.
- `bighead-meeting`: one session or Zoom meeting, join state, current question, timeline.
- `bighead-audio`: mute state, audio input/output, transcript health, and reading recent transcript lines (what the customer actually said) via `bh_presales_transcript_text`.
- `bighead-writeback`: Scopely writeback state and field patch failures.

## Coordinator Rules

The hub should stay router-only:

- Keep only `sessions_spawn`, `subagents`, and one liveness tool.
- Do not allow general read, memory, web, exec, GitHub, database, or domain diagnostic tools on the
  hub.
- Route immediately to one spoke. Do not ask permission to route.
- Restate the user request fully in the subagent task so the spoke has enough context.
- Reply `NO_REPLY` on the spawn turn when the platform will announce the spoke result.
- Relay the spoke result in the original thread when it returns.

The Scopely deployment proved that leaving general tools on the coordinator lets it answer from
history or memory instead of routing. Prompt wording alone is not enough; the tool allowlist is the
control.

## Spoke Rules

Each spoke should have one clear domain and an exclusive `tools.allow` list. A request should not be
plausibly routable to two spokes. If that happens, merge or redraw the domain boundary.

Spokes are workers:

- Use only the domain tools.
- Return the evidence and recommendation to the coordinator.
- Do not address the channel as a user-facing persona.
- Keep payloads redacted for support use.

## Implementation Notes

- Both `presalespebot` and the Bighead presales tools register plugin tools as optional. That is what
  lets per-agent `tools.allow` enforce the split.
- `PE_OPS_TOOL_GROUPS` and `BIGHEAD_PRESALES_TOOL_GROUPS` export the intended spoke allowlists from
  code so tests and config review can compare against one source of truth.
- Runtime agent definitions, channel bindings, and identities still live in operator state, not in
  this repo.
- Add or move diagnostic tools by updating the code group, the plugin manifest, the spoke allowlist,
  and the spoke identity together.

## Validation Gates

Validate with real channel traffic before trusting the setup:

1. Coordinator receives a support question and calls only `sessions_spawn`.
2. The selected spoke runs only its domain tools.
3. The spoke result announces back into the original thread.
4. The coordinator relays the result without calling domain tools itself.
5. A deliberately wrong-domain request routes to the other spoke.
6. No unbound support spoke posts directly to customer channels.

## Open Followups

- ~~Add the PE and Bighead internal ops endpoints that these tools call.~~ Done —
  PE `codex/pe-presales-ops` and Bighead `codex/bighead-presales-ops` serve the
  read-only `/internal/ops/*` routes (see `presales-ops-deployment.md`).
- Create the runtime agent definitions and identity prompts for the two hubs and eight spokes.
- Add support-channel bindings only after the new local and dev Zoom app credentials are isolated.
- Enforce Bighead gateway-token auth (`OPENCLAW_ENFORCE_GATEWAY_TOKEN=true`) wherever the
  ops endpoints are reachable — they expose customer transcript data and fail open otherwise.
- Revisit the split once live support traffic shows which requests operators actually ask.
