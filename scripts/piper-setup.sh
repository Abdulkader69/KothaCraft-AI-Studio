#!/usr/bin/env bash
# Piper TTS with the Bangladeshi Bangla voice (bn_BD, 16 speakers).
#
#   npm run piper:setup      ~150 MB total, CPU only, ~0.6 s per scene
#   npm run piper:remove     delete everything this created
#
# Lives in .venv-piper/ and .piper/ so removal is exact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-piper"; STORE="$ROOT/.piper"
PY="${PIPER_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}"
VOICE="${PIPER_VOICE:-bn_BD-google-medium}"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/bn/bn_BD/google/medium"

say() { printf '\033[36m[piper]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[piper]\033[0m %s\n' "$*" >&2; exit 1; }
[ -x "$PY" ] || die "python 3.12 not found at $PY — brew install python@3.12, or set PIPER_PYTHON"

[ -x "$VENV/bin/python" ] || { say "creating $VENV"; "$PY" -m venv "$VENV"; }
say "installing piper-tts"
"$VENV/bin/python" -m pip install --quiet --no-cache-dir --upgrade pip
"$VENV/bin/python" -m pip install --quiet --no-cache-dir "piper-tts>=1.8"

mkdir -p "$STORE"
for f in "$VOICE.onnx" "$VOICE.onnx.json"; do
  if [ ! -s "$STORE/$f" ]; then
    say "downloading $f"
    curl -sS -L --retry 8 --retry-all-errors -C - -o "$STORE/$f" "$BASE/$f"
  fi
done

# The compiled extension's default phoneme-data path is a build-machine path;
# the wheel ships the data itself, so point at that copy.
export ESPEAK_DATA_PATH="$("$VENV/bin/python" -c 'import piper,os;print(os.path.join(os.path.dirname(piper.__file__),"espeak-ng-data"))')"
say "test synthesis"
echo "আসসালামু আলাইকুম। এটি একটি পরীক্ষা।" | "$VENV/bin/piper" --model "$STORE/$VOICE.onnx" --speaker 0 --output_file "$STORE/hello.wav" >/dev/null 2>&1
[ -s "$STORE/hello.wav" ] || die "test synthesis produced no audio"
say "ok — $(du -sh "$VENV" | cut -f1) venv + $(du -sh "$STORE" | cut -f1) voice, 16 speakers"
say "set TTS_PROVIDER=piper (and PIPER_SPEAKER=0..15) or pick it in the UI"
