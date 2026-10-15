#!/usr/bin/env bash
# Edge TTS — Microsoft's neural voices (bn-BD Nabanita / Pradeep among ~300) through
# the Edge browser's read-aloud endpoint. Free, no account, ~10 MB. Unofficial: it
# can be rate-limited or change without notice, so keep a local voice as fallback.
#
#   npm run edge:setup      venv with edge-tts + a test line
#   npm run edge:remove     delete everything this created
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv-edge"; STORE="$ROOT/.edge"
PY="${EDGE_PYTHON:-/opt/homebrew/opt/python@3.12/bin/python3.12}"
[ -x "$PY" ] || PY="$(command -v python3)"

say() { printf '\033[36m[edge]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[edge]\033[0m %s\n' "$*" >&2; exit 1; }

[ -x "$VENV/bin/python" ] || { say "creating $VENV with $PY"; "$PY" -m venv "$VENV"; }
say "installing edge-tts"
"$VENV/bin/python" -m pip install --quiet --no-cache-dir --upgrade pip
"$VENV/bin/python" -m pip install --quiet --no-cache-dir "edge-tts>=7"

mkdir -p "$STORE/test"
echo "আসসালামু আলাইকুম। এটি একটি পরীক্ষা।" > "$STORE/test/line.txt"
say "running a test line through bn-BD-NabanitaNeural"
"$VENV/bin/python" "$ROOT/scripts/edge_speak.py" "$STORE/test/line.txt" "$STORE/test/hello.mp3" "$STORE/test/hello.words.json" 2>&1 | tail -3
[ -s "$STORE/test/hello.mp3" ] || die "test synthesis produced no audio — the endpoint may be blocking right now; try again later"
say "ok — $(du -sh "$VENV" | cut -f1) venv. Test line: $STORE/test/hello.mp3"
say "set TTS_PROVIDER=edge or pick it in the UI"
