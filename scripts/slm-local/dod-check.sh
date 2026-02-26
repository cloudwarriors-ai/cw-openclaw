#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v rg >/dev/null 2>&1; then
  rg() {
    grep -R --line-number --binary-files=without-match "$@"
  }
fi

echo "[slm-dod] validating extension boundaries..."
if rg -n "\.\./zoom/src" extensions/slm-pipeline extensions/slm-supervisor >/dev/null 2>&1; then
  echo "[slm-dod] FAIL: slm extensions import zoom source files" >&2
  rg -n "\.\./zoom/src" extensions/slm-pipeline extensions/slm-supervisor >&2 || true
  exit 1
fi
if rg -n "\.\./slm-pipeline/src" extensions/slm-supervisor >/dev/null 2>&1; then
  echo "[slm-dod] FAIL: slm-supervisor imports slm-pipeline source files" >&2
  rg -n "\.\./slm-pipeline/src" extensions/slm-supervisor >&2 || true
  exit 1
fi

echo "[slm-dod] validating auth guards..."
if [[ -f "extensions/slm-pipeline/index.ts" ]]; then
  rg -q "enforceSlmHttpAuth" extensions/slm-pipeline/index.ts
fi
if [[ -f "extensions/slm-supervisor/index.ts" ]]; then
  rg -q "enforceSlmHttpAuth" extensions/slm-supervisor/index.ts
fi
rg -q "x-memory-api-key" packages/memory-server/src/server.ts

echo "[slm-dod] validating required package scripts..."
rg -q "\"slm:test:integration\"" package.json
rg -q "\"slm:test:e2e\"" package.json
rg -q "\"slm:test:playwright\"" package.json
rg -q "\"slm:test:smoke\"" package.json
rg -q "\"slm:scope:check\"" package.json

echo "[slm-dod] PASS"
