#!/usr/bin/env bash
# Remove Piper TTS completely — inverse of piper-setup.sh. Touches nothing else.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\033[36m[piper]\033[0m %s\n' "$*"; }
freed=0
for t in "$ROOT/.venv-piper" "$ROOT/.piper"; do
  if [ -e "$t" ]; then s=$(du -sm "$t" | cut -f1); rm -rf "$t"; freed=$((freed+s)); say "removed ${t#$ROOT/} ($s MB)"; fi
done
[ "$freed" -eq 0 ] && say "nothing to remove — piper is not installed" || say "freed ~$freed MB. Nothing outside the project was touched."
