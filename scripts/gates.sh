#!/usr/bin/env bash
# gates.sh — the project GATES. Run by the orchestrator (orch.env GATES) and by CI (.github/workflows/ci.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/private-scan.mjs
# Committed fixtures hold fake keys only: nothing secret-shaped (scripts/scan-secrets.mjs patterns).
# No xargs: GNU xargs turns the scanner's exit 1 into 123, BSD keeps 1. Plain loop, not mapfile (bash 3.2 on macOS).
# The list goes through a file so a git failure is seen, and an empty dir fails, so neither skips the scan.
list=$(mktemp)
trap 'rm -f "$list"' EXIT
fixtures=()
for d in test/fixtures evals/fixtures; do
  git ls-files -z -- "$d" > "$list" || { echo "scan-secrets: git ls-files $d failed" >&2; exit 1; }
  [ -s "$list" ] || { echo "scan-secrets: no tracked files under $d (renamed? update scripts/gates.sh)" >&2; exit 1; }
  while IFS= read -r -d '' f; do fixtures+=("$f"); done < "$list"
done
node scripts/scan-secrets.mjs "${fixtures[@]}"
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
