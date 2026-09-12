"""Build the app's film-credits bundle straight from TMDB.

The MovieLens-derived bundle only knew films up to 2018, which missed about a
sixth of a real Letterboxd library - every recent favourite, exactly the films
someone's taste is clearest about. This pulls the most-rated films of each year
instead, so coverage tracks what people actually watch.

    python build_tmdb_bundle.py --per-year 250

Resumable: raw responses are cached, so re-running only fetches what's new.
Overviews are left out on purpose - they roughly triple the file for a feature
worth little (see README), and a TMDB key still fills them in live.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from enrich_tmdb import condense, read_api_key
from festrec_eval.titles import variants

DISCOVER = "https://api.themoviedb.org/3/discover/movie"
DETAILS = "https://api.themoviedb.org/3/movie/{id}"
PAGE_SIZE = 20
MAX_KEYWORDS = 10
MIN_KEYWORD_USES = 3
CAST_DEPTH = 5


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from-year", type=int, default=1930)
    p.add_argument("--to-year", type=int, default=2026)
    p.add_argument("--per-year", type=int, default=250,
                   help="most-rated films to take from each year")
    p.add_argument("--min-votes", type=int, default=25)
    p.add_argument("--workers", type=int, default=10)
    p.add_argument("--raw", default="data/tmdb_bundle_raw.json")
    p.add_argument("--out", default="app/data/library.json")
    p.add_argument("--overviews", action="store_true",
                   help="include synopses (much larger file)")
    return p.parse_args()


def get(url: str, attempts: int = 5) -> dict | None:
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=25) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code in (429, 500, 502, 503, 504):
                time.sleep(float(error.headers.get("Retry-After", 2**attempt)))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            time.sleep(2**attempt)
    return None


def discover_ids(api_key: str, args: argparse.Namespace) -> list[int]:
    """The most-voted films of each year, which is a decent proxy for 'seen'."""
    ids: list[int] = []
    pages_needed = -(-args.per_year // PAGE_SIZE)

    for year in range(args.from_year, args.to_year + 1):
        found = 0
        for page in range(1, pages_needed + 1):
            query = (
                f"{DISCOVER}?api_key={api_key}&sort_by=vote_count.desc"
                f"&primary_release_year={year}&vote_count.gte={args.min_votes}"
                f"&include_adult=false&page={page}"
            )
            payload = get(query)
            results = (payload or {}).get("results") or []
            if not results:
                break
            ids.extend(r["id"] for r in results)
            found += len(results)
            if found >= args.per_year:
                break
        print(f"  {year}: {found}", end="\r", flush=True)

    return list(dict.fromkeys(ids))


def main() -> None:
    args = parse_args()
    api_key = read_api_key()
    if not api_key:
        sys.exit("No TMDB key found (tmdb_key.txt or TMDB_API_KEY).")

    raw_path = Path(args.raw)
    raw: dict[str, dict] = {}
    if raw_path.exists():
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
    print(f"{len(raw)} films already cached")

    print(f"Finding the most-rated films of {args.from_year}-{args.to_year}…")
    ids = discover_ids(api_key, args)
    todo = [i for i in ids if str(i) not in raw]
    print(f"\n{len(ids)} films found, fetching credits for {len(todo)}")

    def work(film_id: int):
        payload = get(
            f"{DETAILS.format(id=film_id)}?api_key={api_key}"
            f"&append_to_response=credits,keywords"
        )
        return film_id, payload

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for film_id, payload in pool.map(work, todo):
            done += 1
            if payload:
                record = condense(payload)
                record["year"] = (payload.get("release_date") or "")[:4]
                raw[str(film_id)] = record
            if done % 500 == 0:
                raw_path.write_text(json.dumps(raw), encoding="utf-8")
                print(f"  {done}/{len(todo)}", flush=True)

    raw_path.write_text(json.dumps(raw), encoding="utf-8")

    # Rare keywords are dead weight: they can never match anything.
    usage = Counter(k for f in raw.values() for k in f.get("keyword", []))

    # Each film is stored once and pointed at by every spelling of its title.
    # Inlining the record per spelling tripled the download for no benefit.
    films: list[dict] = []
    keys: dict[str, int] = {}
    for film in raw.values():
        record = {
            "director": film.get("director") or [],
            "writer": (film.get("writer") or [])[:3],
            "cast": (film.get("cast") or [])[:CAST_DEPTH],
            "genre": film.get("genre") or [],
            "year": str(film.get("year") or ""),
            "keyword": [
                k for k in (film.get("keyword") or [])
                if usage[k] >= MIN_KEYWORD_USES
            ][:MAX_KEYWORDS],
        }
        if args.overviews:
            record["overview"] = (film.get("overview") or "")[:300]

        index = len(films)
        films.append(record)

        year = str(film.get("year") or "")
        for spelling in variants(film.get("title") or ""):
            keys[f"{spelling}|{year}"] = index
            keys.setdefault(f"{spelling}|", index)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"films": films, "keys": keys},
                   separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {out} - {len(films)} films, {len(keys)} lookup keys, "
          f"{out.stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
