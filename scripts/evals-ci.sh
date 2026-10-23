#!/usr/bin/env bash
# evals-ci.sh — the evals workflow's two stages (.github/workflows/evals.yml).
#
#   evals-ci.sh run --entry '{"harness":"claude-code","model":"…"}' --cell <label> -k <n> --out <dir> \
#     --artifacts <dir> [--worker <fermi-mcp checkout>] [--weekly] [--no-variants] --scenarios '<glob>'...
#
# One matrix cell (a pack, or the smoke, under one harness): runs evals/run.mjs, then writes
# <artifacts>/<harness>-<model>/<cell>/{results.json,summary.json,outcome} (outcome: success|failure;
# results.json only if run.mjs wrote one) and <out>/run.log, and scans both for the token and
# secret-shaped strings. The attempt dirs (the transcripts) stay in <out>.
#
#   evals-ci.sh report --entries '[{"harness":…,"model":…},…]' --cells '<label> …' --in <dir> \
#     --out <dir> --artifacts <dir> [--title <text>]
#
# The aggregate: <in> holds the run stage's artifacts dirs merged. Per entry, joins its cells'
# results.json, compares that with the first entry's (the baseline; the baseline with itself), and
# writes <artifacts>/<harness>-<model>/{compare.md,<cell>/summary.json} (the files to upload),
# <out>/comment.md (the PR comment) and <out>/outcome: failure if any cell failed or is missing.
# Scans the comment and <artifacts> for secret-shaped strings.
#
# Token (run only): on the fd named by CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR (never an env var or
# argument), read once into an unexported variable, then handed to run.mjs (--auth fd --judge-auth
# fd) and to scripts/scan-secrets.mjs on fresh pipes. Without it run.mjs gets no auth (--harness fake).
# Exit 0 when the scan is clean (the evals' own result is in the outcome file), 1 on a scan
# finding, 2 on a usage error.
set -uo pipefail
cd "$(dirname "$0")/.."

usage() { echo "evals-ci: $1" >&2; exit 2; }
name_of() { jq -r '"\(.harness)-\(.model // "default")"' <<<"$1"; }

stage=${1:-}
[ $# -gt 0 ] && shift
entry= entries= cell= cells= k= in= out= artifacts= worker= weekly= novariants= title=evals
scenarios=()
while [ $# -gt 0 ]; do
  case "$1" in
    --entry) entry=$2; shift 2 ;;
    --entries) entries=$2; shift 2 ;;
    --cell) cell=$2; shift 2 ;;
    --cells) cells=$2; shift 2 ;;
    -k) k=$2; shift 2 ;;
    --in) in=$2; shift 2 ;;
    --out) out=$2; shift 2 ;;
    --artifacts) artifacts=$2; shift 2 ;;
    --worker) worker=$2; shift 2 ;;
    --title) title=$2; shift 2 ;;
    --weekly) weekly=1; shift ;;
    --no-variants) novariants=1; shift ;;
    --scenarios) shift; while [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; do scenarios+=("$1"); shift; done ;;
    *) usage "unknown argument $1" ;;
  esac
done
[ -n "$out" ] && [ -n "$artifacts" ] || usage "needs --out and --artifacts"

