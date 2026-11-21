#!/usr/bin/env bash
# Install the official headless Antigravity CLI (v1.5.14) into
# /opt/fermi/antigravity during Fermi Fleet AMI bake.
#
# Run as root on the bake EC2 instance (Ubuntu/Debian, x86_64 or arm64).
# Requires: curl, tar, sha512sum, ca-certificates.
set -euo pipefail

VERSION="1.5.14"
BUILD="5302690847260672"
DEST="/opt/fermi/antigravity"

case "$(uname -m)" in
  x86_64|amd64)
    URL="https://storage.googleapis.com/antigravity-public/antigravity-cli/${VERSION}-${BUILD}/linux-x64/cli_linux_x64.tar.gz"
    SHA512="83311d3f354567612dc16c1ae2ea9b503d6f6833aa4e138d39aa229da3f3bb99b0e4d7cca0bce4796b0060d6a51d8113eb7449ed5dc0e7900bf217107ea5bff9"
    ;;
  aarch64|arm64)
    URL="https://storage.googleapis.com/antigravity-public/antigravity-cli/${VERSION}-${BUILD}/linux-arm/cli_linux_arm64.tar.gz"
    SHA512="c9b29bba475f63a1a80161ae93ba72b221c7a586d9851e4d0061546704bab66d6b2760b25d716d191724fc7564f3246456ee151e28aa37af48dbcd72bdc6c463"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "Downloading Antigravity CLI v${VERSION} ($(uname -m))..."
curl -fsSL --retry 4 --retry-delay 3 "$URL" -o "$tmp/antigravity.tar.gz"
echo "${SHA512}  $tmp/antigravity.tar.gz" | sha512sum -c -

rm -rf "${DEST}.new"
mkdir -p "${DEST}.new"
tar -xzf "$tmp/antigravity.tar.gz" -C "${DEST}.new"

if [ ! -f "${DEST}.new/antigravity" ]; then
  echo "Missing expected binary 'antigravity' in archive" >&2
  exit 1
fi
chmod 0755 "${DEST}.new/antigravity"

# Ensure world-readable/executable under /opt/fermi so the unprivileged `fermi`
# systemd user can execute the baked binary under ProtectSystem=strict.
chmod -R a+rX "${DEST}.new"
rm -rf "${DEST}"
mv "${DEST}.new" "${DEST}"
echo "Installed Antigravity CLI v${VERSION} into ${DEST}"
ls -lh "${DEST}/antigravity"
"${DEST}/antigravity" acp --help >/dev/null
