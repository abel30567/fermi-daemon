#!/usr/bin/env bash
# gates.sh — the project GATES. Run by the orchestrator (orch.env GATES) and by CI (.github/workflows/ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

for d in wa-bridge dc-bridge sl-bridge; do
  (cd "$d" && npm ci --no-audit --no-fund && npm test && npm run typecheck)
done
node --check warm-worker.mjs
node --check box-runner.mjs
zsh -n poll.sh
python3 -m py_compile narrator.py
if [ -f package.json ] && grep -q '"test"' package.json; then npm test; fi
