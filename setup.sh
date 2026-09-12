#!/usr/bin/env bash
# Set up the project on Linux (including WSL).
#
#   ./setup.sh
#
# Creates a virtual environment, installs the Python dependencies, and checks
# the data files the app needs are present. Safe to re-run.

set -euo pipefail

cd "$(dirname "$0")"

if ! python3 -c 'import ensurepip' 2>/dev/null; then
  echo "python3-venv is missing. Install it first:"
  echo "  sudo apt install -y python3-venv python3-pip"
  exit 1
fi

if [ ! -d .venv ]; then
  echo "Creating .venv"
  python3 -m venv .venv
fi

echo "Installing dependencies"
./.venv/bin/python -m pip install --quiet --upgrade pip
./.venv/bin/python -m pip install --quiet anthropic numpy pandas scipy

echo
./.venv/bin/python - <<'PY'
import json
from pathlib import Path

needed = {
    "app/data/model.json": "the trained recommender",
    "app/data/idf.json": "synopsis word weights",
    "app/data/library.json": "film credits bundle",
    "app/data/festival.json": "a festival schedule",
}
for path, what in needed.items():
    file = Path(path)
    if file.exists():
        print(f"  ok      {path:26} {file.stat().st_size / 1024 / 1024:6.1f} MB  {what}")
    else:
        print(f"  MISSING {path:26}         {what}")

movielens = Path("data/ml-latest-small/ratings.csv")
print()
if movielens.exists():
    print("  MovieLens present - the evaluation can run.")
else:
    print("  MovieLens not present. Only needed to re-run the evaluation or")
    print("  retrain the model; the app itself does not use it. Get it from")
    print("  https://grouplens.org/datasets/movielens/ and unzip into data/.")
PY

cat <<'EOF'

Ready. Common commands:

  ./.venv/bin/python -m http.server 8123 --directory app   # run the app
  ./.venv/bin/python test_sanity.py                        # checks on the test
  ./.venv/bin/python run_eval.py --n-users 100             # the accuracy test
  ./.venv/bin/python eval_letterboxd.py exports/           # test on real exports

EOF
