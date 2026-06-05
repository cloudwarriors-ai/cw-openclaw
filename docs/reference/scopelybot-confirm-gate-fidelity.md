---
title: "ScopelyBot Confirm-Gate — Fidelity & Delivery Problem"
summary: "The confirm-gate's code and result currently pass through the LLM coordinator and an un-suppressed observe hook. This causes fabricated codes, stale/duplicate prompts, spurious re-staging, and out-of-thread delivery. Records the problem with live evidence and the deterministic round-trip the fix must achieve."
status: exploratory
---

# ScopelyBot Confirm-Gate — Fidelity & Delivery Problem

> **Read this first.** This documents observed defects in the write-action confirm gate, backed
> by live logs from 2026-06-05, plus the design principle a fix must satisfy. It is an _intent_
> document, not an approved spec. The "what a fix must guarantee" section is the contract; the
> sketched mechanism is one way to meet it, not the only way. Re-verify the hook behavior noted in
> "Open questions" before building.

## Background — how the gate works today

Write tools in `extensions/scopelybot/` (password reset, activate/deactivate, update user, create
invite, pricing/org/vendor/deploy mutations) are **confirm-gated**:

1. The spoke calls a write tool (e.g. `scopely_reset_user_password`). The tool does **not** mutate.
   It calls `putPending({ code, summary, run })` (`src/pending-confirm.ts`) — an in-memory,
   single-use, 5-minute-TTL store keyed by a 4-digit `code` — and returns a staged message:
   `⚠️ Confirm: <summary> on PROD. Reply CONFIRM <code> within 5 minutes…`.
2. That message travels **back to the coordinator** as a subagent announce, and the **coordinator
   relays it to the Zoom channel** as its turn reply.
3. The human types `CONFIRM <code>` in the channel. A `message_received` hook
   (`extensions/scopelybot/index.ts:74`) calls `tryExecuteConfirm`, which `takePending(code)` and
   runs the staged closure — a single deterministic API call. The LLM is not in the execution
   decision (it cannot fabricate the inbound `CONFIRM` message).

The **intent** is sound: the model stages, a human confirms, the system executes. The **defects
are in the delivery plumbing around it** — specifically that exact-fidelity strings (the codes)
and the confirm round-trip pass through the LLM and through an observe-only hook.

## The defects (with live evidence, 2026-06-05)

Comparing what was **actually staged** (spoke → `putPending`) against what the **coordinator
relayed to the channel** (what the user sees):

```
REAL stagings (spoke putPending)     RELAYED to channel (coordinator reply)
18:29:48  9042                        18:29:52  9042   ok
                                      18:39:41  9042   ← STALE re-relay (no staging occurred at 18:39)
18:45:08  7961                        18:45:12  7961   ok
18:45:30  6880                        18:45:31  6880   ok
19:04:02  5799                        19:04:00  7951   ← FABRICATED (never staged; relayed BEFORE the real staging)
                                      19:04:06  5799   ok
```

### D1 — Coordinator fabricates confirm codes (highest severity)
At 19:04:00 the coordinator relayed `CONFIRM 7951`, a code that was **never staged** (the real
code `5799` did not exist until 19:04:02). `gpt-5.4-mini` invented a plausible 4-digit code, in
direct violation of its own persona (`IDENTITY.md`: *"Relay the CONFIRM code exactly,
character-for-character… never invent a code"*). It also **re-relayed a stale code** (`9042` at
18:39 with no staging behind it).

- **Why it matters:** the user cannot tell the real code from the invented one. A fabricated code
  *fails closed* (it matches no pending action, so nothing executes) — so this is not a
  security hole — but it is a **trust and usability hole**: it directly caused the operator to type
  wrong codes (`1001`, `9042`-expired) and conclude the gate was broken.
- **Root cause:** the exact code passes **through the LLM** on its way to the channel. Any model —
  especially a small one — can mangle, re-emit, or invent it.

### D2 — Duplicate confirm prompt
The same real code is relayed twice for one staging (`9042` at 18:29:48 & :52; `5799`-class double
relays observed). This is the coordinator double-delivering a reply — the same intermittent
double-reply pattern that the `NO_REPLY`-on-spawn persona rule reduced for normal answers but does
not fully eliminate under `gpt-5.4-mini`.

### D3 — `CONFIRM` message re-triggers the coordinator → spurious re-stage
The `message_received` confirm hook is **observe-only**: it executes the confirm but does **not**
suppress the message from reaching the coordinator. So `CONFIRM <code>` is *also* dispatched to the
coordinator, which sometimes interprets it as a new request and **re-stages**:

