---
summary: "Issue #6 implementation plan: SLM-first answer path with frontier supervisor and feedback capture"
owner: "chad"
status: "draft"
last_updated: "2026-02-23"
title: "Issue #6: SLM-First Answer Architecture Plan"
issue: "https://github.com/cloudwarriors-ai/moltbot-workspace/issues/6"
---

# Issue #6: SLM-First Answer Architecture

## Scope

Implement a supervised answer architecture where tenant SLM adapters answer first, frontier models
act as supervisors only when needed, and every decision is captured for evaluation and retraining.

## Operator Surface

1. Runtime supervision and training-studio operations are managed from the standalone app at `apps/slm-dashboard`.
2. Built-in `moltbot` Control UI excludes SLM dashboard functionality.
3. Operator flows call supervisor capabilities through `slm.control.session.*` methods and `/v1/slm/supervisor/*` routes.

## Locked Decisions

1. Primary responder is SLM adapter per tenant.
2. Frontier model usage is conditional and policy-driven, not default.
3. Every response path is trace-logged with reasons for escalation/fallback.
4. Supervisor output is structured: verdict + edits + confidence + policy flags.
5. Feedback capture is mandatory for all escalated or corrected answers.

## Cross-Issue Dependencies

1. Depends on issue #5 for active adapter registry and retraining feedback ingestion.
2. Depends on issue #7 for trace persistence, searchable decisions, and long-term analytics.

## Current Fit with Existing Code

1. Existing response flow and plugin hooks can host policy middleware.
2. Existing Zoom extension has QA context and channel message handling.
3. Missing pieces:
   - Answer policy engine (SLM confidence, grounding checks, escalation rules).
   - Supervisor orchestration contract.
   - Standardized trace schema for answer path decisions.
   - Feedback capture tied to runtime decisions.

## Target Architecture

1. New extension: `extensions/slm-supervisor`.
2. Runtime components:
   - `PrimaryAnswerService` (SLM inference).
   - `ConfidenceAndGroundingScorer` (deterministic + model signals).
   - `EscalationPolicyEngine` (when to ask frontier supervisor).
   - `SupervisorService` (frontier model critique/edit).
   - `DecisionTracer` (records path, latency, confidence, changes).
3. Extension boundaries:
   - Uses issue #5 training metadata to select active adapter.
   - Uses issue #7 memory server for trace storage and retrieval.

## Request/Response Contract

1. Input:
   - `tenant_id`, `channel_id`, `user_message`, `context_refs[]`.
2. Primary output:
   - `answer_text`, `citations[]`, `slm_confidence`, `grounding_score`.
3. Supervisor verdict:
   - `action=approve|edit|reject|insufficient_evidence`
   - `edited_answer_text`
   - `reason_codes[]`
   - `policy_flags[]`
4. Final response:
   - `final_answer`, `source_path=slm_only|slm_plus_supervisor|frontier_direct_fallback`
   - `trace_id`

## Policy Engine Rules (v1)

1. Accept SLM answer directly when:
   - confidence >= threshold
   - grounding >= threshold
   - no policy flags
2. Escalate to supervisor when:
   - confidence below threshold
   - missing/invalid citations
   - potential policy violation
   - ambiguity requiring clarification
3. Hard fallback to frontier direct answer when:
   - SLM fails to produce output
   - supervisor returns reject and no safe repair is possible
   - supervisor times out or returns malformed payload

## Dependency Task Graph

