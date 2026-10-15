#!/usr/bin/env bash
# Remove local image-to-video completely — the inverse of wan-setup.sh.
#
#   npm run wan:remove
#
# Deletes only .venv-wan and .wan. Re-run `npm run wan:setup` to get it back.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-wan"
STORE="$ROOT/.wan"

say() { printf '\033[36m[wan]\033[0m %s\n' "$*"; }

freed=0
for target in "$VENV" "$STORE"; do
  if [ -e "$target" ]; then
    size=$(du -sm "$target" 2>/dev/null | cut -f1)
    say "removing $target ($size MB)"
    rm -rf "$target"
    freed=$((freed + size))
  fi
done
say "done — ${freed} MB freed. Scenes with motion \"ai\" now need VIDEO_PROVIDER=fal."
