---
title: "Agent Test Harness — Noise-Free Intake/Output + Hub-and-Spoke Verification"
summary: "A modular, agent-agnostic harness that drives a Zoom-bound agent's real intake→coordinator→spoke→output pipeline, captures and SUPPRESSES all channel egress (no writes to the live channel), and records the internal routing/tool trace so hub-and-spoke delegation can be asserted. Built on existing primitives (signed webhook intake, an env-gated undici egress interceptor, the before_tool_call hook, and the proxy-capture SQLite store)."
status: exploratory
---

# Agent Test Harness — Noise-Free Intake/Output + Hub-and-Spoke Verification

> **Status.** Design intent, not an approved spec. Decisions marked **[chosen]** are settled with
> the requester; items under "Open questions" must be verified before building. Nothing here is
> implemented yet.

## Goal

Drive a Zoom-bound agent's **real** pipeline — webhook intake → coordinator routing →
spoke execution → outbound reply — and:

1. **Capture every outbound message** the bot would send (final reply, comfort message, confirm
   prompt) **without any of it reaching the live Zoom channel**.
2. **Observe the internal hub-and-spoke behavior** — which spoke the coordinator routed to, which
   tools each agent called — so routing/delegation correctness is assertable, not just final text.
3. Be **modular / agent-agnostic**: testing pulsebot vs scopelybot vs bigheadbot is a different
   _profile_, not different code. Test-only; inert in production.

## Why the obvious seams don't work (the finding that shapes this)

Every bot ships the **same duplicated raw-POST pattern**: `extensions/<bot>/src/comfort.ts` and
`zoom-dm.ts` call `fetch("https://api.zoom.us/v2/...messages")` **directly, bypassing core
outbound**. The coordinator's _final reply_ goes through core (and fires the `message_sending`
hook), but the comfort message and the confirm prompt — the two messages a confirm-gate test most
needs — do not.

> A `message_sending` hook can't be the capture seam: it misses the raw POSTs for **every** bot.
> The only point all outbound shares is the **HTTP egress to `api.zoom.us`**. Interception lives
> there.

Likewise, the channel output alone can't prove hub-and-spoke routing — that requires the
**tool-call trace** (which spoke ran, which tools), observed via the `before_tool_call` hook.

## Solution ladder

- **L1 — per-bot dry-run flag** in each `comfort.ts`/`zoom-dm.ts`: 7+ bots × 2 files, high churn,
  not modular. Rejected.
- **L2 — one env-gated egress interceptor (undici) + a tool-trace hook + thin external harness.**
  Single interception point per concern, agent-agnostic, surgical, test-only. **[chosen]**
- **L3 — first-class "loopback channel transport"** simulating all channels: a new runtime surface;
  overkill for the need. Revisit only if multi-channel simulation is later required.

### Reuse-first record

- `src/proxy-capture/` — MITM capture **proxy**; it _forwards_ traffic, so it can't satisfy "don't
  write to channel". **Reuse its SQLite store/schema** (`CaptureDirection: "outbound"`) as the
  record sink. **[chosen]**
- `message_sending` hook — core-only, misses raw POSTs. Rejected as the egress seam.
- `before_tool_call` hook (`src/plugins/hook-types.ts:517`) — generic, fires for every tool call
  incl. `sessions_spawn`; reuse for the routing/tool trace.
