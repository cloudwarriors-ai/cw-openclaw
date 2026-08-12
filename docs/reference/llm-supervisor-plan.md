---
title: "LLM Supervisor (Slice S3) — grounded-claim judge: design for ratification"
status: PROPOSED — awaiting Chad/Doug ratification
date: 2026-07-21
depends: supervisor-v2-research.md (sourced research), scopely-support-service-design.md §4.2
---

# LLM Supervisor — grounded-claim judge (Slice S3)

## Why now — the harm ledger

The supervisor's correctness lane is deterministic-only by design: it verifies **hard
tokens** (numbers, emails, ids, currency) against turn evidence. Word-only false claims
were the documented accepted residual ("accepted + monitored; narrowing trigger = drift
observed live", PR #90). On 2026-07-21 the trigger fired repeatedly in one day of real
PM traffic:

| #   | What passed through                                                                                                                                     | Harm                                   | Layer that caught it (eventually)                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| 1   | "isn't on the authorized sender list" — fabricated auth denial to a working approver                                                                    | PM blocked mid-task, trust damage      | Human (Chad) + post-hoc deterministic check (PR #95) |
| 2   | "Genesys has conflicting CCaaS configuration" — unverified claim stated as fact                                                                         | Task stalled; still unverified         | Nobody yet                                           |
| 3   | "the available admin controls don't expose scoping-card pricing linkage" — false capability claim (the bot performed exactly that update minutes later) | Human misled about what the bot can do | The bot itself, by accident                          |
| 4   | Same invalid category restaged 3× despite the 400 naming the valid enum                                                                                 | 3 wasted confirm rounds                | Human ("Make it core") + IDENTITY rule               |
| 5   | Category "core" written into deployment_types — silently unpriceable rows                                                                               | Latent data defect in prod             | Post-hoc DB audit + tool-layer guard (PR #94)        |

Rows 1–3 are the same class: **word-expressed claims about system state, capability, or
authorization with no supporting evidence**. No deterministic token check can see them.
Row 4 is a behavior loop; row 5 is the tool-arg plane (tool layer owns it — a judge that
reviews outbound drafts can never see staging turns, which return NO_REPLY and skip the
finalize hook entirely). The judge below targets rows 1–4's class; it explicitly does NOT
claim rows 5's plane.

## What we already know (research + live evidence)

From `supervisor-v2-research.md` (sourced):

- LLM-as-judge has measured biases — position, verbosity, **self-enhancement** (favoring
  its own style). Mitigations: different vendor family, binary structured verdicts,
  single-candidate review (no position bias), temp 0.
- OWASP's ordered guidance is deterministic-code-first; the one model-adjacent item (#3)
  is _groundedness evaluation_ — exactly this judge's scope, paired WITH string checks,
  never replacing them.
- Any model lane on the turn path needs an explicit latency budget decision.
- A judge must never be the security plane: "the fact-check LLM is itself unreliable" is
  a documented failure mode. Security stays deterministic (confirm_code_leak,
  secret_leak — fuse-exempt, unchanged).

From the live voice-judge lane (v2.1, proven in prod since 2026-07-21):

- The plumbing pattern works: `api.runtime.llm.complete` with a different-vendor model
  (`openrouter/anthropic/claude-haiku-4.5`, already authorized in prod `openclaw.json`
  `allowedModels`), draft **redacted** before leaving the box, 4s AbortController (the
  finalize hook has no harness timeout — we self-bound), **deterministic post-guard** on
  the verdict format, fail-open on every error path.
- S23/S25 proved the full revise → fresh-tool-read → re-ground loop end-to-end in prod.

## Design

### One question, one lane

The judge answers exactly one question per draft:

> **Is every material claim in this draft supported by this turn's evidence (tool
> results + internal completion events), the human's own message, or an explicit
> hedge?**

Claim categories it must catch (each anchored to a live incident above):

- **Authorization/permission claims** (row 1) — backstop behind the deterministic
  `ungrounded_auth_denial` check; the judge catches phrasings the regexes miss.
- **Capability claims** (row 3) — "the tools can't do X", "controls don't expose Y".
- **System-state claims** (row 2) — "configuration is conflicting", "service is down",
  "already exists" — where no tool result this turn says so.
- **Success/failure claims** — "no changes were made", "the update failed" — unless a
  tool result or system outcome this turn says so.
- **Rejected-value reuse** (row 4) — the draft proposes/stages a value the turn evidence
  shows was already rejected with a named valid list.

Out of scope (owned elsewhere, deliberately): security enforcement (deterministic,
fuse-exempt); tone/persona (voice judge); tool-argument validation (tool layer, PR #94
pattern); staging-turn review (structurally invisible — NO_REPLY turns skip finalize);
cross-turn consistency (future work; requires session-state the hook doesn't carry).

### Verdict protocol (deterministic shell around the model)

Input: redacted draft + redacted evidence corpus + the human message, in an
evidence-only frame ("judge ONLY support; do not judge style, do not rewrite").
Output — post-guard enforced by regex, anything else = fail-open PASS:

```
PASS
REVISE:<category>: <one sentence naming the unsupported claim>
```

Hard-token firewall on the reason (same as voice judge): every content token in the
reason must appear in the draft — the judge may QUOTE the draft, never introduce new
facts into the revision instruction. The revise instruction the model receives is
assembled by OUR code from the category + quoted claim, not free-form judge text.

### Bias + budget controls

- Judge model: different vendor family from Luna, temp 0. Default
  `openrouter/anthropic/claude-haiku-4.5` (already authorized); env
  `SCOPELYBOT_JUDGE_MODEL` to swap.
- 4s AbortController; fail-open on timeout/error/malformed verdict (a down judge must
  never take the bot down — same posture as voice).
- Fires ONLY after all deterministic checks pass (deterministic-first, OWASP ordering),
  and only on substantive drafts (skip short clarifying questions; NO_REPLY never
  reaches the hook).
- Revises charge the QUALITY fuse (bounded: harness 3/run + per-key retry budget +
  fuse 3/10min). Security lane untouched.
- Routed coordinator turns (spawn side effect blocks revise): detect-only — audit entry
  `judge_flag_unrevisable`; repeated flags on one session escalate via the existing
  fuse/escalation path.

### Rollout — shadow first, enforce on evidence

The #1 reason the judge lane was deferred was "no false-positive corpus". Build it from
real traffic instead of guessing:

1. **Phase 0 (implementation)**: `judge.ts` generalizing the voice-judge plumbing
   (~150 LOC + tests), wired into `superviseFinalize` behind
   `SCOPELYBOT_JUDGE=shadow|enforce` (unset = off, byte-identical).
2. **Phase 1 — SHADOW (1 week or ≥200 substantive turns, whichever first)**: judge runs
   on every eligible turn, verdict + category + quoted claim audit-logged, **zero
   revises**. Daily: replay audit vs actual outcomes; each flag classified true/false
   positive. Acceptance to advance: FP rate < 10% of flags AND the shadow log shows it
   would have flagged incidents 1–3 (replay of the 2026-07-21 transcripts is the fixture
   test — it must flag all three verbatim drafts).
3. **Phase 2 — ENFORCE**: flip to `enforce`; revise live, fuse-bounded. Keep the weekly
   audit sample (both revises AND passes) as the standing drift monitor — the same
   review loop that caught the voice-judge word-drift residual.
4. **Kill switch**: env flip back to `shadow` or unset; no code change, no restart
   semantics beyond the compose edit + restart.

### Cost estimate

Haiku-class call per substantive turn: draft (≤1k tokens redacted) + evidence excerpt
(≤2k, truncated) + frame ≈ 3–4k in / ~10 out. At current traffic (tens of substantive
turns/day) this is cents/day. Latency: p50 well under the 4s bound per voice-judge
telemetry; worst case adds 4s then fails open.

### What this does NOT fix (named, with owners)

- **Tool-argument semantics** (row 5): tool layer, PR #94 pattern — extend per-tool as
  silent backends are found.
- **Staging-turn review**: structural (NO_REPLY skips finalize). The confirm prompt
  itself is the human review surface; bundle prompts already enumerate every item.
- **Cross-turn contradictions** ("no changes were made" two turns after a ✅): future
  slice; needs turn-history plumbing the hook doesn't have today.

## Decision points for ratification

1. Judge model family: stay `claude-haiku-4.5` (authorized today) or add a second
   vendor (e.g. gemini-flash) for stronger de-correlation from the voice lane?
2. Shadow duration: 1 week / ≥200 turns OK, or gate on a hard FP count instead?
3. Escalation on unrevisable flags (routed turns): audit-only, or post the existing
   fuse-style "flagging <owner>" message on repeat?

## Acceptance criteria (Phase 0 code)

1. Shadow mode: verdicts audited, zero revises, zero behavior change to replies.
2. Fixture replay: the three 2026-07-21 incident drafts (verbatim) each produce a
   REVISE verdict with the correct category in shadow logs.
3. FP corpus test: approval-model explanations, hedged answers ("I could not verify
   X"), short clarifying questions, and evidence-supported claims all PASS.
4. Post-guard: malformed judge output (prose, JSON, multi-line) → fail-open PASS +
   audit `judge_malformed`.
5. Fail-open proven: judge timeout/error → PASS, ≤4s added latency.
6. Flags unset → byte-identical behavior (test-pinned).
7. Security checks remain fuse-exempt and judge-independent (existing tests keep
   passing untouched).
