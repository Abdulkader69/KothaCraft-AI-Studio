#!/usr/bin/env bash
# Remove the Bangladeshi VITS provider completely. Touches nothing else.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\033[36m[vits-bd]\033[0m %s\n' "$*"; }
freed=0
for t in "$ROOT/.venv-vits-bd" "$ROOT/.vits-bd"; do
  if [ -e "$t" ]; then s=$(du -sm "$t" | cut -f1); rm -rf "$t"; freed=$((freed+s)); say "removed ${t#$ROOT/} ($s MB)"; fi
done
[ "$freed" -eq 0 ] && say "nothing to remove — vits-bd is not installed" || say "freed ~$((freed/1024)) GB. Nothing outside the project was touched."
