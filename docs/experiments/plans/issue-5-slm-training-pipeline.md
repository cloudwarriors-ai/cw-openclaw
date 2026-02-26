---
summary: "Issue #5 implementation plan: channel Q&A import -> fine-tune -> human eval UI -> feedback loop"
owner: "chad"
status: "draft"
last_updated: "2026-02-23"
title: "Issue #5: SLM Training Pipeline Plan"
issue: "https://github.com/cloudwarriors-ai/moltbot-workspace/issues/5"
---

# Issue #5: SLM Training Pipeline

## Scope

Build a `slm-pipeline` extension in `moltbot` that ingests approved Zoom Q&A records, builds
training/eval datasets, runs fine-tuning through Forge as the training backend, provides a human
evaluation UI/API, and closes the loop by feeding reviewer outcomes back into retraining.

## Operator Surface

1. SLM operator workflows are served by a standalone app at `apps/slm-dashboard`.
2. Built-in `moltbot` Control UI does not host SLM dashboard features.
3. Operator actions reach this pipeline through `slm.control.*` gateway methods and `/v1/slm/*` APIs.

## Locked Decisions

1. Runtime host: `moltbot` extension, not Forge.
2. Training executor: Forge CLI invoked by orchestrator.
3. Data source: approved Q&A only from Zoom workflow (plus later channel plugins).
4. Model strategy: per-tenant adapters.
5. Language v1: English only.
6. Runs: manual trigger first, scheduled later.
7. Lineage: every dataset and model pass must be traceable to source Q&A and corpus snapshot.

## Cross-Issue Dependencies

1. Depends on issue #7 for centralized durable memory and vector retrieval storage.
2. Provides training/eval artifacts consumed by issue #6 runtime adapter selection.
3. Initial implementation may use local SQL tables, but migration target remains issue #7 API.

## Current Fit with Existing Code

1. Q&A source exists: `extensions/zoom/src/monitor-handler.ts`.
2. Channel text persistence exists: `extensions/zoom/src/channel-memory.ts`.
3. Plugin lifecycle and services exist: `src/plugins/types.ts`, `src/plugins/hooks.ts`.
4. Missing pieces:
   - No generic dataset builder service.
   - No training job orchestration and artifact ledger.
   - No human eval queue and scoring API for SLM outputs.
   - No feedback merge policy into next pass.

## Target Architecture

1. New extension: `extensions/slm-pipeline`.
2. Services:
   - `QaIngestService`: import approved Q&A into canonical records.
   - `DatasetBuilderService`: produce `train.jsonl`, `eval.jsonl`, `manifest.json`.
   - `TrainingOrchestratorService`: execute Forge commands and capture artifacts.
   - `HumanEvalService`: serve review queue and persist rubric scores.
   - `FeedbackMergeService`: merge corrections into next pass with ratio caps.
