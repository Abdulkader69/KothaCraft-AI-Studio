#!/usr/bin/env bash
# Bangladeshi Bangla VITS (EMTIAZZ) — natural single voice, Apache-2.0, ~1 GB.
#
#   npm run vits-bd:setup      venv with a pinned Coqui stack + the model
#   npm run vits-bd:remove     delete everything this created
#
# Lives in .venv-vits-bd/ and .vits-bd/ (HF_HOME) so removal is exact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-vits-bd"; STORE="$ROOT/.vits-bd"
PY="${VITS_BD_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}"

say() { printf '\033[36m[vits-bd]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[vits-bd]\033[0m %s\n' "$*" >&2; exit 1; }
[ -x "$PY" ] || die "python 3.12 not found at $PY — brew install python@3.12, or set VITS_BD_PYTHON"

[ -x "$VENV/bin/python" ] || { say "creating $VENV"; "$PY" -m venv "$VENV"; }
say "installing the pinned Coqui stack (torch, ~600 MB)"
"$VENV/bin/python" -m pip install --quiet --no-cache-dir --upgrade pip
# Pins matter: Coqui upstream is unmaintained. transformers 5 removed a symbol it
# imports; torch >= 2.9 needs torchcodec for audio IO (the [codec] extra).
"$VENV/bin/python" -m pip install --quiet --no-cache-dir \
  "coqui-tts[codec]" "transformers<5" torch torchaudio \
  bangla bnnumerizer bnunicodenormalizer huggingface-hub

mkdir -p "$STORE/hf"
export HF_HOME="$STORE/hf" HF_HUB_DISABLE_XET=1
say "downloading the model (1 GB) and running a test line"
mkdir -p "$STORE/test"
echo "আসসালামু আলাইকুম। এটি একটি পরীক্ষা।" > "$STORE/test/line.txt"
attempt=1
until "$VENV/bin/python" "$ROOT/scripts/vits_bd_tts.py" "$STORE/test/line.txt" "$STORE/test/hello.wav" 2>&1 | grep -q "^vits-bd: wrote"; do
  [ "$attempt" -ge 10 ] && die "download/synthesis kept failing — check your connection and re-run (it resumes)"
  say "interrupted (attempt $attempt) — retrying in 15s"; attempt=$((attempt+1)); sleep 15
done
[ -s "$STORE/test/hello.wav" ] || die "test synthesis produced no audio"
say "ok — $(du -sh "$VENV" | cut -f1) venv + $(du -sh "$STORE" | cut -f1) model"
say "set TTS_PROVIDER=vits-bd or pick it in the UI"
