"""Give every MovieLens film its credits, genres and synopsis.

Director, writer, cast and keywords are what let the model score a film nobody
has rated yet, so this is what makes the cold condition of the test realistic.
Credits come from Wikidata (CC0) and synopses from Wikipedia (CC BY-SA 4.0),
matched through the IMDb ID that both MovieLens and Wikidata record.

    python enrich_wikidata.py
    python enrich_wikidata.py --limit 300     # a quick trial

Resumable: everything fetched is cached in data/wikidata_films.json.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from festrec_eval.wikidata import FilmCache, qids_for_imdb


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--cache", default="data/wikidata_films.json")
    p.add_argument("--out", default="data/film_metadata.json")
    p.add_argument("--limit", type=int, default=0, help="only the first N films")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    links = pd.read_csv(Path(args.data) / "links.csv", dtype={"imdbId": str})
    links = links.dropna(subset=["imdbId"])
    if args.limit:
        links = links.head(args.limit)
    imdb = {f"tt{row.imdbId.zfill(7)}": int(row.movieId) for row in links.itertuples()}

    print(f"Matching {len(imdb)} MovieLens films to Wikidata by IMDb ID…")
    qids = qids_for_imdb(list(imdb))
    print(f"  {len(qids)} matched ({len(qids) / len(imdb):.0%})")

    cache = FilmCache(args.cache)
    cache.fill(list(qids.values()))
    cache.remap()  # apply the current genre rules to films fetched earlier

    metadata = {}
    for imdb_id, qid in qids.items():
        record = cache.records.get(qid)
        if record:
            metadata[str(imdb[imdb_id])] = record

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")

    def share(field: str) -> str:
        return f"{sum(1 for r in metadata.values() if r.get(field)) / max(len(imdb), 1):.0%}"

    print(f"Wrote {out} - {len(metadata)} films")
    for field in ("director", "writer", "cast", "genre", "keyword", "overview", "runtime"):
        print(f"  with {field}: {share(field)}")
    print("Credits from Wikidata (CC0). Synopses from Wikipedia (CC BY-SA 4.0).")


if __name__ == "__main__":
    main()
