# Porting the Fermi daemon to a Linux box

The goal: package everything under `~/fermi-daemon` as a self-contained agent box.
Today it runs on a Mac (dev/test); this maps every component to its Linux
equivalent and flags the Mac-only pieces.

## Architecture (what actually runs)

| Service (launchd label) | What it is | Portable? |
|---|---|---|
| `com.fermi.warm-worker` | `warm-worker.mjs` — persistent `claude -p` stream (hot MCP + Fermi connector). Drains the queue in ~11s/reply. Control endpoint on `127.0.0.1:8791` (`POST /abort` emergency stop, `GET/POST /model` model switch). | ✅ pure Node |
| `com.fermi.heartbeat` | `poll.sh` every 60s — proactive check-ins + cold-spawn fallback when the warm worker is down. | ⚠️ zsh + BSD `stat` (see below) |
| `com.fermi.wa-bridge` | `wa-bridge/` — WhatsApp via baileys. Inbound text + media download (`media/`), outbox, emergency-stop detection (`isStopCommand` → warm-worker `/abort`). | ✅ pure Node/TS |
| `com.fermi.dc-bridge` | `dc-bridge/` — Discord bridge. | ✅ pure Node/TS |
| (spawned per turn) | `narrator.py` — tails a run log, posts per-tool progress to the chat via `/admin/narrate`; redacts secrets. | ✅ python3 + curl |
| (invoked by agent) | `tools/transcribe.sh` — local STT (whisper.cpp + ffmpeg, models auto-download to `models/`). | ✅ bash, env-overridable |

Server side (Cloudflare Worker at `FERMI_URL`) is unchanged by the port — the box
only needs outbound HTTPS to it.

## launchd → systemd

Each plist becomes a systemd **user** unit (or system unit with `User=`).
Key mappings:

| launchd | systemd |
|---|---|
| `KeepAlive` | `Restart=always` |
| `ThrottleInterval` | `RestartSec=` |
| `StartInterval: 60` (heartbeat) | prefer a systemd **timer**: `OnUnitActiveSec=60s` + oneshot service |
| `AbandonProcessGroup` (heartbeat) | `KillMode=process` on the oneshot (poll.sh nohup-detaches workers) |
| `StandardOutPath/StandardErrorPath` | `StandardOutput=append:…` or journald |
| `EnvironmentVariables.PATH` | `Environment=PATH=…` |

Sketch (`fermi-warm-worker.service`):
```ini
[Unit]
Description=Fermi warm worker
After=network-online.target
[Service]
ExecStart=/usr/bin/node %h/fermi-daemon/warm-worker.mjs
WorkingDirectory=%h/fermi-daemon
Restart=always
RestartSec=10
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
[Install]
WantedBy=default.target
```

## Dependencies to provision

- **Node ≥ 22** (type-stripping runs the TS bridges directly: `node src/index.ts`)
- **claude CLI** (`~/.local/bin/claude`) — logged in (Max plan OAuth) so the
  claude.ai Fermi connector works. This is the one *stateful* login besides WA.
- **ffmpeg**, **whisper.cpp** (`whisper-cli`) — for `tools/transcribe.sh`;
  models auto-download on first run
- **python3** (narrator), **curl**, **jq**-free (scripts use grep/sed only)
- npm deps: `wa-bridge/node_modules`, `dc-bridge/node_modules` (baileys, pino…)

## State to migrate (copy these, everything else is code)

- `.env` — FERMI_URL, FERMI_BEARER_TOKEN, WA_WEBHOOK_SECRET (+ optional overrides)
- `wa-auth/` — WhatsApp device session. **Copy it and the linked device moves
  with it** (don't run two boxes on the same session — WhatsApp will log both out).
  Fresh box alternative: re-pair (`npm run pair -- <E164>`; QR fallback in socket.ts).
- `warm-model` — persisted model choice (optional; defaults to sonnet)
- `models/` — whisper models (optional; auto-redownload)
- `prompts/`, `tools/`, `narrator.py`, `poll.sh`, `warm-worker.mjs` — code
- claude CLI auth: `claude login` on the box (interactive, one-time)

## Mac-isms to fix in the port (the honest list)

1. **`poll.sh` is zsh** and uses BSD `stat -f %m` and zsh globs (`*(N/)`).
   Port: bash + `stat -c %Y` (GNU), replace `*(N/)` with `find`-based lane scan.
2. **Hardcoded paths**: launchd plists and `warm-worker.mjs` pin
   `~/.nvm/versions/node/v22.22.2/bin/node` and `~/.local/bin/claude`. Port:
   resolve from PATH (`/usr/bin/env node`), keep `CLAUDE` overridable via env.
3. **`--setting-sources project,local`** on the warm worker exists to dodge the
   Mac's global `~/.claude/settings.json` observability hooks + TCC. Harmless on
   Linux; keep it (a fresh box has no global hooks anyway).
4. **TCC/permissions**: gone on Linux (a plus — the Desktop-folder prompt and
   screen-lock automation limits don't exist there). Anything using
   `mac_*` Fermi tools (screenshots, AppleScript) obviously stays Mac-only —
   the drain agent's core loop doesn't depend on them.
5. **`say`** (used once to generate test audio) — dev-only, not shipped.

## Not ported (Mac-only conveniences)

- Fermi `mac_*` MCP tools (screenshot/AppleScript/clipboard) — server-side
  feature of the connector; on Linux the agent simply won't call them.
- WhatsApp **desktop app** testing flow — testing on the box happens via the
  webhook (`POST $FERMI_URL/wa/webhook` with `x-wa-bridge-secret`).

## Smoke test on a fresh box (in order)

1. `node warm-worker.mjs` by hand → log shows `starting warm claude` +
   `control endpoint on 127.0.0.1:8791`; `curl 127.0.0.1:8791/model` answers.
2. `curl -X POST $FERMI_URL/wa/webhook …` a text task → reply lands, ~11s.
3. `tools/transcribe.sh <sample.m4a>` → transcript on stdout.
4. Send "stop" mid-task → `ABORT requested` in log, task failed "stopped by user".
5. Pair WhatsApp (`wa-bridge`, QR or code) → real message round-trip.
6. Enable the systemd units + timer; reboot; repeat 2.
