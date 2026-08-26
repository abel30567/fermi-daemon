# fermi-daemon

A local macOS LaunchAgent drain loop that lets a Cloudflare Worker MCP agent —
**Fermi** — run tasks on, and control, your Mac. You message Fermi from
WhatsApp or Discord; the daemon on your Mac claims those tasks, runs a
`claude` session to do the work (shell, files, browser, AppleScript, etc.), and
replies back into the chat.

It is the machine-side half of a two-part system. The other half is the Fermi
Worker (the task queue + channel routing, not in this repo) and
[MacOSMCP](https://github.com/<your-github>/MacOSMCP), an MCP server that exposes
the `mac_*` tools (shell, files, screenshots, browser) to Fermi over a
cloudflared tunnel.

## Architecture

- **`poll.sh`** — the drain loop. Fires every 60s from the
  `com.fermi.heartbeat` LaunchAgent (and on demand when a bridge receives a
  message). It curls the Worker's task queue and, when work is pending, spawns
  up to `MAX_CONCURRENT` (default 5) `claude -p` "lanes", each running
  `prompts/drain.md` to claim and complete one task at a time. Lane claiming is
  race-safe via `mkdir`, and a per-lane watchdog kills runs over
  `MAX_RUN_SECONDS`.
- **`warm-worker.mjs`** — an optional long-lived `claude` process
  (`com.fermi.warm-worker`) that keeps its MCP + Fermi connector warm so replies
  land in seconds instead of paying the cold-start cost on every message. When
  it is running, `poll.sh` defers to it and only cold-spawns as a fallback.
  Exposes a localhost control endpoint (`:8791`) for model switching and
  emergency-stop.
- **`wa-bridge/`** and **`dc-bridge/`** — the WhatsApp (Baileys) and Discord
  bridges. Each turns an inbound chat message into a queued Fermi task and pokes
  the drain loop. WhatsApp device auth lives in `wa-auth/` (not committed;
  re-pairable).
- **`narrator.py`** — tails a lane's stream-json output and posts short
  natural-language progress updates back to the originating chat, so long tasks
  don't go silent.
- **`prompts/`** — `drain.md` (the worker system prompt / tool policy) and
  `heartbeat.md` (the idle check-in prompt).
- **`tools/`** — local speech-to-text helpers (`transcribe.sh` via whisper.cpp,
  `transcribe.swift` via the macOS Speech framework) for voice-note tasks.
- **MacOSMCP + cloudflared tunnel** — run separately (see `RESTORE.md`). Fermi
  reaches your Mac through the tunnel URL guarded by `AGENT_TOKEN`.

All the moving parts run as **user-session LaunchAgents** (never LaunchDaemons):
they need the Keychain-based `claude` login and the GUI session.

## Setup

1. Clone this repo to `~/fermi-daemon`.
2. `cp .env.example .env` and fill in the values (see `.env.example` for what
   each key is).
3. Install prereqs: Homebrew, `cloudflared`, `bun`, nvm + a recent node, and
   Claude Code (`claude`) logged in with the account that has the Fermi
   connector enabled. Clone MacOSMCP as described in `RESTORE.md`.
4. Run `./restore.sh`. It installs bridge deps, renders the
   `launchd/*.plist.template` files (substituting your `$HOME` and node dir) into
   `~/Library/LaunchAgents`, bootstraps the agents, and prints a health check.
5. For WhatsApp, pair the device once:
   `cd wa-bridge && npm run pair -- <E164 digits>`, scan the QR, then kickstart
   the bridge.

Full restore-from-scratch and health-verification steps are in
[`RESTORE.md`](RESTORE.md).

## Security model

**Read this before running anything.** This daemon deliberately grants a remote
agent broad control of your Mac:

- The drain lanes run `claude` with tools that can execute arbitrary shell
  commands, read and write your files, and drive a browser. Through MacOSMCP,
  Fermi can additionally run shell, AppleScript, take screenshots, and control
  apps. Anyone who can enqueue a task, or reach the MacOSMCP tunnel, can
  effectively act as you on this machine.
- **`FERMI_BEARER_TOKEN` (this daemon) and `AGENT_TOKEN` (MacOSMCP) are the only
  things standing between the internet and shell access to your Mac.** Treat
  them like root passwords: generate them long and random, never commit them,
  rotate them if exposed. `.env`, `*.pem`, `*.key`, and secrets bundles are all
  gitignored — keep it that way.
- Never set `ANTHROPIC_API_KEY` in the daemon environment: it disables the
  claude.ai connector that provides the Fermi tools.
- **`runs/`, `logs/`, and `media/` accumulate real message content, transcripts,
  attachments, and other PII** as the daemon operates. They are gitignored and
  must **never** be committed or shared. Prune them periodically. `wa-auth/`
  holds your WhatsApp session and is likewise never committed.

This is personal-automation software. Run it only on a machine you own, exposed
only to accounts and channels you control.

## License

MIT — see [`LICENSE`](LICENSE).
