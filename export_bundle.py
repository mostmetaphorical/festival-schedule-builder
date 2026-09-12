"""Ship a library of film credits with the app.

Lets the app work with no API key and no network: if a film someone rated is in
here, its credits are already on hand. Anything missing falls back to a TMDB
lookup, which needs a key.

    python export_bundle.py

Keywords are capped per film and rare ones dropped, because the bundle has to
be small enough to download on a phone.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import pandas as pd

from festrec_eval.data import load_movielens
from festrec_eval.titles import key, variants

MAX_KEYWORDS = 12
MIN_KEYWORD_USES = 3
SYNOPSIS_CHARS = 400


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--tmdb", default="data/tmdb_cache.json")
    p.add_argument("--out", default="app/data/library.json")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    dataset = load_movielens(args.data)
    tmdb = {
        int(k): v
        for k, v in json.loads(
            Path(args.tmdb).read_text(encoding="utf-8")
        ).items()
    }

    # A keyword only helps if it recurs; singletons are dead weight.
    usage = Counter(
        keyword
        for meta in tmdb.values()
        for keyword in (meta or {}).get("keyword", [])
    )

    bundle = {}
    for movie_id, meta in tmdb.items():
        if not meta or movie_id not in dataset.films.index:
            continue
        row = dataset.films.loc[movie_id]
        year = "" if pd.isna(row.year) else str(int(row.year))

        record = {
            "director": meta.get("director") or [],
            "writer": meta.get("writer") or [],
            "cast": meta.get("cast") or [],
            "keyword": [
                k for k in (meta.get("keyword") or [])
                if usage[k] >= MIN_KEYWORD_USES
            ][:MAX_KEYWORDS],
            "overview": (meta.get("overview") or "")[:SYNOPSIS_CHARS],
        }

        # Index every spelling of the title, and TMDB's own, so a lookup
        # doesn't fail on "Big Lebowski, The" vs "The Big Lebowski".
        spellings = set(variants(row.title))
        if meta.get("title"):
            spellings.update(variants(meta["title"]))
        for spelling in spellings:
            bundle[f"{spelling}|{year}"] = record
            # A year-less key catches sources that disagree about the year,
            # but never overwrites a dated match.
            bundle.setdefault(f"{spelling}|", record)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bundle, separators=(",", ":"), ensure_ascii=False),
                   encoding="utf-8")

    size = out.stat().st_size / 1024 / 1024
    print(f"Wrote {out} - {len(bundle)} films, {size:.1f} MB")
    if size > 8:
        print("  Large for a phone; consider trimming cast depth or keywords.")


if __name__ == "__main__":
    main()
