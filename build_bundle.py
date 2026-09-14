"""Build the film library the app ships with, from Wikidata.

When someone imports their ratings, each film they rated needs its credits so
the recommender can learn their taste. Looking every film up live would be
slow and send their whole history's titles over the network, so the most
widely seen films of each year travel with the app instead, plus every film
the model was trained on.

    python build_bundle.py --per-year 250

"Widely seen" is measured by how many Wikipedias have an article on the film,
which needs no ratings data. Credits are CC0 from Wikidata.

Synopses matter: the recommender compares a festival film's synopsis with those
of the films someone rated, and without them that signal is zero in the app.
Full text would triple the download, so by default each film carries only its
`--terms` most distinctive words (weighted as the model weighs them, from
app/data/idf.json). On MovieLens, 30 terms keep most of the signal (see README).

Resumable: fetched films are cached in data/wikidata_films.json, shared with
enrich_wikidata.py.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

from festrec_eval.titles import variants
from festrec_eval.wikidata import FilmCache, popular_films

MAX_KEYWORDS = 10
MIN_KEYWORD_USES = 3
CAST_DEPTH = 5
MAX_WRITERS = 3


def synopsis_terms(idf_path: str, limit: int):
    """A function giving a synopsis's `limit` highest-weighted words, space-separated.

    Weighted as festrec_eval/text.py weighs them (sublinear term frequency
    times idf), and restricted to the model's vocabulary, since any other word
    is ignored when the app scores. Each word is kept once.
    """
    import math

    from festrec_eval.text import MIN_LEN, STOPWORDS, TOKEN

    idf = json.loads(Path(idf_path).read_text(encoding="utf-8"))["idf"]

    def top(text: str) -> str:
        words = [t for t in TOKEN.findall(text.lower()) if len(t) >= MIN_LEN and t not in STOPWORDS]
        counts = Counter(w for w in words if w in idf)
        weighted = sorted(counts, key=lambda w: -(1 + math.log(counts[w])) * idf[w])
        return " ".join(weighted[:limit])

    return top


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from-year", type=int, default=1930)
    p.add_argument("--to-year", type=int, default=2026)
    p.add_argument("--per-year", type=int, default=250,
                   help="most widely written-about films to take from each year")
    # Recent films are what a festival-goer has been watching, and they have
    # had less time to gather Wikipedia articles, so the top 250 by articles
    # misses more of them. On two real Letterboxd exports, two-thirds of the
    # unmatched films were from the 2020s.
    p.add_argument("--recent-from", type=int, default=2018)
    p.add_argument("--recent-per-year", type=int, default=800)
    p.add_argument("--cache", default="data/wikidata_films.json")
    p.add_argument("--metadata", default="data/film_metadata.json",
                   help="the training films, which are always included")
    p.add_argument("--out", default="app/data/library.json")
    p.add_argument("--overviews", action="store_true",
                   help="include full Wikipedia synopses (much larger file)")
    p.add_argument("--terms", type=int, default=30,
                   help="synopsis words kept per film for the recommender (0 = none)")
    p.add_argument("--content-factors", action="store_true",
                   help="add each film's content-predicted CF factors for the blend (run export_blend.py first)")
    p.add_argument("--idf", default="app/data/idf.json",
                   help="word weights exported with the model; run export_model.py first")
    p.add_argument("--discover-only", action="store_true",
                   help="just list each year's films, without fetching them")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    cache = FilmCache(args.cache)

    # Each year's list is saved as it arrives, so an interrupted build resumes.
    lists_path = Path(args.cache).with_name("popular_films.json")
    lists: dict[str, dict] = (
        json.loads(lists_path.read_text(encoding="utf-8")) if lists_path.exists() else {}
    )
    print(f"Finding the most widely written-about films of {args.from_year}-{args.to_year}…")
    for year in range(args.from_year, args.to_year + 1):
        wanted = args.recent_per_year if year >= args.recent_from else args.per_year
        saved = lists.get(str(year))
        if not saved or saved["limit"] < wanted:
            lists[str(year)] = {"limit": wanted, "films": popular_films(year, wanted)}
            lists_path.write_text(json.dumps(lists), encoding="utf-8")
        lists[str(year)]["films"] = lists[str(year)]["films"][:wanted]
        print(f"  {year}: {len(lists[str(year)]['films'])}", flush=True)
    qids: list[str] = [q for year in sorted(lists) for q in lists[year]["films"]
                       if args.from_year <= int(year) <= args.to_year]
    if args.discover_only:
        print(f"{len(qids)} films listed; stopping before fetching them.")
        return

    training = Path(args.metadata)
    if training.exists():
        qids.extend(
            r["qid"] for r in json.loads(training.read_text(encoding="utf-8")).values()
            if r and r.get("qid")
        )

    cache.fill(qids, overviews=args.overviews or args.terms > 0)
    if args.overviews or args.terms > 0:
        cache.fill_overviews(qids)
    cache.remap()  # apply the current genre rules to films fetched earlier
    records = [cache.records[q] for q in dict.fromkeys(qids) if cache.records.get(q)]

    top_terms = synopsis_terms(args.idf, args.terms) if args.terms > 0 else None

    # A keyword only helps if it recurs; one used once can never match.
    usage = Counter(k for r in records for k in r.get("keyword") or [])

    cf = None
    if args.content_factors:
        from add_content_factors import ContentFactorModel
        print("Computing content factors…")
        cf = ContentFactorModel().factors_for(records)

    films: list[dict] = []
    keys: dict[str, int] = {}
    for film in records:
        record = {
            "director": film.get("director") or [],
            "writer": (film.get("writer") or [])[:MAX_WRITERS],
            "cast": (film.get("cast") or [])[:CAST_DEPTH],
            "genre": film.get("genre") or [],
            "year": str(film.get("year") or ""),
            "keyword": [
                k for k in film.get("keyword") or [] if usage[k] >= MIN_KEYWORD_USES
            ][:MAX_KEYWORDS],
        }
        if args.overviews and film.get("overview"):
            record["overview"] = film["overview"]
            record["wikipedia"] = film.get("wikipedia", "")
        elif top_terms and film.get("overview"):
            terms = top_terms(film["overview"])
            if terms:
                record["terms"] = terms

        index = len(films)
        if cf is not None and cf[index] is not None:
            record["cf"] = cf[index]
        films.append(record)

        # Every spelling points at the one record: the Wikidata label, and the
        # Wikipedia article title without its "(1995 film)" disambiguator.
        year = record["year"]
        spellings = set(variants(film.get("title") or ""))
        if film.get("wikipedia"):
            spellings.update(variants(re.sub(r"\s*\([^)]*film\)$", "", film["wikipedia"])))
        for spelling in spellings:
            keys.setdefault(f"{spelling}|{year}", index)
            keys.setdefault(f"{spelling}|", index)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({
            "source": "Film credits from Wikidata (CC0 1.0), wikidata.org",
            "films": films,
            "keys": keys,
        }, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {out} - {len(films)} films, {len(keys)} lookup keys, "
          f"{out.stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
