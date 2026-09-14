#!/usr/bin/env bash
# Download bug reports into reports/ and print a one-line summary of each.
#
#   worker/download-reports.sh            download everything new
#   worker/download-reports.sh --delete   also remove them from Cloudflare
#                                         once safely on disk
#
# reports/ is gitignored: a report may hold someone's email address.

set -euo pipefail
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export CI=1

DELETE=false
[ "${1:-}" = "--delete" ] && DELETE=true

OUT="../reports"
mkdir -p "$OUT"
wrangler() { npx --yes wrangler@4 "$@"; }

keys=$(wrangler kv key list --binding SHARES --remote --prefix report/ 2>/dev/null \
  | python3 -c 'import json,sys; [print(k["name"]) for k in json.load(sys.stdin)]')

if [ -z "$keys" ]; then
  echo "No bug reports waiting."
  exit 0
fi

new=0; removed=0
while IFS= read -r key; do
  target="$OUT/$(echo "$key" | cut -d/ -f2)-$(basename "$key")"
  if [ ! -e "$target" ]; then
    wrangler kv key get "$key" --binding SHARES --remote > "$target" 2>/dev/null
    new=$((new + 1))
    python3 - "$target" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
message = " ".join(report["message"].split())
reply = "  (wants a reply)" if report.get("contact") else ""
print(f"  [{report.get('step', 'other')}] {message[:100]}{'…' if len(message) > 100 else ''}{reply}")
PY
  fi
  if $DELETE && [ -s "$target" ]; then
    wrangler kv key delete "$key" --binding SHARES --remote >/dev/null 2>&1 && removed=$((removed + 1))
  fi
done <<< "$keys"

echo
echo "$new new reports saved to reports/$($DELETE && echo ", $removed removed from Cloudflare")."
