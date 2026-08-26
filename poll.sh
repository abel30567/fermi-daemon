#!/bin/zsh
# Fermi daemon poll — fired every 60s by the com.fermi.heartbeat LaunchAgent,
# and on demand by the channel bridges after a message arrives. Cheap curl
# checks the task queue; up to MAX_CONCURRENT claude -p workers drain it in
# parallel (task_claim is an atomic D1 claim, so concurrent workers never
# double-process). Runs from ~/fermi-daemon: a clean cwd is required or
# claude -p crashes with EINTR.
set -u

DAEMON_HOME="$HOME/fermi-daemon"
cd "$DAEMON_HOME" || exit 1
# NOTE: do not export ANTHROPIC_API_KEY here — claude prefers it over the
# Max login and it disables claude.ai connectors (Fermi tools) entirely.
source ./.env # FERMI_URL, FERMI_BEARER_TOKEN (+ optional overrides below)

MAX_CONCURRENT="${MAX_CONCURRENT:-5}"        # parallel drain lanes
MAX_RUN_SECONDS="${MAX_RUN_SECONDS:-1200}"   # per-lane watchdog (20min). Long enough for real
                                             # work (repo edits, multi-step jobs); safe because the
                                             # Fermi-tools-only policy blocks Playwright hangs and 5
                                             # lanes mean a long task never blocks other replies.
MAX_RUNS_PER_HOUR="${MAX_RUNS_PER_HOUR:-0}"  # 0/unset = unlimited; set >0 to cap runs/hour
HEARTBEAT_SECONDS="${HEARTBEAT_SECONDS:-1800}"
MAX_TURNS="${MAX_TURNS:-50}"
MODEL="${MODEL:-claude-opus-4-6[1m]}"        # model for daemon claude -p runs (1M-context Opus 4.6)
# Server-level grants: all Fermi tools via the claude.ai connector (no local
# MCP config or OAuth) + all Playwright tools (user-scope MCP, local browser).
ALLOWED_TOOLS="${ALLOWED_TOOLS:-mcp__claude_ai_Fermi,mcp__playwright}"
LANE_DIR="$DAEMON_HOME/lanes"
mkdir -p "$LANE_DIR"
rm -f "$DAEMON_HOME/run.lock" 2>/dev/null # legacy single-lock cleanup

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>logs/poll.log }

now=$(date +%s)