case "$stage" in
  run)
    [ -n "$entry" ] && [ -n "$cell" ] && [ -n "$k" ] && [ ${#scenarios[@]} -gt 0 ] || usage "run needs --entry, --cell, -k and --scenarios"
    token=
    if [ -n "${CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:-}" ]; then
      fd=$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
      token=$(cat <&"$fd") || exit 2
      eval "exec $fd<&-"
      unset CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
      [ -n "$token" ] || usage "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR holds no token"
    fi
    harness=$(jq -r '.harness' <<<"$entry") || exit 2
    model=$(jq -r '.model // empty' <<<"$entry")
    name=$(name_of "$entry")
    args=(--harness "$harness" -k "$k" --out "$out/$name/$cell" --scenarios "${scenarios[@]}")
    [ -n "$model" ] && args+=(--model "$model")
    [ -n "$worker" ] && args+=(--worker "$worker")
    [ -n "$weekly" ] && args+=(--weekly)
    [ -n "$novariants" ] && args+=(--no-variants)
    dest=$artifacts/$name/$cell
    mkdir -p "$out" "$dest"
    log=$out/run.log
    echo "== $name $cell" | tee "$log"
    if [ -n "$token" ]; then
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3 node evals/run.mjs "${args[@]}" --auth fd --judge-auth fd 3< <(printf '%s' "$token") 2>&1 | tee -a "$log"
    else
      node evals/run.mjs "${args[@]}" 2>&1 | tee -a "$log"
    fi
    code=${PIPESTATUS[0]}
    echo "== $name $cell: run.mjs exit $code" | tee -a "$log"
    for f in results.json summary.json; do
      [ -f "$out/$name/$cell/$f" ] && cp "$out/$name/$cell/$f" "$dest/$f"
    done
    [ "$code" -eq 0 ] && [ -f "$dest/results.json" ] && echo success >"$dest/outcome" || echo failure >"$dest/outcome"
    if [ -n "$token" ]; then
      node scripts/scan-secrets.mjs --token-fd 3 "$log" "$artifacts" 3< <(printf '%s' "$token")
    else
      node scripts/scan-secrets.mjs "$log" "$artifacts"
    fi
    ;;

  report)
    [ -n "$entries" ] && [ -n "$cells" ] && [ -n "$in" ] || usage "report needs --entries, --cells and --in"
    n=$(jq 'length' <<<"$entries") || exit 2
    [ "$n" -gt 0 ] || usage "--entries is empty"
    read -ra cellv <<<"$cells"
    mkdir -p "$out" "$artifacts"
    outcome=success
    names=()
    for i in $(seq 0 $((n - 1))); do
      name=$(name_of "$(jq -c ".[$i]" <<<"$entries")")
      names+=("$name")
      parts=()
      for c in "${cellv[@]}"; do
        [ "$(cat "$in/$name/$c/outcome" 2>/dev/null)" = success ] || outcome=failure
        [ -f "$in/$name/$c/results.json" ] && parts+=("$in/$name/$c/results.json")
        if [ -f "$in/$name/$c/summary.json" ]; then
          mkdir -p "$artifacts/$name/$c"
          cp "$in/$name/$c/summary.json" "$artifacts/$name/$c/summary.json"
        fi
      done
      [ ${#parts[@]} -gt 0 ] || continue
      mkdir -p "$out/$name"
      jq -s 'add' "${parts[@]}" >"$out/$name/results.json"
      base=$out/${names[0]}/results.json
      [ -f "$base" ] || base=$out/$name/results.json
      node evals/compare.mjs "$base" "$out/$name/results.json" --out "$out/$name" >/dev/null
      [ -f "$out/$name/compare.md" ] && cp "$out/$name/compare.md" "$artifacts/$name/compare.md"
    done
    echo "$outcome" >"$out/outcome"

    comment=$out/comment.md
    {
      echo "## $title: $outcome"
      echo
      echo "| harness | model | cell | passed | unexpected | invalid | setup errors | skipped |"
      echo "|---|---|---|---|---|---|---|---|"
      for name in "${names[@]}"; do
        for c in "${cellv[@]}"; do
          s=$artifacts/$name/$c/summary.json
          if [ -f "$s" ]; then
            jq -r --arg c "$c" '"| \(.harness) | \(.model // "default") | \($c) | \(.passed)/\(.attempts) | \(.unexpected | length) | \(.invalid | length) | \(.setupErrors | length) | \(.skipped | length) |"' "$s"
          else
            echo "| $name | | $c | no results (see the job log) | | | | |"
          fi
        done
      done
      echo
      echo "The first harness is the baseline; each report compares that harness's cells, joined, with the baseline's (the baseline with itself)."
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
    node scripts/scan-secrets.mjs "$comment" "$artifacts"
    ;;

  *) usage "the first argument is run or report" ;;
esac
