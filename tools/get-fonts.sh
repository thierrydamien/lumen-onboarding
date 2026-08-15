#!/usr/bin/env bash
# Re-fetch the self-hosted Inter woff2 files.
#
# The app serves Inter from public/fonts/ rather than Google's font CDN, so a
# client's browser makes no third-party request to render the page. These are the
# exact files Google's CSS API points at, kept as two unicode-range subsets so a
# typical client downloads only the ~47 KB latin file.
#
# Run this only to pick up a new Inter release (rare — a stale font is invisible).
# It rewrites the .woff2 files in place; if the unicode-range values in the
# @font-face blocks change upstream, update them in the three public/*.html pages
# too (tests/fonts.test.js checks all three stay identical).
#
#   bash tools/get-fonts.sh
set -euo pipefail
cd "$(dirname "$0")/.."

UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
CSS_URL="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"

mkdir -p public/fonts
css=$(curl -fsS -A "$UA" "$CSS_URL")

for sub in latin latin-ext; do
  # Each subset is preceded by a /* name */ comment in Google's CSS. Take the
  # FIRST url for the subset: every weight resolves to the same variable file.
  url=$(printf '%s\n' "$css" | awk -v want="/* $sub */" '
    $0 == want { grab = 1 }
    grab && /url\(https:/ { match($0, /https:[^)]+/); print substr($0, RSTART, RLENGTH); exit }
  ')
  if [ -z "$url" ]; then echo "could not find $sub in the CSS" >&2; exit 1; fi
  curl -fsS -A "$UA" -o "public/fonts/inter-$sub.woff2" "$url"
  printf '  inter-%-10s %6s bytes  <- %s\n' "$sub.woff2" "$(wc -c < "public/fonts/inter-$sub.woff2")" "${url##*/}"
done

# SIL OFL 1.1 requires the licence to ship with the font.
curl -fsS -o public/fonts/OFL.txt https://raw.githubusercontent.com/rsms/inter/master/LICENSE.txt
echo "  OFL.txt refreshed"
