"""Match a festival's lineup to TMDB, where the films exist there.

The recommender compares a festival film's credits and themes against the
person's rated films. Those come from TMDB, so a festival film described only
in the festival's own wording ("Dream-logic slasher", "Great Kills") barely
overlaps with anything - both sides need to speak the same vocabulary.

Many festival titles do have TMDB entries before release, even premieres.
This finds them and merges the real credits in, keeping the festival's own
data wherever TMDB has nothing.

    python enrich_festival.py app/data/festival.json
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlencode

from enrich_tmdb import condense, read_api_key
from build_tmdb_bundle import get
from festrec_eval.titles import normalise
from parse_festival import PLACEHOLDER

SEARCH = "https://api.themoviedb.org/3/search/movie"
DETAILS = "https://api.themoviedb.org/3/movie/{id}"
# Below this, a "match" is usually a different film with a similar name.
MIN_SIMILARITY = 0.82


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("festival", nargs="?", default="app/data/festival.json")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--year-slack", type=int, default=1,
                   help="a festival year and a release year often differ by one")
    return p.parse_args()


def best_match(film: dict, results: list[dict], year_slack: int) -> dict | None:
    """Pick a result only when the title really matches."""
    wanted = normalise(film["title"])
    year = film.get("year")
    best, best_score = None, 0.0

    for result in results:
        for candidate in (result.get("title"), result.get("original_title")):
            if not candidate:
                continue
            score = SequenceMatcher(None, wanted, normalise(candidate)).ratio()
            released = (result.get("release_date") or "")[:4]
            if year and released.isdigit():
                # A year that is wildly off means a different film.
                if abs(int(released) - int(year)) > year_slack:
                    score -= 0.25
            if score > best_score:
                best, best_score = result, score

    return best if best_score >= MIN_SIMILARITY else None


def same_person(a: str, b: str) -> bool:
    """Tolerant name comparison: middle names, nicknames, spellings differ.

    "Nicolas Jon Curcio" and "Nicolas Curcio" are one person; "Léa Mysius" and
    "Miguel Angel Jimenez" are not.
    """
    first, second = normalise(a), normalise(b)
    if not first or not second:
        return False
    if first == second or first in second or second in first:
        return True
    if SequenceMatcher(None, first, second).ratio() >= 0.75:
        return True
    # Surnames carry most of the identity; a shared one plus a shared initial
    # is enough to call it the same person.
    a_parts, b_parts = first.split(), second.split()
    return bool(
        a_parts and b_parts
        and a_parts[-1] == b_parts[-1]
        and a_parts[0][:1] == b_parts[0][:1]
    )


def directors_agree(film: dict, meta: dict) -> bool:
    """True unless the festival and TMDB name different directors."""
    festival = [
        name for name in film.get("director") or []
        if name and not PLACEHOLDER.match(name)
    ]
    tmdb = meta.get("director") or []
    if not festival or not tmdb:
        return True  # Nothing to contradict.
    return any(same_person(a, b) for a in festival for b in tmdb)


def main() -> None:
    args = parse_args()
    api_key = read_api_key()
    if not api_key:
        sys.exit("No TMDB key found (tmdb_key.txt or TMDB_API_KEY).")

    path = Path(args.festival)
    data = json.loads(path.read_text(encoding="utf-8"))

    def work(film: dict):
        if film.get("kind") == "event":
            return film, None
        query = urlencode({
            "api_key": api_key, "query": film["title"], "include_adult": "false"
        })
        found = get(f"{SEARCH}?{query}")
        match = best_match(film, (found or {}).get("results") or [], args.year_slack)
        if not match:
            return film, None
        details = get(
            f"{DETAILS.format(id=match['id'])}?api_key={api_key}"
            f"&append_to_response=credits,keywords"
        )
        if not details:
            return film, None

        meta = condense(details)
        # Titles like "The Birthday Party" and "The Cycle" belong to several
        # films. Where the festival names a director, it is the authority on
        # its own lineup: if TMDB's director is someone else, this is a
        # different film, and its cast would be actively misleading.
        if not directors_agree(film, meta):
            return film, None
        return film, meta

    matched = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for film, meta in pool.map(work, data["films"]):
            if not meta:
                continue
            matched += 1
            entities = film["entities"]
            # TMDB is richer where it has anything; the festival's own listing
            # stays as the fallback, since it is right about its own lineup.
            for facet in ("director", "writer", "cast"):
                if meta.get(facet):
                    entities[facet] = meta[facet]
            if meta.get("keyword"):
                entities["keyword"] = sorted(
                    set(entities.get("keyword", [])) | set(meta["keyword"])
                )
            if meta.get("genre"):
                entities["genre"] = sorted(
                    {g.lower() for g in meta["genre"]}
                    | set(entities.get("genre", []))
                )
            if meta.get("overview") and len(meta["overview"]) > len(
                film.get("synopsis") or ""
            ):
                film["synopsis"] = meta["overview"]
            film["tmdb"] = True
            film["scoreable"] = True

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    films = [f for f in data["films"] if f.get("kind") != "event"]
    with_people = sum(
        1 for f in films if f["entities"]["director"] or f["entities"]["cast"]
    )
    print(f"Matched {matched} of {len(films)} films to TMDB")
    print(f"{with_people} now have named credits, "
          f"{sum(1 for f in films if len(f['entities']['keyword']) > 3)} have "
          f"more than three themes")


if __name__ == "__main__":
    main()
