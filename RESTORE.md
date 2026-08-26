# Restoring the Fermi drain agent + MacOSMCP on this Mac

Two systems let Fermi (the Cloudflare Worker MCP at `<your-worker>.workers.dev`)
control this machine. Both are user-session LaunchAgents (never LaunchDaemons —
they need the Keychain-based `claude` login and the GUI session).

| Piece | What it is | LaunchAgent | Code lives in |
|---|---|---|---|
| Drain agent | `poll.sh` fires every 60s, curls Fermi's task queue, spawns up to 5 `claude -p` lanes with `prompts/drain.md` to claim + work tasks | `com.fermi.heartbeat` | this repo (`~/fermi-daemon`) |
| Discord bridge | Discord bot → Fermi channel queue, pokes `poll.sh` on message | `com.fermi.dc-bridge` | `dc-bridge/` |
| WhatsApp bridge | Baileys WA client → Fermi channel queue | `com.fermi.wa-bridge` | `wa-bridge/` (auth in `wa-auth/`, not in git) |
| MacOSMCP | MCP server on `127.0.0.1:3847` exposing the `mac_*` tools (shell, AppleScript, files, screenshots, browser) | `com.macos-mcp.agent` | `~/Desktop/2026Code/MacOSMCP` (github.com/<your-github>/MacOSMCP) |
| Tunnel | cloudflared tunnel `macos-mcp` → `https://mac.<your-domain>` → `:3847` | `com.macos-mcp.tunnel` | `~/.cloudflared/config-macos-mcp.yml` |

Fermi reaches the Mac via the tunnel URL + `AGENT_TOKEN` (stored on the Worker as
wrangler secrets `MACOS_MCP_URL` / `MACOS_MCP_TOKEN`). The drain lanes reach Fermi
through the claude.ai **Fermi connector** on the Max account — that is account
config, not machine config, so nothing local to restore for it. Never set
`ANTHROPIC_API_KEY` in the daemon env: it disables the connector.

## What is NOT in git (must come from a secrets bundle)

- `~/fermi-daemon/.env` — `FERMI_URL`, `FERMI_BEARER_TOKEN`, `WA_WEBHOOK_SECRET`, `DISCORD_BRIDGE_SECRET`, `DISCORD_BOT_TOKEN`, `TUNNEL_URL` (see `.env.example`)
- `~/Desktop/2026Code/MacOSMCP/.env` — `AGENT_TOKEN`, `PORT`, `ALLOWED_PATHS`, `LOG_DIR`
- `~/.cloudflared/` — `config-macos-mcp.yml`, `cert.pem`, `<tunnel-id>.json`
- `~/fermi-daemon/wa-auth/` — WhatsApp device session (re-pairable; not backed up)

Run `./backup-secrets.sh` to bundle the first three into
`~/fermi-daemon-backups/secrets-<ts>.tar.gz`. **Copy the newest bundle off this
disk.** Re-run whenever a token rotates.

## Restore from scratch

1. Prereqs: Homebrew, `brew install cloudflared`, bun (`~/.bun/bin/bun`),
   nvm with a recent node (the bridge plists reference a node dir via
   `__NODE_DIR__`, which `restore.sh` substitutes to your resolved node path),
   Claude Code (`claude`) logged in with the Max account that has the Fermi
   connector enabled.
2. `git clone <this repo> ~/fermi-daemon`
3. `git clone https://github.com/<your-github>/MacOSMCP.git ~/Desktop/2026Code/MacOSMCP`
4. Restore secrets: `tar -xzf secrets-<ts>.tar.gz -C ~` (paths inside are
   home-relative, so this drops every file back in place).
   - If the cloudflared creds are gone for good: `cd MacOSMCP && ./scripts/tunnel-setup.sh`
     (re-login, recreates the tunnel + DNS route), then update `MACOS_MCP_URL` /
     `MACOS_MCP_TOKEN` on the Worker with `wrangler secret put`.
   - If `MacOSMCP/.env` is gone: `./scripts/install.sh` generates a new
     `AGENT_TOKEN` — you must then `wrangler secret put MACOS_MCP_TOKEN` on the Worker.
5. `~/fermi-daemon/restore.sh` — installs deps, templates `launchd/*.plist.template`
   into `~/Library/LaunchAgents` (substituting your `$HOME` and node dir),
   bootstraps all agents, prints health.
6. WhatsApp only: `cd wa-bridge && npm run pair -- <E164 digits>`, scan the QR,
   then `launchctl kickstart -k gui/$UID/com.fermi.wa-bridge`.

## Verify it is healthy

```sh
launchctl list | grep -E 'fermi|macos-mcp'        # heartbeat shows "-  0" (runs on interval); others have a PID
curl -s http://127.0.0.1:3847/health              # {"ok":true,...,"tools":25}
curl -s "$TUNNEL_URL/health"                       # same, through the tunnel (TUNNEL_URL from .env)
tail -5 ~/fermi-daemon/logs/poll.log              # "reactive: N pending ... spawning" / "heartbeat: spawning check-in"
ls -t ~/fermi-daemon/runs | head -1 | xargs -I{} tail -c 800 ~/fermi-daemon/runs/{}   # "subtype":"success"
```
From any Fermi client: call `mac_system_info` — it should return this Mac's
hostname (`<your-hostname>.local`).

## Known quirks

- `poll.sh` can log `bad math expression` + `stat: No such file` when a lane dir
  disappears between the glob and the stat. Harmless noise in `logs/launchd.log`.
- Bun under launchd inherits `maxfiles 256`, which can trigger "low max file
  descriptors" crash loops. If MacOSMCP flaps after a restore, add to
  `com.macos-mcp.agent.plist.template`:
  `<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>4096</integer></dict>`
- `runs/` grows without bound; prune it periodically. Same for the files under
  `logs/` and `media/`.
- `wa-bridge` refuses to start while `wa-auth/` holds a `LOGGED_OUT` marker
  (device removed from WhatsApp Linked Devices). Fix = delete `wa-auth/` and re-pair.
