"""Match a festival's lineup to Wikidata, where the films exist there.

The recommender compares a festival film's credits and themes against the
person's rated films, whose credits come from Wikidata. A festival film
described only in the festival's own wording ("Dream-logic slasher", "Great
Kills") barely overlaps with anything - both sides need the same vocabulary.

Repertory titles and many recent films are on Wikidata. This finds them and
merges their credits and themes in. The festival stays the authority on its own
lineup: its synopsis and poster are kept, and a Wikipedia synopsis is only used
for a film the festival didn't describe, with the article recorded so the app
can credit it (CC BY-SA 4.0).

    python enrich_festival.py app/data/festival.json
"""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path

from festrec_eval.titles import normalise
from festrec_eval.wikidata import (
    FILM_TYPES,
    WIKIDATA_API,
    claim_ids,
    condense,
    extracts,
    get_entities,
    label,
    people_and_things,
    release_year,
    request_json,
)
from parse_festival import PLACEHOLDER

# Below this, a "match" is usually a different film with a similar name.
MIN_SIMILARITY = 0.82


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("festival", nargs="?", default="app/data/festival.json")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--year-slack", type=int, default=1,
                   help="a festival year and a release year often differ by one")
    return p.parse_args()


def search(title: str) -> list[str]:
    payload = request_json(WIKIDATA_API, {
        "action": "wbsearchentities", "search": title, "language": "en",
        "type": "item", "limit": "10", "format": "json",
    })
    return [item["id"] for item in payload.get("search", [])]


def best_match(film: dict, candidates: dict[str, dict], year_slack: int) -> dict | None:
    """Pick a film only when the title really matches and the year is close."""
    wanted = normalise(film["title"])
    year = film.get("year")
    best, best_score = None, 0.0
    for entity in candidates.values():
        if not set(claim_ids(entity, "P31")) & set(FILM_TYPES):
            continue
        titles = {label(entity), entity.get("sitelinks", {}).get("enwiki", {}).get("title", "")}
        released = release_year(entity)
        for candidate in filter(None, titles):
            score = SequenceMatcher(None, wanted, normalise(candidate)).ratio()
            if year and released.isdigit() and abs(int(released) - int(year)) > year_slack:
                score -= 0.25  # a year that is well off means a different film
            if score > best_score:
                best, best_score = entity, score
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
    """True unless the festival and Wikidata name different directors."""
    festival = [
        name for name in (film.get("director") or film.get("entities", {}).get("director") or [])
        if name and not PLACEHOLDER.match(name)
    ]
    found = meta.get("director") or []
    if not festival or not found:
        return True  # Nothing to contradict.
    return any(same_person(a, b) for a in festival for b in found)


def main() -> None:
    args = parse_args()
    path = Path(args.festival)
    data = json.loads(path.read_text(encoding="utf-8"))

    def work(film: dict):
        if film.get("kind") == "event":
            return film, None
        ids = search(film["title"])
        if not ids:
            return film, None
        entity = best_match(film, get_entities(ids, "labels|claims|sitelinks", workers=1),
                            args.year_slack)
        if not entity:
            return film, None
        names = {
            qid: label(e)
            for qid, e in get_entities(people_and_things({entity["id"]: entity}), "labels",
                                       workers=1).items()
        }
        article = entity.get("sitelinks", {}).get("enwiki", {}).get("title", "")
        text = extracts([article], workers=1).get(article, "") if article else ""
        meta = condense(entity, names, text)
        # Titles like "The Birthday Party" and "The Cycle" belong to several
        # films. Where the festival names a director, it is the authority on
        # its own lineup: if Wikidata's director is someone else, this is a
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
            entities = film.setdefault("entities", {})
            # Wikidata is richer where it has anything; the festival's own
            # listing stays as the fallback.
            for facet in ("director", "writer", "cast", "editor", "cinematographer"):
                if meta.get(facet):
                    entities[facet] = meta[facet]
            for facet in ("keyword", "genre"):
                if meta.get(facet):
                    entities[facet] = sorted(set(entities.get(facet, [])) | set(meta[facet]))
            if meta.get("overview") and not film.get("synopsis"):
                film["synopsis"] = meta["overview"]
                film["wikipedia"] = meta["wikipedia"]
            if not film.get("runtime") and meta.get("runtime"):
                film["runtime"] = meta["runtime"]
            film["wikidata"] = meta["qid"]
            film["scoreable"] = True

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    films = [f for f in data["films"] if f.get("kind") != "event"]
    with_people = sum(
        1 for f in films
        if f.get("entities", {}).get("director") or f.get("entities", {}).get("cast")
    )
    print(f"Matched {matched} of {len(films)} films to Wikidata")
    print(f"{with_people} now have named credits, "
          f"{sum(1 for f in films if len(f.get('entities', {}).get('keyword', [])) > 3)} have "
          f"more than three themes")
    print("Credits from Wikidata (CC0). Any synopsis marked with a Wikipedia "
          "article is CC BY-SA 4.0.")


if __name__ == "__main__":
    main()