3. Storage (initial):
   - Metadata in SQL tables (or issue #7 memory server once available).
   - Versioned dataset/model artifacts in filesystem object paths.
4. API routes:
   - `POST /slm-pipeline/import`
   - `POST /slm-pipeline/datasets/build`
   - `POST /slm-pipeline/train`
   - `GET /slm-pipeline/runs/:runId`
   - `GET /slm-pipeline/review-queue`
   - `POST /slm-pipeline/review/:itemId`
   - `POST /slm-pipeline/feedback/apply`

## Canonical Data Contracts

1. `ApprovedQaRecord`
   - `tenant_id`, `source_channel`, `source_message_ids[]`, `question`, `answer`, `citations[]`,
     `approved_by`, `approved_at`.
2. `DatasetExample`
   - `example_id`, `tenant_id`, `input`, `target`, `citations[]`, `policy_tags[]`,
     `redaction_flags[]`, `source_ids[]`.
3. `TrainingRun`
   - `run_id`, `tenant_id`, `dataset_manifest_hash`, `base_model`, `adapter_path`, `status`,
     `started_at`, `ended_at`.
4. `EvalItem`
   - `item_id`, `run_id`, `prompt`, `model_answer`, `gold_answer`, `citations[]`,
     `scores{accuracy, grounding, actionability}`, `review_state`.
5. `FeedbackAction`
   - `item_id`, `action_type`, `corrected_answer`, `notes`, `applied_in_run_id`.

## Dependency Task Graph

1. `T01 | lane=sequential | blocked_by=[] | goal=define contracts and schemas | owned_files=extensions/slm-pipeline/src/types.ts,extensions/slm-pipeline/src/schemas.ts`
2. `T02 | lane=parallel | blocked_by=[T01] | goal=build Q&A ingest service + source adapters | owned_files=extensions/slm-pipeline/src/qa-ingest.ts`
3. `T03 | lane=parallel | blocked_by=[T01] | goal=build dataset builder + manifest hashing | owned_files=extensions/slm-pipeline/src/dataset-builder.ts`
4. `T04 | lane=parallel | blocked_by=[T01] | goal=add SQL persistence for runs/items/feedback | owned_files=extensions/slm-pipeline/src/store.ts,extensions/slm-pipeline/migrations/*`
5. `T05 | lane=sequential | blocked_by=[T02,T03,T04] | goal=forge training orchestrator and artifact tracking | owned_files=extensions/slm-pipeline/src/training-orchestrator.ts`
6. `T06 | lane=sequential | blocked_by=[T04] | goal=human eval queue API and scoring rubric | owned_files=extensions/slm-pipeline/src/human-eval.ts,extensions/slm-pipeline/src/routes.ts`
7. `T07 | lane=sequential | blocked_by=[T05,T06] | goal=feedback merge policy and retrain prep | owned_files=extensions/slm-pipeline/src/feedback-merge.ts`
8. `T08 | lane=parallel | blocked_by=[T02,T03,T05,T06,T07] | goal=tests (unit+integration) | owned_files=extensions/slm-pipeline/test/*`
9. `T09 | lane=sequential | blocked_by=[T08] | goal=runbook + docs + issue acceptance report template | owned_files=docs/experiments/plans/issue-5-slm-training-pipeline.md,docs/*`

## Execution Phases

### Phase 1: Contracts and persistence

1. Define strict schema for every record crossing service boundaries.
2. Add migrations for run ledger, dataset manifests, eval queue, reviewer feedback.
3. Enforce tenant partition keys and uniqueness constraints.

### Phase 2: Import and dataset generation

1. Import only approved Q&A records from Zoom extension.
2. Validate citation domain allowlist and redact prohibited PII fields before dataset write.
3. Generate deterministic splits with seed + manifest hash.
4. Emit lineage map linking each example to message IDs and source URLs.

### Phase 3: Fine-tune orchestration

1. Invoke Forge train/eval with explicit domain and tenant-scoped output path.
2. Stream logs and status transitions into run ledger.
3. Persist adapter metadata (`base model`, `hyperparams`, `dataset hash`, `commit sha`).
4. Redact secrets/tokens from captured logs before persistence.

### Phase 4: Human eval and feedback loop

1. Serve blind review queue from eval items.
2. Capture rubric scores and correction text.
3. Build targeted repair dataset from failed buckets.
4. Gate retrain when correction volume or severity exceeds threshold.

### Phase 5: Operational hardening

1. Idempotency keys for import/build/train endpoints.
2. Retry policy for transient Forge failures with capped attempts.
3. Explicit run state machine (`queued -> running -> succeeded|failed|canceled`).

## Quality Gates

1. Import idempotency: re-run does not duplicate examples.
2. Lineage completeness: every dataset record links to at least one source ID.
3. Eval coverage: minimum sample count met per tenant before promoting adapter.
4. Promotion gate:
   - `accuracy >= 0.85`
   - `grounding >= 0.90`
   - `citation_validity >= 0.95`
   - `critical_policy_failures == 0`

## Test Plan

1. Unit tests:
   - schema validation rejects malformed records.
   - split generation is deterministic.
   - feedback merge obeys ratio caps.
2. Integration tests:
   - end-to-end import -> build -> train stub -> eval queue creation.
   - failed train marks run failed and preserves logs.
3. Regression tests:
   - cross-tenant contamination is impossible.
   - duplicate source IDs do not produce duplicate examples.

## Gap Analysis Iteration 1

1. Gap: review queue bias from showing model metadata.
   - Fix: blind reviewer view omits run/model identifiers.
2. Gap: stale source corpus can contaminate “gold” answers.
   - Fix: store corpus snapshot hash in manifest and block mismatch on retrain.
3. Gap: import endpoint can accept unapproved rows by mistake.
   - Fix: hard `approved_at IS NOT NULL` predicate and signed status checks.

## Gap Analysis Iteration 2

1. Gap: low-volume tenants may never hit eval sample threshold.
   - Fix: adaptive minimum with confidence interval floor and explicit “insufficient data” status.
2. Gap: repeated bad feedback from one reviewer can skew training.
   - Fix: reviewer weighting + disagreement adjudication queue.
3. Gap: runaway retrain loops.
   - Fix: max repair iterations per run and cool-down window.

## Acceptance Criteria

1. Tenant can run full pipeline from approved Q&A to trained adapter without manual DB edits.
2. Human reviewers can score and correct outputs through API/UI.
3. Feedback merges into the next dataset pass with lineage preserved.
4. Promotion only occurs when quality gates pass.
5. Runbook supports reproducible reruns from manifest hash.
