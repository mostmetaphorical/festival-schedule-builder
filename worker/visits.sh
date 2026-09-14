#!/usr/bin/env bash
# Print page loads per day, and the total.
#
#   worker/visits.sh        the last 30 days
#   worker/visits.sh 365    the last 365 days
#
# Read with wrangler, never over the web: the Worker has no route that reads
# anything back.

set -euo pipefail
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export CI=1

DAYS="${1:-30}"
case "$DAYS" in ''|*[!0-9]*) echo "Usage: $0 [days]" >&2; exit 1 ;; esac

SUMMARY=$(cat <<'PY'
import json, sys
rows = json.load(sys.stdin)[0]["results"]
if not rows:
    print("No visits counted yet.")
    sys.exit()
for row in rows:
    print(f"  {row['day']}  {row['count']:>6}")
print(f"  {'total':<10}  {sum(r['count'] for r in rows):>6}")
PY
)

npx --yes wrangler@4 d1 execute festrec-visits --remote --json --command \
  "SELECT day, count FROM visits WHERE day >= date('now', '-$DAYS days') ORDER BY day" 2>/dev/null \
  | python3 -c "$SUMMARY"
