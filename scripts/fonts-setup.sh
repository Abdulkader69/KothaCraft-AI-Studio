#!/usr/bin/env bash
# Fetch the Arabic and Bangla faces the verse reels use.
#
# They go in assets/fonts/ and are handed to libass with the `ass` filter's
# fontsdir option — nothing is installed into the system, so this does not touch
# the boot volume and the repo stays portable.
#
# All SIL OFL 1.1, which permits redistribution. Licences are fetched alongside.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="assets/fonts"
mkdir -p "$DEST"
BASE="https://github.com/google/fonts/raw/main/ofl"

get() {  # get <url-path> <local-name>
  if [ -s "$DEST/$2" ]; then echo "  have  $2"; return; fi
  echo "  get   $2"
  curl -sL --fail -o "$DEST/$2" "$BASE/$1" || { echo "  FAILED $2" >&2; rm -f "$DEST/$2"; return 1; }
}

echo "Arabic:"
get "amiriquran/AmiriQuran-Regular.ttf"           "AmiriQuran-Regular.ttf"
get "amiri/Amiri-Regular.ttf"                     "Amiri-Regular.ttf"
get "amiri/Amiri-Bold.ttf"                        "Amiri-Bold.ttf"
get "scheherazadenew/ScheherazadeNew-Regular.ttf" "ScheherazadeNew-Regular.ttf"
get "scheherazadenew/ScheherazadeNew-Bold.ttf"    "ScheherazadeNew-Bold.ttf"

echo "Bangla:"
get "hindsiliguri/HindSiliguri-Regular.ttf"       "HindSiliguri-Regular.ttf"
get "hindsiliguri/HindSiliguri-SemiBold.ttf"      "HindSiliguri-SemiBold.ttf"
get "hindsiliguri/HindSiliguri-Bold.ttf"          "HindSiliguri-Bold.ttf"
get "notoserifbengali/NotoSerifBengali%5Bwdth,wght%5D.ttf" "NotoSerifBengali.ttf"

echo "Licences:"
for f in amiriquran amiri scheherazadenew hindsiliguri notoserifbengali; do
  [ -s "$DEST/OFL-$f.txt" ] || curl -sL --fail -o "$DEST/OFL-$f.txt" "$BASE/$f/OFL.txt" 2>/dev/null || true
done

echo
echo "Families libass will see:"
for f in "$DEST"/*.ttf; do
  fc-query -f '  %{family[0]}  —  %{style[0]}  (%{file|basename})\n' "$f" 2>/dev/null || true
done