- `src/infra/net/undici-runtime.ts` — repo already owns the global dispatcher; **compose with it**
  (wrap, don't clobber its custom Agent).
- The synthetic signed-webhook injector from the 2026-06-05 debug session already works; formalize.

## Decisions [chosen]

- **Isolation model: real bot, egress-suppressed.** Inject to the bot's real channel; the
  interceptor captures + suppresses outbound **scoped to the profile's `channelJid`**, so other
  bots stay live. Caveat: a human messaging that same channel mid-run would also be suppressed —
  runs are short / use an idle window. (No per-bot Zoom or agent setup → fully modular.)
- **Capture sink: reuse proxy-capture SQLite.** Synthetic outbound + tool-trace records persist to
  the existing capture store/schema; the harness queries it. SQLite-only compliant, reuse-first.

## Architecture — components

```
  [1 injector CLI]                gateway process (in container)
  signed webhook  ───────────────►  :4000 /zoom/webhook
  (channelJid, msg)                      │  REAL dispatch: coordinator → sessions_spawn → spoke → outbound
                                         │
              [3 tool-trace hook] ◄──────┤  before_tool_call fires for EVERY tool call
              records {runId, agent,     │  (coordinator's sessions_spawn + each spoke's domain tools)
               toolName, params} ──┐     │
                                   │     ▼
            [2 egress interceptor] │  if to_jid ∈ capture-set:  record outbound → [proxy-capture SQLite] + synthetic 200 (NO send)
            (undici dispatcher,    │  else:                     forward to real dispatcher (other bots unaffected)
             env-gated)            │
                                   ▼
                         [proxy-capture SQLite store]
                                   ▲
  [5 assertion runner] ◄───────────┘   reads outbound records + tool-trace records
  [4 session reset]: /reset target agent's session before the run (anti-contamination)
```

### 1. Intake injector (external CLI)

Posts a signed `team_chat.channel_message_posted` to `:4000/zoom/webhook`. Signature =
`v0=HMAC_SHA256(ZOOM_WEBHOOK_SECRET_TOKEN, "v0:<ts>:<rawBody>")`, headers `x-zm-signature` +
`x-zm-request-timestamp`. Parameterized by `channelJid` (routes to whichever bot is bound),
message text, operator. One injector → any bot.

### 2. Egress interceptor (the one in-process, test-only piece)

Env-gated (`OPENCLAW_ZOOM_CAPTURE_CHANNELS=<jid,jid>`). Installed at gateway bootstrap; **wraps**
the existing `undici-runtime` global dispatcher. For requests to `api.zoom.us` message endpoints
(`/v2/im/chat/messages`, `/v2/chat/users/*/messages`):

- `to_jid` (or DM target) ∈ capture-set → **record outbound + return synthetic `200
{status:"ok", message_id:"<fake>"}`**; no real send.
- otherwise → **forward to the real dispatcher** (production bots in other channels keep working).
- all non-Zoom traffic (openrouter model calls, Scopely BFF reads, Zoom token/history) →
  untouched passthrough.

Catches core sends **and** every bot's raw POSTs in one place, scoped so only the channel(s) under
test go silent.

### 3. Tool-trace hook (the hub-and-spoke observability piece)

A `before_tool_call` hook (same test env gate) records each call: `{runId, toolName, params,
toolCallId, agentAttribution}`. Because it fires for `sessions_spawn` too, the trace shows exactly
which spoke the coordinator chose (`sessions_spawn` `params.agentId`) and which domain tools each
spoke then called. Records go to the same capture store, correlated by `runId`.

> Agent attribution: derive which agent made a call from the hook context (`sessionKey`/`agentId`)
> if exposed, else from `sessions_spawn` params + the per-spoke `agents.<spoke>.tools.allow`
> tool-policy boundary. **Open question** — confirm the cleanest attribution source.

### 4. Session reset (external step)

Before each run, `/reset` the target agent's channel session (parameterized by `sessionKey`) so
prior-turn contamination cannot poison results. (This is the documented non-channel lever; it also
prevented the 2026-06-05 "fixated on resetting Matt Keuning" failure mode from recurring.)

### 5. Assertion runner (external)

Reads outbound + tool-trace records for the run from the capture store and asserts. All assertions
are payload/trace-level — no screenshots needed.

## What this lets you assert

**Output fidelity (per-bot, e.g. scopelybot confirm-gate):**

- Confirm prompt was posted to the channel and **contains a real `CONFIRM <code>`**.
- Coordinator's reply is **code-free** (regex: no `CONFIRM \d{4}`).
- Result is **in-thread** (`reply_to`/`reply_main_message_id` set to the originating message).
- Wrong-code CONFIRM is a no-op (fail-closed).

**Hub-and-spoke routing (any bot):**

- **Routing discrimination** — request X spawned spoke Y (assert the `sessions_spawn`
  `params.agentId`); a different-domain request spawns a different spoke.
- **Router-only coordinator** — the coordinator's tool calls ⊆ `{sessions_spawn, subagents,
liveness reads}`; it never calls a domain tool directly.
- **Per-spoke tool use** — spoke Y called the expected tools (e.g. `scopely_list_users`), and only
  from its own allowlist.
- **No cross-spoke reach** — a single in-domain task completed without the spoke needing a tool
  that lives in another spoke (the Track 2 partitioning invariant).
- **Safety guard** — a **read** request triggered **no write/staging tool** (would have caught the
  2026-06-05 "list users → staged password reset" contamination directly).

## Modularity model

An **agent profile** = `{ agentId, channelJid, sessionKey }`. The harness takes a profile + a test
message + expected assertions. The capture-set is the profile's `channelJid`, so only that bot's
channel is silenced. Testing another bot = another profile, zero code change. Profiles can live in
a small test fixture (one entry per bot) or be passed inline.

## Test flow (one run)

1. Ensure the gateway is running with the interceptor armed (`OPENCLAW_ZOOM_CAPTURE_CHANNELS`
   includes the profile's `channelJid`).
2. `/reset` the profile's `sessionKey`.
3. Inject the test message (signed webhook) to `channelJid`.
4. Await completion (capture-count stable for the `runId`, or an `agent_end`/log marker — see open
   questions), with a timeout.
5. Read the run's outbound + tool-trace records; run assertions.
6. Nothing reached the real channel.

## Where the in-process pieces live

A small **bundled test-capture extension** (`extensions/test-capture/`, or a test-helper module)
that on `gateway:startup`, **only when the env flag is set**:

- installs the egress interceptor by composing with `undici-runtime`, and
- registers the `before_tool_call` trace hook.
  Inert when the flag is unset → safe to ship disabled. This keeps the harness in the
  `extensions/`/test boundary and touches no bot code.

## Open questions to resolve before building

1. **undici composition point** — confirm `src/infra/net/undici-runtime.ts` exposes a clean way to
   wrap the existing dispatcher (capture-or-forward) without clobbering its custom Agent
   (timeouts/proxy).
2. **No per-request dispatcher bypass** — `comfort.ts`/`send.ts` use bare global `fetch` (good), but
   verify no Zoom egress path passes a per-request `dispatcher` that slips past the global intercept
   (a contract test referenced `requestInit.dispatcher`).
3. **Agent attribution in `before_tool_call`** — confirm the hook context carries `agentId`/
   `sessionKey`, else attribute via `sessions_spawn` params + tool-policy boundary.
4. **Capture-store reuse** — confirm proxy-capture's SQLite store can be a writer-only sink for
   synthetic outbound + tool-trace records, or add a small dedicated table (still SQLite).
5. **Completion signal** — pick a deterministic "turn done" signal (stable capture count for the
   `runId`, or an `agent_end` hook) instead of a fixed sleep.

## Estimated scope

~300–400 LOC, almost entirely **test infrastructure**: the test-capture extension (interceptor +
trace hook + store writer), the injector CLI, and the assertion runner. Net **production-runtime**
change ≈ the env-gated interceptor/hook install only (off by default).

## Worthwhile follow-on (not required by this design)

The duplicated `comfort.ts`/`zoom-dm.ts` raw POSTs across 7 bots are the reason a clean hook-level
egress seam doesn't already exist — they violate the repo's "channels are transport-only; product
code shouldn't raw-send" guidance. Routing them through core outbound (or a shared SDK send helper)
would make `message_sending` a sufficient egress seam, shrink duplicated code, and simplify this
harness. Separate refactor; the egress-interceptor design works today without it.