```
18:44:58  user: "reset Matt Keuning's password"   → staged 7961
18:45:23  user: "CONFIRM 7961"                     → confirm-gate executes 7961  (ok)
          (same message also routed to coordinator → re-spawned the users spoke)
18:45:30  → staged 6880                            ← spurious second code from the CONFIRM message
```

- **Why it matters:** every confirmation can spawn an orphan staged write action. Harmless today
  (the orphan expires) but it is real write-path churn and more confusing codes. Intermittent —
  it depends on whether the mini model decides to act on the `CONFIRM` text.

### D4 — Confirm result delivered out-of-thread
The confirm execution result (and the `No pending action…` errors) are sent via `sendScopelyText`
(`src/comfort.ts:84`), which POSTs to the channel JID with **no `reply_to`** — unlike
`sendComfortMessage`, which supports threading. So results land at **channel root**, detached from
the conversation thread. (Separate from, but compounding, the general threading work already fixed
in `extensions/zoom/src/outbound.ts`.)

## Root cause, stated once

> The confirm round-trip — the prompt carrying the code **out**, and the result coming **back** —
> currently passes through the **LLM coordinator** and through an **observe-only hook**. Exact
> strings (codes) and control flow (execute / suppress / thread) must not depend on a language
> model relaying them faithfully or on a hook that cannot stop dispatch.

D1/D2 come from the **prompt** being LLM-relayed. D3/D4 come from the **execution** path being an
observe hook with a non-threaded sender.

## What a fix must guarantee (the contract)

1. **Codes never pass through the LLM.** The exact `⚠️ Confirm … CONFIRM <code>` prompt is
   delivered to the channel **deterministically** from the staging tool/runtime, not relayed by the
   coordinator. The coordinator returns `NO_REPLY` for the staging turn.
2. **The `CONFIRM <code>` message never reaches the coordinator.** It is claimed/suppressed before
   agent dispatch, so it cannot re-stage.
3. **Both prompt and result are delivered in-thread**, anchored to the originating conversation.
4. **Fail-closed is preserved.** No change weakens the in-memory, single-use, TTL, human-typed
   confirm guarantee. The LLM stays out of the execution decision.
5. **Applies to the whole class.** Every confirm-gated write tool (not just password reset) must
   use the deterministic path — no tool may rely on LLM relay of its code.

## Sketched mechanism (one way to meet the contract — not the spec)

- **Deterministic prompt delivery:** when a write tool stages, deliver the confirm prompt straight
  to the channel (threaded), and have the staging turn resolve to `NO_REPLY`. The code is generated
  and rendered by code, sent by code — the model never sees or repeats it.
- **`before_dispatch` for execution:** move `tryExecuteConfirm` from the observe `message_received`
  hook to a `before_dispatch` hook returning `{ handled: true, text: <result> }`. `handled:true`
  suppresses the coordinator (fixes D3); `text` is delivered via the core's threaded
  `sendFinalPayload` (fixes D4). Remove `tryExecuteConfirm` from `message_received` to avoid
  double-consuming the single-use code.
- **Defense-in-depth:** persona line — *"never emit a `CONFIRM <code>` line yourself; if a message
  is `CONFIRM <code>`, reply `NO_REPLY`."* Covers any path the deterministic delivery misses.

## Open questions / to verify before building

- Does `before_dispatch` actually fire for the scopelybot **channel-bound agent dispatch** path?
  (No extension uses it yet — confirm with a temporary probe before relying on it; fallback is
  `inbound_claim`, which is the other documented pre-dispatch suppression seam.)
- What is the cleanest deterministic channel-send seam for the **prompt** that threads correctly
  and is reusable by all write tools? (`sendComfortMessage` already threads via `reply_to` /
  `reply_main_message_id` — `sendScopelyText` needs the same, or the staging path should use the
  core delivery rather than a raw Zoom POST.)
- Inventory: confirm that **all** confirm-gated write tools route their prompt the same way, so the
  fix covers the class rather than one tool. (`scopely_set_user_active`, `scopely_update_user`,
  `scopely_create_invite`, approve/reject access request, and the pricing/org/vendor/deploy
  mutations all use `putPending`.)

## Severity / priority

- D1 (fabricated codes): **high** — breaks operator trust in the gate; root of the reported
  "two different codes back to back." Fails closed, so not a security breach.
- D3 (re-stage): **medium** — write-path churn, intermittent.
- D2 (duplicate prompt) / D4 (out-of-thread): **low/cosmetic** — confusing, not harmful.

All four are resolved by the single principle: take the LLM and the observe-only hook out of the
confirm round-trip.
