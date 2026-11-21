#!/usr/bin/env bash
# Install the official headless Antigravity ACP server (v1.3.0) into
# /opt/fermi/antigravity-acp during Fermi Fleet AMI bake.
#
# Run as root on the bake EC2 instance (Ubuntu/Debian, x86_64 or arm64).
# Requires: curl, unzip, sha256sum, ca-certificates.
set -euo pipefail

VERSION="1.3.0"
DEST="/opt/fermi/antigravity-acp"

case "$(uname -m)" in
  x86_64|amd64)
    URL="https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-${VERSION}-linux-x86_64.zip"
    SHA="9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96"
    ;;
  aarch64|arm64)
    URL="https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-${VERSION}-linux-arm64.zip"
    SHA="500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Antigravity ACP server v${VERSION} ($(uname -m))..."
curl -fsSL --retry 4 --retry-delay 3 "$URL" -o "$tmp/agy-acp-server.zip"
echo "${SHA}  $tmp/agy-acp-server.zip" | sha256sum -c -

rm -rf "${DEST}.new"
mkdir -p "${DEST}.new"
unzip -q "$tmp/agy-acp-server.zip" -d "${DEST}.new"

for bin in agy_acp_server.par localharness_external; do
  if [ ! -f "${DEST}.new/${bin}" ]; then
    echo "Missing expected binary ${bin} in archive" >&2
    exit 1
  fi
  chmod 0755 "${DEST}.new/${bin}"
done

# Ensure world-readable/executable under /opt/fermi so the unprivileged `fermi`
# systemd user can execute the baked binaries under ProtectSystem=strict.
chmod -R a+rX "${DEST}.new"
rm -rf "${DEST}"
mv "${DEST}.new" "${DEST}"
echo "Installed Antigravity ACP v${VERSION} into ${DEST}"
ls -lh "${DEST}"
