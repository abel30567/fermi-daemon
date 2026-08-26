#!/bin/zsh
# Re-install the Fermi drain agent + MacOSMCP LaunchAgents on this Mac.
# Idempotent. Run after: git clone into ~/fermi-daemon, secrets restored
# (see RESTORE.md), MacOSMCP cloned to ~/Desktop/2026Code/MacOSMCP.
set -eu
DAEMON_HOME="$HOME/fermi-daemon"
MCP_HOME="$HOME/Desktop/2026Code/MacOSMCP"
cd "$DAEMON_HOME"

[[ -f .env ]] || { echo "missing $DAEMON_HOME/.env — restore secrets first"; exit 1 }
[[ -f "$MCP_HOME/.env" ]] || { echo "missing $MCP_HOME/.env — restore secrets first"; exit 1 }
[[ -f "$HOME/.cloudflared/config-macos-mcp.yml" ]] || { echo "missing ~/.cloudflared — restore secrets first"; exit 1 }
command -v claude >/dev/null || { echo "install Claude Code (claude) and log in with the Max account"; exit 1 }
command -v cloudflared >/dev/null || { echo "brew install cloudflared"; exit 1 }
[[ -x "$HOME/.bun/bin/bun" ]] || { echo "install bun: curl -fsSL https://bun.sh/install | bash"; exit 1 }

# Resolve the node install dir so we can substitute it into the plist templates.
# The bridge plists reference the node version dir via __NODE_DIR__ (a path
# segment relative to $HOME, e.g. .nvm/versions/node/vXX.Y.Z).
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || echo "WARN: node not found on PATH — install nvm + a recent node, or the bridge plists will point at a missing node"
NODE_VER_DIR="$(dirname "$(dirname "${NODE_BIN:-$HOME/.nvm/versions/node/current/bin/node}")")"
NODE_DIR="${NODE_VER_DIR#$HOME/}"   # relative to $HOME for __NODE_DIR__ substitution

mkdir -p logs runs lanes state "$HOME/.macos-mcp"
chmod +x poll.sh
(cd dc-bridge && npm install --silent)
(cd wa-bridge && npm install --silent)
(cd "$MCP_HOME" && "$HOME/.bun/bin/bun" install --silent)

for p in launchd/*.plist.template; do
	label="${p:t:r:r}"   # strip .template then .plist -> the LaunchAgent label
	dest="$HOME/Library/LaunchAgents/$label.plist"
	sed -e "s|__HOME__|$HOME|g" -e "s|__NODE_DIR__|$NODE_DIR|g" "$p" >"$dest"
	launchctl bootout "gui/$UID/$label" 2>/dev/null || true
	launchctl bootstrap "gui/$UID" "$dest"
	echo "loaded $label"
done

sleep 5
echo "--- status"; launchctl list | grep -E 'fermi|macos-mcp'
echo "--- local health";  curl -sf -m 5 http://127.0.0.1:3847/health && echo
source ./.env   # FERMI_URL, FERMI_BEARER_TOKEN, TUNNEL_URL
if [[ -n "${TUNNEL_URL:-}" ]]; then
	echo "--- tunnel health"; curl -sf -m 15 "$TUNNEL_URL/health" && echo
else
	echo "--- tunnel health: skipped (TUNNEL_URL unset in .env)"
fi
echo "--- queue reachable"
curl -sf -m 10 -H "Authorization: Bearer $FERMI_BEARER_TOKEN" "$FERMI_URL/admin/tasks/pending" && echo
echo "done. wa-bridge needs a manual re-pair if it shows exit 1 (see RESTORE.md)."
