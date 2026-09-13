#!/usr/bin/env bash
# Download shared ratings into exports/ for eval_letterboxd.py.
#
#   worker/download-ratings.sh            download everything new
#   worker/download-ratings.sh --delete   also remove them from Cloudflare
#                                         once safely on disk (frees space)
#
# exports/ is gitignored: these are people's rating histories and never go in
# the repository. Identical files (someone sharing twice) are skipped.

set -euo pipefail
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export CI=1

DELETE=false
[ "${1:-}" = "--delete" ] && DELETE=true

OUT="../exports"
mkdir -p "$OUT"
wrangler() { npx --yes wrangler@4 "$@"; }

keys=$(wrangler kv key list --binding SHARES --remote --prefix ratings/ 2>/dev/null \
  | python3 -c 'import json,sys; [print(k["name"]) for k in json.load(sys.stdin)]')

if [ -z "$keys" ]; then
  echo "No shared ratings waiting."
  exit 0
fi

new=0; duplicate=0; removed=0
while IFS= read -r key; do
  tmp=$(mktemp)
  wrangler kv key get "$key" --binding SHARES --remote > "$tmp" 2>/dev/null

  # Name files by content, so a second share of the same history is spotted.
  hash=$(sha256sum "$tmp" | cut -c1-16)
  day=$(echo "$key" | cut -d/ -f2)
  target="$OUT/shared-$day-$hash-ratings.csv"

  if [ -e "$target" ] || ls "$OUT"/*-"$hash"-ratings.csv >/dev/null 2>&1; then
    duplicate=$((duplicate + 1))
    rm -f "$tmp"
  else
    mv "$tmp" "$target"
    new=$((new + 1))
    echo "  saved $(basename "$target") ($(($(wc -l < "$target") - 1)) ratings)"
  fi

  # Only delete remotely once the file is confirmed on disk.
  if $DELETE && ls "$OUT"/*-"$hash"-ratings.csv >/dev/null 2>&1; then
    wrangler kv key delete "$key" --binding SHARES --remote >/dev/null 2>&1 && removed=$((removed + 1))
  fi
done <<< "$keys"

echo
echo "$new new, $duplicate duplicates skipped$($DELETE && echo ", $removed removed from Cloudflare")."
echo "Run the test on them with: ./.venv/bin/python eval_letterboxd.py exports/"
if ! $DELETE; then
  echo "Stored copies stay on Cloudflare until you run this with --delete."
fi
