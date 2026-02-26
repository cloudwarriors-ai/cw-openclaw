# SLM Definition of Done Contract

This contract is mandatory for SLM rollout workstreams and follow-up changes touching:

1. `packages/memory-server/**`
2. `extensions/memory-pgvector/**`
3. `extensions/slm-pipeline/**`
4. `extensions/slm-supervisor/**`
5. `apps/slm-dashboard/**`
6. `scripts/slm-local/**`
7. `test/slm/**`

## Contract Goals

1. Keep SLM extensions independently loadable and package-safe.
2. Enforce tenant-safe memory and route boundaries.
3. Require reproducible integration, smoke, and UI e2e coverage.
4. Make pass/fail machine-checkable and CI-enforced.

## Required Quality Rules

1. No cross-extension source imports:
   1. `extensions/slm-pipeline/**` must not import from `extensions/zoom/src/**`.
   2. `extensions/slm-supervisor/**` must not import from `extensions/slm-pipeline/src/**`.
2. Pipeline and supervisor HTTP routes must enforce optional SLM token auth when enabled:
   1. `OPENCLAW_SLM_HTTP_REQUIRE_AUTH=1`
   2. `OPENCLAW_SLM_HTTP_AUTH_TOKEN=<token>`
   3. Header: `x-openclaw-slm-token`.
3. Memory server must preserve compatibility and retention behavior:
   1. `/memories/*` canonical routes.
   2. `/memory/*` compatibility aliases.
   3. Soft delete semantics (`deleted_at`) with explicit include switch.
   4. Auth compatibility for both `Authorization: Bearer ...` and `X-Memory-API-Key`.
4. Dashboard gateway access must use least privilege scopes for required SLM control methods only.
5. Smoke bootstrap must fail fast with explicit timeout behavior.
6. PR scope hygiene is mandatory for rollout branches:
   1. Only approved SLM paths may change unless explicit override is documented.
   2. Core `src/**` changes are blocked by default for this rollout phase.

## Mandatory Test Gates

All gates must pass before merge:

1. Integration:
   1. `bunx --bun vitest run --config vitest.slm.config.ts`
2. API E2E:
   1. `bunx --bun vitest run --config vitest.slm.e2e.config.ts`
3. Playwright UI E2E:
   1. `bun node_modules/playwright-core/cli.js install chromium`
   2. `bunx --bun vitest run --config vitest.slm.playwright.config.ts`
   3. Required for `pipeline` and `full` PR stages.
4. Smoke:
   1. Memory stage: `bash scripts/slm-local/smoke.sh`
   2. Pipeline stage: `bash scripts/slm-local/smoke-issue-9.sh`
   3. Full stage: `bash scripts/slm-local/smoke-issues-5-6-7.sh`
5. PR scope hygiene:
   1. `bash scripts/slm-local/pr-scope-check.sh`

## CI Enforcement

1. `.github/workflows/slm-gates.yml` is required status for SLM path changes.
2. Path filter may no-op for unrelated PRs, but must execute full SLM gates when scoped files change.
3. Smoke run must publish JSON summary artifact (`SLM_SMOKE_SUMMARY_PATH`).
4. PRs must pass scope hygiene check against `origin/<base-branch>`.

## Evidence Required In PR

1. Integration gate output.
2. API e2e gate output.
3. Playwright UI e2e gate output.
4. Smoke output and uploaded summary artifact path.
5. Explicit statement that no disallowed cross-extension imports were introduced.

## Merge Condition

1. Any red gate or contract violation blocks merge.
2. Partial/manual validation is not sufficient for SLM PR acceptance.
