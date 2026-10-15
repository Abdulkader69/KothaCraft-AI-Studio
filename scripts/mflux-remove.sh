#!/usr/bin/env bash
# Remove local image generation completely — the inverse of mflux-setup.sh.
#
#   npm run mflux:remove
#
# Deletes only what setup created (.venv-mflux and .mflux). The kokoro/MMS venv,
# their model caches, and everything in ~/.cache are left alone. Re-run
# `npm run mflux:setup` at any time to get it back.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-mflux"
STORE="$ROOT/.mflux"

say() { printf '\033[36m[mflux]\033[0m %s\n' "$*"; }

freed=0
for target in "$VENV" "$STORE"; do
  if [ -e "$target" ]; then
    size=$(du -sm "$target" 2>/dev/null | cut -f1)
    rm -rf "$target"
    freed=$((freed + size))
    say "removed ${target#$ROOT/}  ($size MB)"
  fi
done

if [ "$freed" -eq 0 ]; then
  say "nothing to remove — mflux is not installed"
else
  say "freed ~$((freed / 1024)) GB. Nothing outside the project was touched."
  say "if IMAGE_PROVIDER=mflux is set in .env, switch it to pollinations or cloudflare"
fi
