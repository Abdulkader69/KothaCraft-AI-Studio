#!/usr/bin/env bash
# Render every theme in scripts/bg/themes to assets/bg/<theme>.mp4
set -euo pipefail
cd "$(dirname "$0")/../.."
SECONDS_ARG="${1:-10}"
for f in scripts/bg/themes/*.json; do
  theme="$(basename "$f" .json)"
  echo "── $theme"
  npx tsx scripts/render-bg.ts --theme "$theme" --seconds "$SECONDS_ARG"
done
