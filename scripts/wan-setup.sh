#!/usr/bin/env bash
# Local image-to-video on Apple Silicon — Wan 2.2 TI2V-5B via mlx-video.
#
#   npm run wan:setup      install + download + convert the model (one time)
#   npm run wan:remove     delete everything this script created
#
# Everything lives inside the project so removal is exact:
#   .venv-wan/   the Python environment (mlx-video + deps, ~1 GB)
#   .wan/        the converted model (~21 GB) — the PyTorch download is deleted
#                after conversion, so the temporary peak is ~45 GB of disk
# Needs 36 GB unified memory or more; nothing stays in RAM between renders.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-wan"
STORE="$ROOT/.wan"
PY="${WAN_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}"
REPO="${WAN_REPO:-Wan-AI/Wan2.2-TI2V-5B}"
SRC="$STORE/download"
MODEL="$STORE/Wan2.2-TI2V-5B-MLX"

say() { printf '\033[36m[wan]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[wan]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "arm64" ] || die "mlx needs Apple Silicon (this is $(uname -m))"
[ -x "$PY" ] || die "python 3.12 not found at $PY — brew install python@3.12, or set WAN_PYTHON"
mem=$(( $(sysctl -n hw.memsize) / 1073741824 ))
[ "$mem" -ge 32 ] || die "this Mac has ${mem} GB — the 5B model needs 32 GB or more"

if [ ! -x "$VENV/bin/python" ]; then
  say "creating $VENV"
  "$PY" -m venv "$VENV"
fi
say "installing mlx-video into the venv"
"$VENV/bin/python" -m pip install --quiet --no-cache-dir --upgrade pip
"$VENV/bin/python" -m pip install --quiet --no-cache-dir --upgrade "git+https://github.com/Blaizzy/mlx-video.git" huggingface_hub

mkdir -p "$STORE"
export HF_HOME="$STORE/hf"
export HF_HUB_DISABLE_XET=1

if [ -f "$MODEL/config.json" ]; then
  say "model already converted at .wan/ — skipping download"
else
  say "downloading $REPO into .wan/download/ (~22 GB — this takes a while)"
  HFCLI="$VENV/bin/hf"; [ -x "$HFCLI" ] || HFCLI="$VENV/bin/huggingface-cli"
  attempt=1
  until "$HFCLI" download "$REPO" --local-dir "$SRC" --quiet >/dev/null 2>&1; do
    [ $attempt -ge 20 ] && die "download kept failing — check the connection and re-run"
    say "download interrupted (attempt $attempt) — resuming in 15s"
    sleep 15; attempt=$((attempt + 1))
  done
  say "converting to MLX format (a few minutes)"
  "$VENV/bin/python" -m mlx_video.models.wan_2.convert --checkpoint-dir "$SRC" --output-dir "$MODEL"
  say "removing the PyTorch download — the converted model is all that is needed"
  rm -rf "$SRC" "$STORE/hf"
fi

say "test clip: 21 frames at 480x832 (a minute or two)"
mkdir -p "$STORE/test"
"$VENV/bin/python" -m mlx_video.models.wan_2.generate \
  --model-dir "$MODEL" --image "$ROOT/assets/brand/profile-400.png" \
  --prompt "slow zoom in, gentle light" --width 480 --height 832 --num-frames 21 --steps 10 \
  --seed 1 --output-path "$STORE/test/test.mp4"
[ -s "$STORE/test/test.mp4" ] || die "test clip was not written"

say "done — set VIDEO_PROVIDER=local (or pick it in the UI) and mark scenes motion: \"ai\""
say "disk used: $(du -sh "$STORE" | cut -f1) in .wan/, $(du -sh "$VENV" | cut -f1) in .venv-wan/"
