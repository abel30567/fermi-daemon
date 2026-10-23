#!/usr/bin/env bash
# evals-ci.sh — the evals workflow's run (.github/workflows/evals.yml): runs evals/run.mjs once
# per entry, compares each against the first (the baseline; the baseline against itself),
# then scans the run log and the report for the token and secret-shaped strings.
#
#   evals-ci.sh --entries '[{"harness":"claude-code","model":"…"},…]' -k <n> --out <dir> \
#     --artifacts <dir> [--title <text>] [--worker <fermi-mcp checkout>] [--weekly] --scenarios '<glob>'...
#
# Token: on the fd named by CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR (never an env var or argument),
# read once into an unexported variable, then handed to each run.mjs (--auth fd --judge-auth fd)
# and to scripts/scan-secrets.mjs on a fresh pipe. Without it the runs get no auth (--harness fake).
#
# Writes <artifacts>/<harness>-<model>/{summary.json,compare.md} (the only files to upload; never
# results.json or the attempt dirs, which hold transcripts), <out>/comment.md (the PR comment),
# <out>/outcome (success|failure) and <out>/run.log.
# Exit 0 when the scan is clean (the evals' own result is in <out>/outcome), 1 on a scan finding,
# 2 on a usage error.
set -uo pipefail
cd "$(dirname "$0")/.."

entries= k= out= artifacts= worker= weekly= title=evals
scenarios=()
while [ $# -gt 0 ]; do
  case "$1" in
    --entries) entries=$2; shift 2 ;;
    -k) k=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --artifacts) artifacts=$2; shift 2 ;;
    --worker) worker=$2; shift 2 ;;
    --title) title=$2; shift 2 ;;
    --weekly) weekly=1; shift ;;
    --scenarios) shift; while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do scenarios+=("$1"); shift; done ;;
    *) echo "evals-ci: unknown argument $1" >&2; exit 2 ;;
  esac
done
if [ -z "$entries" ] || [ -z "$k" ] || [ -z "$out" ] || [ -z "$artifacts" ] || [ ${#scenarios[@]} -eq 0 ]; then
  echo "evals-ci: needs --entries, -k, --out, --artifacts and --scenarios" >&2
  exit 2
fi
n=$(jq 'length' <<<"$entries") || exit 2
[ "$n" -gt 0 ] || { echo "evals-ci: --entries is empty" >&2; exit 2; }

token=
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:-}" ]; then
  fd=$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  token=$(cat <&"$fd") || exit 2
  eval "exec $fd<&-"
  unset CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  [ -n "$token" ] || { echo "evals-ci: CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR holds no token" >&2; exit 2; }
fi

mkdir -p "$out" "$artifacts"
log=$out/run.log
: >"$log"
outcome=success
names=()
for i in $(seq 0 $((n - 1))); do
  harness=$(jq -r ".[$i].harness" <<<"$entries")
  model=$(jq -r ".[$i].model // empty" <<<"$entries")
  name=$harness-${model:-default}
  names+=("$name")
  args=(--harness "$harness" -k "$k" --out "$out/$name" --scenarios "${scenarios[@]}")
  [ -n "$model" ] && args+=(--model "$model")
  [ -n "$worker" ] && args+=(--worker "$worker")
  [ -n "$weekly" ] && args+=(--weekly)
  echo "== $name" | tee -a "$log"
  if [ -n "$token" ]; then
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 node evals/run.mjs "${args[@]}" --auth fd --judge-auth fd 3< <(printf '%s' "$token") 2>&1 | tee -a "$log"
  else
    node evals/run.mjs "${args[@]}" 2>&1 | tee -a "$log"
  fi
  code=${PIPESTATUS[0]}
  echo "== $name: run.mjs exit $code" | tee -a "$log"
  [ "$code" -eq 0 ] || outcome=failure
  [ -f "$out/$name/results.json" ] || continue
  base=$out/${names[0]}/results.json
  [ -f "$base" ] || base=$out/$name/results.json
  node evals/compare.mjs "$base" "$out/$name/results.json" --out "$out/$name" >/dev/null 2>>"$log"
  mkdir -p "$artifacts/$name"
  cp "$out/$name/summary.json" "$artifacts/$name/summary.json"
  [ -f "$out/$name/compare.md" ] && cp "$out/$name/compare.md" "$artifacts/$name/compare.md"
done
echo "$outcome" >"$out/outcome"

comment=$out/comment.md
{
  echo "## $title: $outcome"
  echo
  echo "| harness | model | passed | unexpected | invalid | setup errors | skipped |"
  echo "|---|---|---|---|---|---|---|"
  for name in "${names[@]}"; do
    s=$artifacts/$name/summary.json
    if [ -f "$s" ]; then
      jq -r '"| \(.harness) | \(.model // "default") | \(.passed)/\(.attempts) | \(.unexpected | length) | \(.invalid | length) | \(.setupErrors | length) | \(.skipped | length) |"' "$s"
    else
      echo "| $name | | no results (see the run log) | | | | |"
    fi
  done
  echo
  echo "The first row is the baseline; each report compares that run with the baseline (the baseline with itself)."
  for name in "${names[@]}"; do
    [ -f "$artifacts/$name/compare.md" ] || continue
    echo
    echo "<details><summary>$name</summary>"
    echo
    cat "$artifacts/$name/compare.md"
    echo
    echo "</details>"
  done
} >"$comment"

if [ -n "$token" ]; then
  node scripts/scan-secrets.mjs --token-fd 3 "$log" "$comment" "$artifacts" 3< <(printf '%s' "$token")
else
  node scripts/scan-secrets.mjs "$log" "$comment" "$artifacts"
fi
