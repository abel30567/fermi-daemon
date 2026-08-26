#!/bin/zsh
# Bundle every secret the Fermi drain agent + MacOSMCP need but that git must
# not hold. Output: ~/fermi-daemon-backups/secrets-<ts>.tar.gz (mode 600).
# Copy the newest bundle somewhere off this disk (password manager / USB).
set -eu
OUT_DIR="$HOME/fermi-daemon-backups"
mkdir -p "$OUT_DIR"; chmod 700 "$OUT_DIR"
OUT="$OUT_DIR/secrets-$(date +%Y%m%d-%H%M%S).tar.gz"
( cd "$HOME" && tar -czf "$OUT" \
	fermi-daemon/.env \
	Desktop/2026Code/MacOSMCP/.env \
	.cloudflared/config-macos-mcp.yml \
	.cloudflared/cert.pem \
	.cloudflared/*.json )
chmod 600 "$OUT"
echo "wrote $OUT"
tar -tzf "$OUT"
