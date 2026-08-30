#!/usr/bin/env bash
# teams-send — post a message to the Teams "fermi-bridge" channel via the
# Power Automate inbound-webhook flow (adaptive card).
#
# Usage: teams-send.sh "message text"
# Reads TEAMS_OUTBOUND_URL from $DAEMON_HOME/.env. Exit 0 on HTTP 2xx.
set -eu
DAEMON_HOME="${DAEMON_HOME:-$HOME/fermi-daemon}"
TEXT="${1:?usage: teams-send.sh \"message text\"}"

# URL lives in its own file, not .env — it contains '&' which breaks shell `source`.
URL="$(cat "$DAEMON_HOME/teams-outbound.url" 2>/dev/null)"
[ -n "$URL" ] || { echo "teams-outbound.url missing/empty" >&2; exit 3; }

# Build the payload with node for safe JSON escaping of arbitrary text.
BODY="$(node -e '
const text = process.argv[1]
process.stdout.write(JSON.stringify({
  type: "message",
  attachments: [{
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      type: "AdaptiveCard",
      version: "1.4",
      body: [{ type: "TextBlock", text, wrap: true }],
    },
  }],
}))' "$TEXT")"

CODE=$(curl -s -o /tmp/teams-send-last.txt -w "%{http_code}" -m 20 -X POST "$URL" \
  -H "content-type: application/json" --data-binary "$BODY")
case "$CODE" in
  2*) echo "sent ($CODE)" ;;
  *) echo "send failed ($CODE): $(head -c 200 /tmp/teams-send-last.txt)" >&2; exit 1 ;;
esac
