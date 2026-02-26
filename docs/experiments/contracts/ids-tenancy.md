# SLM Platform IDs and Tenancy

This document defines canonical ID formats and tenancy boundaries for issues #5, #6, and #7.

## Tenancy

1. `tenant_id` is mandatory on every persisted record.
2. `tenant_id` is derived from trusted auth context or trusted channel mapping, never from untrusted payload fields.
3. Cross-tenant reads and writes are forbidden at service and repository layers.
4. Every query path must include `tenant_id` filter conditions.

## Canonical IDs

1. `trace_id`: UUID string.
2. `run_id`: UUID string.
3. `dataset_id`: UUID string.
4. `example_id`: UUID string.
5. `eval_item_id`: UUID string.
6. `feedback_id`: UUID string.
7. `memory_id`: UUID string.
8. `event_id`: UUID string.

## Required Correlation Fields

Every write event must include:

1. `tenant_id`
2. `trace_id`
3. `event_type`
4. `created_at` (ISO 8601 UTC)
5. `input_hash` (sha256, hex)
6. `output_hash` (sha256, hex or empty string when not applicable)

## Event Types

1. `qa.pending_created`
2. `qa.approved`
3. `qa.rejected`
4. `qa.training_requested`
5. `qa.training_feedback_submitted`
6. `qa.training_revised`
7. `dataset.build_started`
8. `dataset.build_succeeded`
9. `dataset.build_failed`
10. `training.run_started`
11. `training.run_succeeded`
12. `training.run_failed`
13. `supervisor.path_slm_only`
14. `supervisor.path_slm_plus_supervisor`
15. `supervisor.path_frontier_fallback`
16. `feedback.applied`

## Run State Machines

### TrainingRunStatus

1. `queued`
2. `running`
3. `succeeded`
4. `failed`
5. `canceled`

### EvalReviewState

1. `pending`
2. `in_review`
3. `completed`
4. `discarded`

## Security Rules

1. Do not log secrets or tokens.
2. Redact known sensitive metadata keys before persistence (`api_key`, `auth_token`, `secret`, `password`).
3. Treat reviewer-entered feedback as untrusted input.
4. All SQL interactions must use parameterized statements.