1. `T01 | lane=sequential | blocked_by=[] | goal=define decision/trace schemas + policy config | owned_files=extensions/slm-supervisor/src/types.ts,extensions/slm-supervisor/src/config.ts`
2. `T02 | lane=parallel | blocked_by=[T01] | goal=build primary SLM inference adapter selector | owned_files=extensions/slm-supervisor/src/primary-answer.ts`
3. `T03 | lane=parallel | blocked_by=[T01] | goal=implement confidence/grounding scorer | owned_files=extensions/slm-supervisor/src/scoring.ts`
4. `T04 | lane=parallel | blocked_by=[T01] | goal=implement escalation policy engine | owned_files=extensions/slm-supervisor/src/policy.ts`
5. `T05 | lane=sequential | blocked_by=[T02,T03,T04] | goal=integrate frontier supervisor service | owned_files=extensions/slm-supervisor/src/supervisor.ts`
6. `T06 | lane=sequential | blocked_by=[T05] | goal=assemble orchestration flow with guardrails | owned_files=extensions/slm-supervisor/src/orchestrator.ts`
7. `T07 | lane=parallel | blocked_by=[T06] | goal=add decision trace persistence + feedback hooks | owned_files=extensions/slm-supervisor/src/trace-store.ts,extensions/slm-supervisor/src/feedback.ts`
8. `T08 | lane=parallel | blocked_by=[T06,T07] | goal=HTTP/tool surface + runtime integration in zoom extension | owned_files=extensions/slm-supervisor/src/routes.ts,extensions/zoom/src/*`
9. `T09 | lane=parallel | blocked_by=[T08] | goal=tests (policy, fallback, trace integrity, latency budget) | owned_files=extensions/slm-supervisor/test/*`
10. `T10 | lane=sequential | blocked_by=[T09] | goal=runbook + rollout guard docs | owned_files=docs/experiments/plans/issue-6-slm-first-answer-architecture.md,docs/*`

## Execution Phases

### Phase 1: Contracts and policy

1. Define strict score ranges and reason codes.
2. Define tenant-level policy configuration with safe defaults.
3. Add input validation and normalized error payloads.

### Phase 2: Primary SLM path

1. Resolve active adapter from training registry.
2. Run inference with timeout and token/latency budgets.
3. Run deterministic citation/grounding checks.

### Phase 3: Supervisor path

1. Serialize candidate answer + evidence into supervisor prompt contract.
2. Parse supervisor verdict strictly; reject malformed outputs.
3. Apply edit/reject logic with policy gates.

### Phase 4: Feedback and observability

1. Persist full decision trace with trace ID.
2. Capture user/reviewer feedback per response.
3. Expose analytics: escalation rate, edit rate, reject rate, latency by path.

### Phase 5: Controlled rollout

1. Enable by tenant allowlist.
2. Start with shadow mode (supervisor checks but does not alter answer).
3. Promote to active mode when shadow metrics are stable.

## SLOs and Guardrails

1. p95 response latency budget per path:
   - `slm_only <= 2.5s`
   - `slm_plus_supervisor <= 6.0s`
2. Escalation rate target: between 10% and 40% (outside range triggers tuning).
3. Frontier direct fallback rate <= 5% after stabilization.
4. Zero critical policy violations in promoted path.
5. Supervisor timeout budget <= 2.5s with deterministic fallback behavior.

## Test Plan

1. Unit tests:
   - policy threshold boundaries.
   - reason code mapping.
   - malformed supervisor response handling.
2. Integration tests:
   - slm-only path returns stable trace payload.
   - escalation path edits answer and records causal reason.
   - frontier fallback path triggers on SLM timeout/failure.
3. Load and resilience tests:
   - concurrent requests preserve tenant isolation.
   - supervisor outage degrades gracefully.

## Gap Analysis Iteration 1

1. Gap: over-escalation can erase SLM cost benefits.
   - Fix: adaptive thresholds with per-tenant calibration and weekly drift checks.
2. Gap: supervisor can hallucinate edits outside provided evidence.
   - Fix: reject edits without citation overlap and route to insufficient-evidence response.
3. Gap: trace volume can become expensive.
   - Fix: sampled full traces + compact summary traces with retention policy.

## Gap Analysis Iteration 2

1. Gap: policy thresholds may drift after new adapter deploys.
   - Fix: threshold recomputation tied to model version activation.
2. Gap: feedback loops may overfit to noisy user thumbs-down.
   - Fix: weighted feedback using reviewer confidence and repeated-signal minimum.
3. Gap: silent regressions in supervisor prompt changes.
   - Fix: version supervisor prompt templates and require A/B eval before activation.

## Acceptance Criteria

1. SLM-first path is default for enabled tenants.
2. Supervisor intervention only occurs when policy rules require it.
3. Every final answer has a trace ID with complete decision chain.
4. Feedback events are persisted and consumable by issue #5 retraining loop.
5. Rollout can be disabled instantly per tenant without downtime.