# --- 1. Reap finished/dead/stale lanes --------------------------------------
for lane in "$LANE_DIR"/*(N/); do
	pid=$(cat "$lane/pid" 2>/dev/null)
	if [[ -z "$pid" ]]; then
		# lane just claimed but pid not written yet — only reap if clearly orphaned
		(( now - $(stat -f %m "$lane") > 30 )) && rm -rf "$lane"
		continue
	fi
	if ! kill -0 "$pid" 2>/dev/null; then
		rm -rf "$lane"
		continue
	fi
	age=$(( now - $(stat -f %m "$lane/pid") ))
	if (( age > MAX_RUN_SECONDS )); then
		log "watchdog: killing stuck lane ${lane:t} (pid $pid, ${age}s old)"
		pkill -P "$pid" 2>/dev/null
		kill "$pid" 2>/dev/null
		sleep 2
		pkill -9 -P "$pid" 2>/dev/null
		kill -9 "$pid" 2>/dev/null
		rm -rf "$lane"
	fi
done
live=$(ls -d "$LANE_DIR"/*(N/) 2>/dev/null | wc -l | tr -d ' ')

# --- 2. Optional run budget guardrail (opt-in via MAX_RUNS_PER_HOUR > 0) -----
if ((MAX_RUNS_PER_HOUR > 0)); then
	recent=$(find runs -name '*.log' -mmin -60 2>/dev/null | wc -l | tr -d ' ')
	if ((recent >= MAX_RUNS_PER_HOUR)); then
		log "budget: $recent runs in the last hour (max $MAX_RUNS_PER_HOUR), skipping"
		exit 0
	fi
fi

# --- 3. Lane helpers --------------------------------------------------------
# Atomically claim a free lane 1..MAX_CONCURRENT via mkdir (race-safe across
# concurrent poll.sh invocations). Echoes the lane path, or nothing if full.
acquire_lane() {
	local i
	for i in $(seq 1 "$MAX_CONCURRENT"); do
		if mkdir "$LANE_DIR/$i" 2>/dev/null; then
			printf '%s' "$LANE_DIR/$i"
			return 0
		fi
	done
	return 1
}

# Detached nohup spawn from the clean dir (EINTR-safe). Each worker owns its
# lane and removes it on exit. Only heartbeat runs persist a session id for
# --resume (concurrent drain runs must not race on session.id).
spawn_run() {
	local prompt_file="$1"
	shift
	local extra_args="$*"
	local lane
	lane=$(acquire_lane) || { log "all $MAX_CONCURRENT lanes busy — deferring $prompt_file"; return 1; }
	local ts capture="" narrator=""
	ts="$(date +%Y%m%d-%H%M%S)-$$-$RANDOM"
	if [[ "$prompt_file" == heartbeat.md ]]; then
		capture="sid=\$(grep -oE '\"session_id\"[[:space:]]*:[[:space:]]*\"[^\"]+\"' runs/$ts.log | head -1 | cut -d'\"' -f4); [[ -n \"\$sid\" ]] && echo \"\$sid\" >session.id"
	fi
	# Drain runs get a narrator that tails their stream-json and posts per-step
	# progress to the task's channel (best-effort; never affects the executor).
	if [[ "$prompt_file" == drain.md ]]; then
		narrator="python3 '$DAEMON_HOME/narrator.py' 'runs/$ts.log' >/dev/null 2>&1 &"
	fi
	nohup zsh -c "
		cd '$DAEMON_HOME'
		$narrator
		claude -p \"\$(cat prompts/$prompt_file)\" \
			--model '$MODEL' \
			--max-turns $MAX_TURNS \
			--allowedTools '$ALLOWED_TOOLS' \
			$extra_args >runs/$ts.log 2>&1
		$capture
		rm -rf '$lane'
	" >/dev/null 2>&1 &
	echo $! >"$lane/pid"
	log "spawned $prompt_file in lane ${lane:t} (pid $(cat "$lane/pid"), log runs/$ts.log)"
}

# --- 4. Reactive: fan out drain workers up to the concurrency limit ---------
# Reactive draining is owned by the warm worker (com.fermi.warm-worker), which
# keeps a hot claude + connector and replies in ~15s vs a cold spawn's minutes.
# Cold-spawn here only as a FALLBACK when the warm worker is DOWN — otherwise a
# cold opus worker races the warm worker for the same task and wastes a slow run.
if ! pgrep -f 'warm-worker\.mjs' >/dev/null 2>&1; then
	pending=$(curl -sf -m 10 -H "Authorization: Bearer $FERMI_BEARER_TOKEN" \
		"$FERMI_URL/admin/tasks/pending" | grep -oE '"pending"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+$')
	pending="${pending:-0}"

	if ((pending > 0)); then
		free=$(( MAX_CONCURRENT - live ))
		(( free < 0 )) && free=0
		to_spawn=$(( pending < free ? pending : free ))
		if (( to_spawn > 0 )); then
			log "reactive (fallback, warm worker down): $pending pending, spawning $to_spawn"
			for (( k = 0; k < to_spawn; k++ )); do
				spawn_run drain.md --output-format stream-json --verbose
			done
		fi
		exit 0
	fi
fi

# --- 5. Proactive: heartbeat when idle and the interval has elapsed ---------
if (( live < MAX_CONCURRENT )); then
	last_heartbeat=0
	[[ -f last-heartbeat ]] && last_heartbeat=$(stat -f %m last-heartbeat)
	if (( now - last_heartbeat > HEARTBEAT_SECONDS )); then
		resume_args=""
		[[ -s session.id ]] && resume_args="--resume $(cat session.id)"
		log "heartbeat: spawning check-in"
		spawn_run heartbeat.md --output-format json $resume_args
		touch last-heartbeat
	fi
fi
exit 0
