#!/usr/bin/env bash
# transcribe — local speech-to-text for the Fermi daemon (whisper.cpp).
#
# Usage:  transcribe.sh <audio-file> [lang]
#         lang: en (default, fastest) | auto | es | fr | ...
# Output: transcript text on stdout. Diagnostics on stderr. Exit non-zero on failure.
#
# Portable by design (macOS dev box today, Linux box later):
#   - binaries resolved from PATH; override with WHISPER_BIN / FFMPEG_BIN
#   - models live in $DAEMON_HOME/models; override with WHISPER_MODEL
#   - models auto-download from Hugging Face on first use
#   - no macOS-only commands (stat -f, say, etc.)
#
# Deps: whisper.cpp (brew install whisper-cpp / apt build), ffmpeg.
set -eu

DAEMON_HOME="${DAEMON_HOME:-$HOME/fermi-daemon}"
MODEL_DIR="${MODEL_DIR:-$DAEMON_HOME/models}"
WHISPER_BIN="${WHISPER_BIN:-$(command -v whisper-cli || true)}"
FFMPEG_BIN="${FFMPEG_BIN:-$(command -v ffmpeg || true)}"
HF_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

err() { echo "transcribe: $*" >&2; }

[ $# -ge 1 ] || { err "usage: transcribe.sh <audio-file> [lang]"; exit 2; }
IN="$1"
LANG_OPT="${2:-en}"
[ -f "$IN" ] || { err "no such file: $IN"; exit 2; }
[ -n "$WHISPER_BIN" ] || { err "whisper-cli not found (install whisper.cpp; or set WHISPER_BIN)"; exit 3; }
[ -n "$FFMPEG_BIN" ] || { err "ffmpeg not found (or set FFMPEG_BIN)"; exit 3; }

# English-only model is smaller/faster; anything else needs the multilingual one.
if [ "$LANG_OPT" = "en" ]; then
	MODEL_FILE="ggml-base.en.bin"
else
	MODEL_FILE="ggml-base.bin"
fi
MODEL="${WHISPER_MODEL:-$MODEL_DIR/$MODEL_FILE}"

if [ ! -f "$MODEL" ]; then
	err "model $MODEL missing — downloading $MODEL_FILE (~150MB, one-time)"
	mkdir -p "$(dirname "$MODEL")"
	curl -fsSL --retry 3 -o "$MODEL.part" "$HF_BASE/$MODEL_FILE"
	mv "$MODEL.part" "$MODEL"
fi

# Run from a directory that's guaranteed readable — whisper-cli calls getcwd()
# at startup and aborts if the caller's cwd is unreadable (seen under sandboxes).
cd "$DAEMON_HOME"

# whisper.cpp wants 16kHz mono wav.
TMP_WAV="$(mktemp "${TMPDIR:-/tmp}/transcribe-XXXXXX").wav"
trap 'rm -f "$TMP_WAV"' EXIT
"$FFMPEG_BIN" -hide_banner -loglevel error -y -i "$IN" -ar 16000 -ac 1 "$TMP_WAV"

if [ "$LANG_OPT" = "en" ]; then
	"$WHISPER_BIN" -m "$MODEL" -f "$TMP_WAV" -nt 2>/dev/null
else
	"$WHISPER_BIN" -m "$MODEL" -f "$TMP_WAV" -nt -l "$LANG_OPT" 2>/dev/null
fi
