#!/usr/bin/env bash
# Review festival submissions.
#
#   worker/review-festival.sh            list what's waiting
#   worker/review-festival.sh <key>      turn one into a pull request
#   worker/review-festival.sh --reject <key>   delete a submission
#
# A submission never goes live by itself. This puts it on its own branch with
# an index entry and gives you a pull request link; the validation check runs
# on the pull request, and you compare it with the official schedule before
# merging.

set -euo pipefail
cd "$(dirname "$0")/.."
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export CI=1
wrangler() { (cd worker && npx --yes wrangler@4 "$@"); }
REPO="mostmetaphorical/festival-schedule-builder"

if [ $# -eq 0 ]; then
  echo "Festival submissions waiting for review:"
  listing=$(mktemp)
  wrangler kv key list --binding SHARES --remote --prefix festival/ > "$listing" 2>/dev/null
  python3 - "$listing" <<'PY'
import json, sys
items = json.load(open(sys.argv[1]))
if not items:
    print("  none")
for item in items:
    meta = item.get("metadata") or {}
    print(f"  {item['name']}")
    print(f"      {meta.get('festival', '?')}: {meta.get('films', '?')} films, "
          f"{meta.get('screenings', '?')} screenings")
PY
  rm -f "$listing"
  echo
  echo "Review one with: worker/review-festival.sh <key>"
  exit 0
fi

if [ "$1" = "--reject" ]; then
  wrangler kv key delete "$2" --binding SHARES --remote
  echo "Deleted $2."
  exit 0
fi

KEY="$1"
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first - this switches branches."
  exit 1
fi

tmp=$(mktemp)
wrangler kv key get "$KEY" --binding SHARES --remote > "$tmp" 2>/dev/null

# Re-validate locally with the same rules the Worker used, and write the files.
slug=$(node worker/prepare-festival.mjs "$tmp")
rm -f "$tmp"

branch="festival/$slug"
git switch -c "$branch"
git add "app/data/festivals/$slug.json" app/data/festivals.json
git commit -q -m "Add festival submission: $slug

Shared through the app and stored as $KEY.
Needs checking against the official schedule before merging.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -q -u origin "$branch"
git switch -q main

echo
echo "Pushed branch $branch. Open the pull request here:"
echo "  https://github.com/$REPO/compare/main...$branch?expand=1"
echo
echo "Before merging: compare dates, times and titles with the festival's own"
echo "schedule, and fill in the city in festivals.json. Once merged, remove the"
echo "stored submission with: worker/review-festival.sh --reject $KEY"
