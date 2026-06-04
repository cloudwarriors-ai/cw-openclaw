---
title: "Hub-and-Spoke Agent Pattern — Reuse Playbook"
summary: "How to split an overloaded OpenClaw agent into a router coordinator + single-domain specialist spokes. Generalized from the scopelybot build (2026-06-04); applicable to any agent."
status: reference
---

# Hub-and-Spoke Agent Pattern — Reuse Playbook

When one agent accumulates too many tools (degradation starts ~30-50; selection gets worse beyond
that), split it into a small **router coordinator** that delegates to single-domain **specialist
subagents ("spokes")**, each seeing only its own small toolset. First proven on `scopelybot` (86
tools → 8 spokes); see [scopelybot as-built record](/reference/scopelybot-hub-spoke-recommendation).

This is built entirely on native OpenClaw primitives (`sessions_spawn` + per-agent tool allowlists +
channel bindings) — no custom orchestration.

## Prerequisites (already shipped — shared infra, free for any Zoom agent)

These landed during the scopelybot build and are channel-level, so a new Zoom hub-and-spoke agent
inherits them with no extra work:

1. **Subagent spawn unblock** (`sessions_spawn` ignores acp-only `streamTo` for `runtime=subagent`).
   Commit `563f81dab8`.
2. **Zoom inbound threading** — `channels.zoom.threading.inheritParent: true`. Threaded replies route
   to the channel's bound agent (not `main`) and inherit parent context.
3. **Zoom outbound in-thread delivery** — the Zoom `subagent_delivery_target` hook. Spoke results land
   in the originating thread, not the channel root. Commit `873b731e18`.

For a **non-Zoom** channel, verify equivalents exist: discord/feishu already ship
`subagent_delivery_target` hooks; other channels may need one.

## Per-agent recipe

1. **Register the agent's tools `optional: true`.** Only optional plugin tools are scoped by per-agent
   allowlists (`isOptionalToolAllowed`, `src/plugins/tools.ts`). Non-optional tools bypass allowlists
   and leak to every agent.
2. **Define the spokes** — one unbound agent per domain in `agents.list[]`:
   - `tools.allow` = exactly that domain's tool names (exclusive allowlist).
   - A `workspace-<spoke>/IDENTITY.md` worker prompt: "you run only your domain's tools and return the
     result to your coordinator; never address the channel; writes are confirm-gated — stage and return
     the `CONFIRM <code>` prompt verbatim."
   - Same model as the coordinator is fine.
3. **Make the coordinator router-only.** Shrink its `tools.allow` to **just** routing tools:
   `sessions_spawn`, `subagents`, plus at most 1-2 trivial liveness reads. Set
   `subagents.allowAgents` to the spoke ids. Rewrite its `IDENTITY.md` as a router prompt: a routing
   table (domain → spoke), and the rules "never answer domain questions from memory/history; never ask
   permission — just spawn; relay the spoke's result; relay `CONFIRM` prompts verbatim."

> **THE critical lesson (cost 4 failed live tests):** the coordinator must have **no** general tools —
> no `read`, `memory_search`, `memory_get`, `web_*`, `exec`. If it has them, the model uses them to
> answer domain questions from its own memory/history instead of delegating (and tends to ask
> permission rather than act). `sessions_spawn` must be its **only** path to domain data. Prompt
> hardening alone is **not** enough — remove the tools.

## Spoke-split design rules

- **One spoke = one unambiguous intent domain.** If the coordinator could plausibly route a request to
  two spokes, the split is wrong.
- **Each spoke owns its full CRUD** (reads _and_ writes for its domain). Don't split "read pricing" and
  "edit pricing" across spokes — "anything about pricing → pricing spoke" must be unambiguous.
- **Cross-cutting reads** (telemetry, dashboards, audit) go in dedicated observe/admin spokes.
- **Keep each spoke under ~30 tools.** Merge thin CRUD wrappers and sharpen descriptions first if a
  single domain is still too large.
- **Confirm-gate is free and unchanged:** if writes use a process-wide pending store + a channel-level
  `message_received` hook to execute `CONFIRM <code>` (as scopelybot does), it works across the
  spoke→coordinator boundary with no changes — the spoke stages, the coordinator relays, the channel
  hook executes. The LLM is never in the execution path.

## Deploy & iterate

- **Extensions are jiti-live**: editing `extensions/<x>/**` + clearing `/tmp/jiti/*` + restarting the
  container picks up changes — **no `docker build`**. Core `src/**` changes need a rebuild (the
  container runs baked `dist/`).
- Spoke config lives in runtime state (`.data/openclaw/openclaw.json` + `workspace-*/IDENTITY.md`),
  which is gitignored. Back it up before/after; that's how you roll back.
- To move a tool between spokes: edit the spoke's `tools.allow` and restart.

## Validation gates (run in order)

1. **Spawn round-trip** — coordinator spawns a spoke, spoke runs a tool, result announces back.
2. **Routing discrimination** — different-domain requests hit different spokes (e.g. "list X" → X-spoke,
   "recent errors" → observe); coordinator runs _only_ `sessions_spawn`, never domain tools.
3. **In-thread delivery** — spoke result lands in the originating thread, not the channel root.
4. **Confirm-gate** — a spoke-staged write surfaces a `CONFIRM` prompt the user can execute; the LLM
   cannot self-confirm.

## Testing gotchas

- The CLI (`openclaw agent`) **cannot drive a running gateway** (it requires device pairing and falls
  back to embedded mode, which doesn't exercise the gateway announce-back path). Test routing/threading
  with **real channel messages**, or via a paired client.
- A persistent channel session can answer from **stale history** during testing. Use `/reset` (or
  archive the session `.jsonl` on disk, mimicking it) for a clean test session.
- Model self-reports about which tools it has are unreliable — verify via the gateway log / session
  transcripts, not by asking the agent.
