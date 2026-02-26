#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

ALLOW_CORE="${SLM_SCOPE_ALLOW_CORE:-0}"
if [[ "${ALLOW_CORE}" == "1" ]]; then
  echo "[slm-scope] bypass enabled (SLM_SCOPE_ALLOW_CORE=1)"
  exit 0
fi

BASE_REF="${SLM_SCOPE_BASE_REF:-${GITHUB_BASE_REF:-origin/main}}"

if ! git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
  if git rev-parse --verify --quiet "origin/${BASE_REF}" >/dev/null; then
    BASE_REF="origin/${BASE_REF}"
  elif git rev-parse --verify --quiet "main" >/dev/null; then
    BASE_REF="main"
  else
    echo "[slm-scope] FAIL: could not resolve base ref for scope check (${BASE_REF})" >&2
    exit 1
  fi
fi

MERGE_BASE="$(git merge-base HEAD "${BASE_REF}")"
CHANGED_FILES="$(git diff --name-only "${MERGE_BASE}"...HEAD)"

if [[ -z "${CHANGED_FILES}" ]]; then
  echo "[slm-scope] PASS: no changed files detected"
  exit 0
fi

is_allowed_path() {
  local file_path="$1"
  case "${file_path}" in
    packages/memory-server/*) return 0 ;;
    extensions/memory-pgvector/*) return 0 ;;
    extensions/slm-pipeline/*) return 0 ;;
    extensions/slm-supervisor/*) return 0 ;;
    apps/slm-dashboard/*) return 0 ;;
    scripts/slm-local/*) return 0 ;;
    test/slm/*) return 0 ;;
    docs/experiments/contracts/*) return 0 ;;
    docs/experiments/plans/*) return 0 ;;
    docker-compose.slm-local.yml) return 0 ;;
    vitest.slm.config.ts) return 0 ;;
    vitest.slm.e2e.config.ts) return 0 ;;
    vitest.slm.playwright.config.ts) return 0 ;;
    package.json) return 0 ;;
    .github/workflows/slm-gates.yml) return 0 ;;
    *) return 1 ;;
  esac
}

violations=()
while IFS= read -r file_path; do
  [[ -z "${file_path}" ]] && continue
  if ! is_allowed_path "${file_path}"; then
    violations+=("${file_path}")
  fi
done <<< "${CHANGED_FILES}"

if [[ "${#violations[@]}" -gt 0 ]]; then
  echo "[slm-scope] FAIL: out-of-scope files detected for SLM rollout PR" >&2
  printf '  - %s\n' "${violations[@]}" >&2
  echo "[slm-scope] If this change is intentional, set SLM_SCOPE_ALLOW_CORE=1 and document justification." >&2
  exit 1
fi

echo "[slm-scope] PASS"
