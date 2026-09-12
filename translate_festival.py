"""Translate a festival's own vocabulary into TMDB's, using Claude.

The recommender compares a festival film against films someone rated, and both
sides have to be described the same way. Festivals don't oblige: they write
"Dream-logic slasher", "Great Kills", "Children in Peril". TMDB writes
"slasher", "gore", "child in peril". Words that don't line up contribute
nothing, so a premiere with no TMDB entry is nearly invisible to the model.

This runs once per festival over the films TMDB doesn't know - roughly a dozen
titles, a few cents - and never per user. Keywords are chosen from the
vocabulary the model was actually fitted on, so the model can't be handed a
category it has never seen.

    python translate_festival.py app/data/festival.json

Needs ANTHROPIC_API_KEY. Results are cached, so re-running is free.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# TMDB's own genre list. The model knows these and nothing else.
TMDB_GENRES = [
    "action", "adventure", "animation", "comedy", "crime", "documentary",
    "drama", "family", "fantasy", "history", "horror", "music", "mystery",
    "romance", "science fiction", "thriller", "war", "western",
]

SYSTEM = """You translate film festival programme copy into TMDB's vocabulary.

Festivals invent their own genre and tag wording. TMDB uses a fixed genre list
and a large but conventional keyword vocabulary. Your job is to describe each
film the way TMDB would.

Rules:
- Choose genres only from the list you are given.
- Choose keywords only from the candidate list you are given. Do not invent
  keywords, and do not pick one merely because a word appears in the text -
  it has to describe the film.
- Prefer precision over coverage: five accurate keywords beat fifteen loose
  ones. An empty list is the right answer when nothing fits.
- You are reading a synopsis written to sell tickets. Describe what the film
  IS, not how exciting the copy sounds."""

SCHEMA = {
    "type": "object",
    "properties": {
        "films": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "genres": {"type": "array", "items": {"type": "string"}},
                    "keywords": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title", "genres", "keywords"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["films"],
    "additionalProperties": False,
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("festival", nargs="?", default="app/data/festival.json")
    p.add_argument("--bundle", default="app/data/library.json")
    p.add_argument("--model", default="claude-opus-5")
    p.add_argument("--vocabulary", type=int, default=1200,
                   help="how many of the commonest TMDB keywords to offer")
    p.add_argument("--batch", type=int, default=12,
                   help="films per request")
    p.add_argument("--all", action="store_true",
                   help="translate every film, not just those TMDB didn't know")
    p.add_argument("--cache", default="data/translations.json")
    return p.parse_args()


def keyword_vocabulary(bundle_path: Path, limit: int) -> list[str]:
    """The commonest keywords in the bundle - what the model was fitted on."""
    from collections import Counter

    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    counts = Counter(
        keyword for film in bundle["films"] for keyword in film.get("keyword", [])
    )
    return [keyword for keyword, _ in counts.most_common(limit)]


def describe(film: dict) -> str:
    parts = [f"Title: {film['title']}"]
    if film.get("section"):
        parts.append(f"Programme section: {film['section']}")
    if film.get("genre"):
        parts.append(f"Festival's genre wording: {film['genre']}")
    if film.get("tags"):
        parts.append(f"Festival's tags: {', '.join(film['tags'])}")
    if film.get("country"):
        parts.append(f"Country: {film['country']}")
    if film.get("synopsis"):
        parts.append(f"Synopsis: {film['synopsis']}")
    return "\n".join(parts)


def main() -> None:
    args = parse_args()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit(
            "ANTHROPIC_API_KEY is not set. This step is optional - the app "
            "works without it, just with weaker matching for films TMDB "
            "doesn't know."
        )

    import anthropic

    path = Path(args.festival)
    data = json.loads(path.read_text(encoding="utf-8"))
    cache_path = Path(args.cache)
    cache = (
        json.loads(cache_path.read_text(encoding="utf-8"))
        if cache_path.exists()
        else {}
    )

    todo = [
        film for film in data["films"]
        if film.get("kind") != "event"
        and (args.all or not film.get("tmdb"))
        and film["title"] not in cache
    ]
    if not todo:
        print("Nothing to translate - every film already has TMDB data or a "
              "cached translation.")
        return

    vocabulary = keyword_vocabulary(Path(args.bundle), args.vocabulary)
    client = anthropic.Anthropic()
    print(f"Translating {len(todo)} films with {args.model}")

    total_in = total_out = 0
    for start in range(0, len(todo), args.batch):
        batch = todo[start:start + args.batch]
        prompt = (
            f"Allowed genres:\n{', '.join(TMDB_GENRES)}\n\n"
            f"Allowed keywords:\n{', '.join(vocabulary)}\n\n"
            f"Describe each of these {len(batch)} films:\n\n"
            + "\n\n---\n\n".join(describe(film) for film in batch)
        )

        response = client.beta.messages.create(
            model=args.model,
            max_tokens=8000,
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
            output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        total_in += response.usage.input_tokens
        total_out += response.usage.output_tokens

        if response.stop_reason == "refusal":
            print(f"  declined: {response.stop_details}")
            continue

        text = next((b.text for b in response.content if b.type == "text"), "{}")
        allowed_keywords = set(vocabulary)
        allowed_genres = set(TMDB_GENRES)

        for item in json.loads(text).get("films", []):
            # Trust but verify: anything outside the vocabulary is dropped,
            # so a hallucinated keyword can never reach the model.
            cache[item["title"]] = {
                "genre": [g for g in item.get("genres", []) if g in allowed_genres],
                "keyword": [
                    k for k in item.get("keywords", []) if k in allowed_keywords
                ],
            }
        print(f"  {min(start + args.batch, len(todo))}/{len(todo)}")

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, indent=2, ensure_ascii=False),
                          encoding="utf-8")

    applied = 0
    for film in data["films"]:
        translation = cache.get(film["title"])
        if not translation:
            continue
        applied += 1
        entities = film["entities"]
        entities["keyword"] = sorted(
            set(entities.get("keyword", [])) | set(translation["keyword"])
        )
        entities["genre"] = sorted(
            set(entities.get("genre", [])) | set(translation["genre"])
        )
        if entities["keyword"] or entities["genre"]:
            film["scoreable"] = film.get("kind") != "event"

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                    encoding="utf-8")

    cost = (total_in * 5 + total_out * 25) / 1_000_000
    print(f"Applied translations to {applied} films")
    print(f"Cost: ${cost:.2f} ({total_in:,} in / {total_out:,} out) - "
          f"once per festival, not per user")


if __name__ == "__main__":
    main()
