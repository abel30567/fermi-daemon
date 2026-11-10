#!/usr/bin/env bash
# gates.sh — the project GATES. Run by the orchestrator (orch.env GATES) and by CI (.github/workflows/ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/private-scan.mjs
# Committed fixtures hold fake keys only: nothing secret-shaped (scripts/scan-secrets.mjs patterns).
git ls-files -z test/fixtures evals/fixtures | xargs -0 node scripts/scan-secrets.mjs
# WhatsApp credentials must be owner-only (dirs 0700, files 0600); POSIX -perm so BSD and GNU find agree.
# -H: follow wa-auth itself if it is a symlink, but not the symlinks inside it.
if [ -d wa-auth ]; then
  leaky=$(find -H wa-auth ! -type l \( -perm -040 -o -perm -020 -o -perm -010 -o -perm -004 -o -perm -002 -o -perm -001 \))
  if [ -n "$leaky" ]; then
    printf 'wa-auth is readable beyond its owner (see README "Security model"):\n%s\n' "$leaky" >&2
    exit 1
  fi
fi
for d in wa-bridge dc-bridge sl-bridge; do
  (cd "$d" && npm ci --no-audit --no-fund && npm test && npm run typecheck)
done
node --check warm-worker.mjs
node --check box-runner.mjs
zsh -n poll.sh
python3 -m py_compile narrator.py
if [ -f package.json ] && grep -q '"test"' package.json; then npm test; fi
