"""Fetch film metadata from TMDB so the recommender can see past the genre.

Director, writer, cast and keywords are what let the model score a film nobody
has rated yet, so this is what makes the cold condition realistic.

Supply the key either way:
  - put it in a file called tmdb_key.txt next to this script, or
  - set a TMDB_API_KEY environment variable.

    python enrich_tmdb.py

Free for non-commercial use with attribution. The script is resumable: it
writes as it goes and skips films already in the cache.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import urllib.request
import urllib.error

API = "https://api.themoviedb.org/3/movie/{tmdb_id}"
APPEND = "credits,keywords"
CAST_DEPTH = 6  # beyond the top billing, shared actors stop meaning much
SAVE_EVERY = 200


KEY_FILE = Path(__file__).with_name("tmdb_key.txt")


def read_api_key() -> str | None:
    """Environment variable first, then a key file kept out of version control."""
    key = os.environ.get("TMDB_API_KEY")
    if key:
        return key.strip()
    if KEY_FILE.exists():
        return KEY_FILE.read_text(encoding="utf-8").strip() or None
    return None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--out", default="data/tmdb_cache.json")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--limit", type=int, default=0,
                   help="stop after N films (for a quick trial)")
    return p.parse_args()


def fetch(tmdb_id: int, api_key: str, attempts: int = 4) -> dict | None:
    """One film. Retries on rate limits and transient server errors."""
    url = f"{API.format(tmdb_id=tmdb_id)}?api_key={api_key}&append_to_response={APPEND}"
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code in (429, 500, 502, 503, 504):
                time.sleep(float(error.headers.get("Retry-After", 2**attempt)))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2**attempt)
    return None


def condense(payload: dict) -> dict:
    """Keep the fields the features actually use."""
    crew = payload.get("credits", {}).get("crew", [])
    cast = payload.get("credits", {}).get("cast", [])
    return {
        "title": payload.get("title"),
        "runtime": payload.get("runtime"),
        # Genre is the signal that carries when nobody involved is familiar -
        # the festival-premiere case. See the thin-evidence table in README.
        "genre": [g["name"] for g in payload.get("genres") or []],
        "director": [c["name"] for c in crew if c.get("job") == "Director"],
        "writer": [
            c["name"] for c in crew
            if c.get("job") in ("Writer", "Screenplay", "Story")
        ],
        "cast": [c["name"] for c in cast[:CAST_DEPTH]],
        "keyword": [
            k["name"] for k in payload.get("keywords", {}).get("keywords", [])
        ],
        "country": [
            c["iso_3166_1"] for c in payload.get("production_countries", [])
        ],
        "language": [payload["original_language"]]
        if payload.get("original_language") else [],
        # Kept for later: synopsis similarity needs the text.
        "overview": payload.get("overview") or "",
    }


def main() -> None:
    args = parse_args()
    api_key = read_api_key()
    if not api_key:
        sys.exit(
            "No TMDB key found. Get a free one at themoviedb.org "
            f"(Settings -> API), then paste it into {KEY_FILE.name} next to "
            "this script, or set TMDB_API_KEY in the environment."
        )

    links = pd.read_csv(Path(args.data) / "links.csv").dropna(subset=["tmdbId"])
    out_path = Path(args.out)
    cache: dict[str, dict] = {}
    if out_path.exists():
        cache = json.loads(out_path.read_text(encoding="utf-8"))

    todo = [
        (int(row.movieId), int(row.tmdbId))
        for row in links.itertuples()
        if str(int(row.movieId)) not in cache
    ]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(cache)} cached, fetching {len(todo)} films")
    done = 0

    def work(pair: tuple[int, int]) -> tuple[int, dict | None]:
        movie_id, tmdb_id = pair
        payload = fetch(tmdb_id, api_key)
        return movie_id, condense(payload) if payload else None

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for movie_id, record in pool.map(work, todo):
            done += 1
            if record:
                cache[str(movie_id)] = record
            if done % SAVE_EVERY == 0:
                out_path.write_text(json.dumps(cache), encoding="utf-8")
                print(f"  {done}/{len(todo)}", flush=True)

    out_path.write_text(json.dumps(cache), encoding="utf-8")
    print(f"Wrote {out_path} with {len(cache)} films")
    print("Data supplied by TMDB. This product uses the TMDB API but is not "
          "endorsed or certified by TMDB.")


if __name__ == "__main__":
    main()
