---
title: "Presales Ops Support Bots Deployment"
summary: "Env wiring, hub/spoke agent definitions, and Zoom channel bindings to bring the PE + Bighead presales ops support bots online."
status: draft
---

# Presales Ops Support Bots Deployment

Brings the `presalespebot` and `bigheadbot` presales-ops spokes (see
`presales-ops-hub-spoke-support-bots.md`) online against the PE and Bighead
backends. Agent definitions and channel bindings are **operator state**
(`~/.openclaw/...` / `openclaw.json`), not repo content — this page is the
template to copy.

## Prerequisites

- PE backend serving `GET /internal/ops/*` (branch `codex/pe-presales-ops`),
  reachable from the Gateway container.
- Bighead backend serving `GET /internal/ops/*` (branch
  `codex/bighead-presales-ops`), reachable from the Gateway container.
- A service token for each backend (see Env).

## Env (set on the OpenClaw Gateway container)

| Var                                                         | Meaning                  | Notes                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BIGHEAD_OPS_BASE_URL`                                      | Bighead backend base URL | e.g. `http://bighead:8000` (container) / `http://localhost:8015` (local). **Required in prod** — if unset, the tools return a "not configured" error rather than fixture data. |
| `BIGHEAD_OPS_TOKEN`                                         | Bearer token for Bighead | Must equal the backend's `OPENCLAW_GATEWAY_TOKEN`. Falls back to `BIGHEAD_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_TOKEN` if unset.                                                  |
| `PRESALES_PE_OPS_BASE_URL`                                  | PE backend base URL      | e.g. `http://presales-knowledge-expert:8007` / `http://localhost:28010`.                                                                                                       |
| `PRESALES_PE_OPS_TOKEN`                                     | Bearer token for PE      | Must equal PE's `CWKB_SERVICE_BEARER_TOKEN`.                                                                                                                                   |
| `BIGHEAD_OPS_FIXTURE_MODE` / `PRESALES_PE_OPS_FIXTURE_MODE` | Force canned fixtures    | **Local dev only.** Set to `1` to run the bots without a backend. **Never set in prod** — it would mask outages with healthy-looking data.                                     |

On the backends: set `OPENCLAW_ENFORCE_GATEWAY_TOKEN=true` on Bighead so the
gateway-token check is enforced (it is a no-op when unset), and ensure
`CWKB_SERVICE_BEARER_TOKEN` is set on PE.

## Agent definitions (`agents.list`)

Hubs are router-only (no domain tools); spokes get an exclusive `tools.allow`
drawn from the code-exported groups (`PE_OPS_TOOL_GROUPS`,
`BIGHEAD_PRESALES_TOOL_GROUPS`). `<liveness>` is the hub's single health tool.

```json5
{
  agents: {
    list: [
      // ----- Presales Knowledge Expert -----
      {
        id: "presales-pebot",
        tools: { allow: ["sessions_spawn", "subagents", "pe_ops_health"] },
        subagents: { allowAgents: ["pe-observe", "pe-channel", "pe-schema", "pe-sms"] },
      },
      {
        id: "pe-observe",
        tools: {
          allow: ["pe_ops_health", "pe_ops_active_engagements", "pe_ops_stuck_engagements"],
        },
      },
      {
        id: "pe-channel",
        tools: {
          allow: [
            "pe_ops_engagement_status",
            "pe_ops_channel_status",
            "pe_ops_engagement_timeline",
          ],
        },
      },
      { id: "pe-schema", tools: { allow: ["pe_ops_schema_status", "pe_ops_field_summary"] } },
      { id: "pe-sms", tools: { allow: ["pe_ops_sms_status"] } },

      // ----- Bighead presales -----
      {
        id: "bighead-presales",
        tools: { allow: ["sessions_spawn", "subagents", "bh_presales_ops_health"] },
        subagents: {
          allowAgents: ["bighead-observe", "bighead-meeting", "bighead-audio", "bighead-writeback"],
        },
      },
      {
        id: "bighead-observe",
        tools: {
          allow: [
            "bh_presales_ops_health",
            "bh_presales_active_sessions",
            "bh_presales_stuck_sessions",
          ],
        },
      },
      {
        id: "bighead-meeting",
        tools: {
          allow: [
            "bh_presales_session_status",
            "bh_presales_meeting_status",
            "bh_presales_session_timeline",
          ],
        },
      },
      {
        id: "bighead-audio",
        tools: {
          allow: [
            "bh_presales_audio_status",
            "bh_presales_transcript_status",
            "bh_presales_transcript_text",
          ],
        },
      },
      { id: "bighead-writeback", tools: { allow: ["bh_presales_writeback_status"] } },
    ],
  },
}
```

The plugin tools register as `optional`, so an agent only sees a tool if its
`tools.allow` names it (or the plugin id). The hub physically cannot call a
domain tool — that is what forces it to route instead of answering from memory.

## Channel bindings (`bindings`)

Bind each hub to its own dedicated Zoom support channel **by explicit channel
id** (no enumeration). Replace the placeholder ids; match the `peer.kind` your
existing scopelybot/pulsebot bindings use for Zoom channels.

```json5
{
  bindings: [
    {
      agentId: "presales-pebot",
      match: { channel: "zoom", peer: { kind: "channel", id: "<PE_SUPPORT_ZOOM_CHANNEL_ID>" } },
    },
    {
      agentId: "bighead-presales",
      match: {
        channel: "zoom",
        peer: { kind: "channel", id: "<BIGHEAD_SUPPORT_ZOOM_CHANNEL_ID>" },
      },
    },
  ],
}
```

Only the two hubs are bound to channels. Spokes are spawned by their hub via
`sessions_spawn`; they never bind to a customer channel directly.

## Validation gate (run before trusting it)

1. **Backend reachability + shapes:** run `presales_ops_smoke.py` (cw-code root)
   against the running backends — expects 28/28, exercises every endpoint plus
   redaction and the transcript-text view.
2. **Hub routing:** ask the bighead hub one session question; confirm it calls
   only `sessions_spawn` and the `bighead-meeting` spoke runs only its tools.
3. **Wrong-domain routing:** ask a transcript question; confirm it lands on
   `bighead-audio`, not `bighead-meeting`.
4. **No-leak:** confirm no spoke posts into a customer channel; replies stay in
   the support channel.

## Safety notes

- Do **not** commit `SCOPELYBOT_TESTING.md` — it contains live prod host/IP and
  Zoom channel ids; keep it in private docs.
- Redaction is enforced server-side (PE/Bighead) and again bot-side: emails,
  Zoom URLs, and secret-keyed values are masked everywhere; phone numbers are
  masked inside free-text/phone-named fields only (ids and timestamps survive).
- This pass is pull-only: the bots fetch on request and post only into their
  support channel. No event/debug-channel dispatch yet (Phase 2).

```

```
