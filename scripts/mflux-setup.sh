#!/usr/bin/env bash
# Local image generation on Apple Silicon via mflux.
#
#   npm run mflux:setup      install + download the model (~6 GB, one time)
#   npm run mflux:remove     delete everything this script created
#
# Everything lives inside the project so removal is exact:
#   .venv-mflux/   the Python environment
#   .mflux/        model weights (HF_HOME) and mflux's own cache
# Nothing is written to ~/.cache, so kokoro and MMS are untouched either way.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-mflux"
STORE="$ROOT/.mflux"
PY="${MFLUX_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}"
MODEL="${MFLUX_MODEL:-filipstrand/Z-Image-Turbo-mflux-4bit}"

say() { printf '\033[36m[mflux]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[mflux]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "arm64" ] || die "mflux needs Apple Silicon (this is $(uname -m))"
[ -x "$PY" ] || die "python 3.12 not found at $PY — brew install python@3.12, or set MFLUX_PYTHON"

if [ ! -x "$VENV/bin/python" ]; then
  say "creating $VENV"
  "$PY" -m venv "$VENV"
fi
say "installing mflux into the venv"
# --no-cache-dir: otherwise pip parks ~500 MB of wheels in ~/Library/Caches/pip,
# which mflux:remove would have no business deleting.
"$VENV/bin/python" -m pip install --quiet --no-cache-dir --upgrade pip
"$VENV/bin/python" -m pip install --quiet --no-cache-dir --upgrade mflux "huggingface_hub[cli]"

mkdir -p "$STORE/hf" "$STORE/cache"
export HF_HOME="$STORE/hf"
export MFLUX_CACHE_DIR="$STORE/cache"
# Hugging Face's Xet transfer backend intermittently fails with
# "CAS Client Error ... error decoding response body" and does not resume.
# Plain HTTP is slower but reliable, and this only runs once.
export HF_HUB_DISABLE_XET=1

say "downloading $MODEL into .mflux/ and running one test image"
say "(first run pulls ~6 GB — a few minutes on a good connection)"
mkdir -p "$STORE/test"
# One CLI per model family — the FLUX one rejects Z-Image and vice versa.
case "$MODEL" in
  *[Zz]-[Ii]mage-[Tt]urbo*) CLI=mflux-generate-z-image-turbo ;;
  *[Zz]-[Ii]mage*)          CLI=mflux-generate-z-image ;;
  *[Kk]rea*)                CLI=mflux-generate-krea2 ;;
  *[Ff][Ll][Uu][Xx]2*|*FLUX.2*) CLI=mflux-generate-flux2 ;;
  *)                        CLI=mflux-generate ;;
esac
# Download first, separately from generating, with a resumable client in a
# retry loop. A DNS blip or a dropped connection then only pauses the transfer
# instead of throwing away everything fetched so far. Re-running this script
# after a failure also resumes.
HFCLI="$VENV/bin/hf"; [ -x "$HFCLI" ] || HFCLI="$VENV/bin/huggingface-cli"
attempt=1
until "$HFCLI" download "$MODEL" --quiet >/dev/null 2>&1; do
  [ "$attempt" -ge 30 ] && die "download kept failing after $attempt attempts — check your connection and re-run (it resumes)"
  say "download interrupted (attempt $attempt) — resuming in 15s"
  attempt=$((attempt + 1)); sleep 15
done
say "model downloaded — generating a test image"

"$VENV/bin/$CLI" \
  --model "$MODEL" \
  --prompt "a quiet green valley at sunrise, mist between trees, no people" \
  --width 512 --height 512 --steps 4 --seed 1 \
  --output "$STORE/test/hello.png"

[ -s "$STORE/test/hello.png" ] || die "test generation produced no image"
say "ok — test image at .mflux/test/hello.png"
say "footprint: $(du -sh "$VENV" | cut -f1) venv + $(du -sh "$STORE" | cut -f1) models"
say "set IMAGE_PROVIDER=mflux in .env (or pick it in the UI) to use it"
