"""Build a festival file from an Eventive schedule a person saved by hand.

Eventive-run festivals (Fantastic Fest among them) load their lineup from two
responses: one listing the films, one listing the events that screen them.
Save both from the browser's network panel into a folder, then:

    python convert_eventive.py raw/fantastic-fest --name "Fantastic Fest 2026"

This only reads files someone saved. Eventive's terms forbid bots and
data-gathering tools, so nothing here fetches from Eventive.

Everything comes from the festival's own listing: titles, synopses, posters,
directors, runtimes and showtimes. `--previous` points at an earlier file for
the same festival, whose tidier title casing, genre and section wording are
kept where a film matches. Run enrich_festival.py afterwards to add Wikidata
credits for films that are on Wikidata.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from festrec_eval.genres import map_genres
from parse_festival import EVENT_SECTIONS, PLACEHOLDER

# Listings Eventive keeps that aren't part of the published week.
SKIP_EVENT = re.compile(r"^\s*tba\s*$|\btest event\b", re.IGNORECASE)
# Titled like a film on Eventive, but nothing to score until the lights go down.
SECRET = re.compile(r"secret screening", re.IGNORECASE)
# Titles written in capitals on Eventive read better in title case, but these
# stay lower case inside a title.
SMALL_WORDS = {"a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"}
PEOPLE_SPLIT = re.compile(r"\s*(?:,|&|\band\b)\s*")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("folder", help="folder holding films*.json and events*.json")
    p.add_argument("--name", required=True, help='festival name, e.g. "Fantastic Fest 2026"')
    p.add_argument("--out", default="app/data/festival.json")
    p.add_argument("--previous", help="an earlier file for this festival, for title casing, genre and section")
    p.add_argument("--captured", help="date the files were saved, YYYY-MM-DD (default: the newest file's date)")
    return p.parse_args()


def load_records(folder: Path, prefix: str, key: str) -> list[dict]:
    """Every record from films*.json or events*.json, in case a list was saved in parts."""
    records: dict[str, dict] = {}
    files = sorted(folder.glob(f"{prefix}*.json"))
    if not files:
        raise SystemExit(f"no {prefix}*.json in {folder}")
    for path in files:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        for record in payload[key] if isinstance(payload, dict) else payload:
            records[record["id"]] = record
    return list(records.values())


def match_key(title: str) -> str:
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", text)


def title_case(title: str) -> str:
    """'HONORING WALTER HILL: EXTREME PREJUDICE' -> 'Honoring Walter Hill: Extreme Prejudice'.

    Only all-capital words change, so a deliberate 'BURNT ENDominations' or
    'Doug Benson' is left as written.
    """
    words = title.strip().split(" ")
    out = []
    for index, word in enumerate(words):
        letters = re.sub(r"[^A-Za-z]", "", word)
        # Two capitals are usually an abbreviation: FX, TV, UK.
        if len(letters) > 2 and letters.isupper() or (
            len(letters) == 2 and letters.isupper() and letters.lower() in SMALL_WORDS
        ):
            lower = word.lower()
            after_colon = index > 0 and out[-1].endswith(":")
            if index > 0 and not after_colon and lower in SMALL_WORDS:
                word = lower
            else:
                word = re.sub(r"[a-z]", lambda m: m.group().upper(), lower, count=1)
        out.append(word)
    return " ".join(out)


def plain_text(markup: str) -> str:
    text = re.sub(r"<\s*(br|/p)\s*/?>", " ", markup or "", flags=re.IGNORECASE)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"\s+", " ", text).strip()


# Festival files are checked against a 2,000-character synopsis limit.
LONGEST_SYNOPSIS = 1900


def synopsis(record: dict) -> str:
    text = plain_text(record.get("description")) or plain_text(record.get("short_description"))
    if len(text) <= LONGEST_SYNOPSIS:
        return text
    cut = text[:LONGEST_SYNOPSIS]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[: end + 1] if end > LONGEST_SYNOPSIS // 2 else cut.rsplit(" ", 1)[0] + "…"


def people(value) -> list[str]:
    if isinstance(value, list):
        text = ", ".join(str(v) for v in value)
    else:
        text = str(value or "")
    # A programme of shorts credits each one: "Frankenstein - J. Searle Dawley /
    # Häxan - Benjamin Christensen". Keep the names after each dash.
    if " / " in text or re.search(r"\S/\S", text) is None and "/" in text:
        text = ", ".join(part.rsplit(" - ", 1)[-1] for part in re.split(r"\s*/\s*", text))
    names = PEOPLE_SPLIT.split(text)
    return list(dict.fromkeys(
        n.strip() for n in names
        if n.strip() and not PLACEHOLDER.match(n) and not re.match(r"(?i)^unknown\b", n.strip())
        and len(n.strip()) <= 80
    ))


def theatres(names: list[str]) -> str:
    """['Theater 3', 'Theater 1', 'Theater 7'] -> 'Theaters 1, 3 and 7'."""
    names = list(dict.fromkeys(n for n in names if n))
    numbered = [re.fullmatch(r"(Theat(?:er|re))\s+(\d+)", n) for n in names]
    if len(names) > 1 and all(numbered):
        word = numbered[0].group(1)
        numbers = sorted(int(m.group(2)) for m in numbered)
        listed = ", ".join(map(str, numbers[:-1])) + f" and {numbers[-1]}"
        return f"{word}s {listed}"
    return ", ".join(names)


def minutes(value) -> int | None:
    match = re.search(r"\d+", str(value or ""))
    return int(match.group()) if match else None


def build_film(record: dict, previous: dict | None) -> dict:
    details = record.get("details") or {}
    credits = record.get("credits") or {}
    tags = [t["name"].strip() for t in record.get("tags") or [] if t.get("visible", True) and t.get("name")]
    title = previous["title"] if previous else title_case(record["name"])
    genre = (previous or {}).get("genre", "")
    section = (previous or {}).get("section") or details.get("premiere", "")
    director = people(credits.get("director"))
    cast = people(credits.get("cast"))
    writer = people(credits.get("screenwriter"))
    editor = people(credits.get("editor"))
    cinematographer = people(credits.get("cinematographer"))

    genre_parts = [g for g in re.split(r"[/,·]", genre) if g.strip()]
    # Judged by section and genre, not title: "The Birthday Party" is a film.
    is_event = (previous or {}).get("kind") == "event" or bool(
        EVENT_SECTIONS.search(f"{section} {genre}") or SECRET.search(record["name"])
    )
    film = {
        "title": title,
        "year": minutes(details.get("year")),
        "country": details.get("country", ""),
        "runtime": minutes(details.get("runtime")),
        "section": section,
        "genre": genre,
        "tags": tags,
        "director": director,
        "cast": cast,
        "synopsis": synopsis(record),
        "entities": {
            "director": director,
            "writer": writer,
            "cast": cast,
            "editor": editor,
            "cinematographer": cinematographer,
            # A premiere isn't on Wikidata yet, so the festival's own tags and
            # genre stand in for themes, as in parse_festival.py.
            "keyword": sorted({*(t.lower() for t in tags), *(g.strip().lower() for g in genre_parts)}),
            "genre": sorted(map_genres(genre_parts + tags)),
        },
        "kind": "event" if is_event else "film",
    }
    entities = film["entities"]
    film["scoreable"] = not is_event and bool(entities["director"] or entities["cast"] or entities["keyword"])
    if record.get("poster_image"):
        film["poster"] = record["poster_image"]
    return {k: v for k, v in film.items() if v not in (None, "")}


def build_side_event(record: dict, runtime: int) -> dict:
    """A party, a trivia night, a workshop: listed, never scored."""
    film = {
        "title": title_case(record["name"]),
        "section": (record.get("venue") or {}).get("name", "").strip(),
        "synopsis": synopsis(record),
        "runtime": runtime,
        "tags": [],
        "director": [],
        "cast": [],
        "entities": {"director": [], "writer": [], "cast": [], "keyword": [], "genre": []},
        "kind": "event",
        "scoreable": False,
    }
    if isinstance(record.get("images"), dict) and record["images"].get("poster"):
        film["poster"] = record["images"]["poster"]
    return {k: v for k, v in film.items() if v not in (None, "")}


def main() -> None:
    args = parse_args()
    folder = Path(args.folder)
    film_records = load_records(folder, "films", "films")
    event_records = load_records(folder, "events", "events")

    previous_films: dict[str, dict] = {}
    if args.previous:
        earlier = json.loads(Path(args.previous).read_text(encoding="utf-8"))
        previous_films = {match_key(f["title"]): f for f in earlier.get("films", [])}

    films: dict[str, dict] = {}
    for record in film_records:
        if record.get("visibility", "visible") != "visible":
            continue
        films[record["id"]] = build_film(record, previous_films.get(match_key(record["name"])))

    screenings, seen, side_events = [], {}, {}
    for event in event_records:
        if event.get("visibility", "visible") != "visible" or SKIP_EVENT.search(event.get("name", "")):
            continue
        zone = ZoneInfo(event.get("timezone") or "UTC")
        start = datetime.fromisoformat(event["start_time"].replace("Z", "+00:00")).astimezone(zone)
        end = datetime.fromisoformat(event["end_time"].replace("Z", "+00:00")).astimezone(zone)
        length = round((end - start).total_seconds() / 60) or None
        refs = [r["id"] if isinstance(r, dict) else r for r in event.get("films") or []]
        if refs:
            titles = [films[r]["title"] for r in refs if r in films]
        else:
            side = side_events.setdefault(event["id"], build_side_event(event, length))
            titles = [side["title"]]
        for title in titles:
            film = next((f for f in [*films.values(), *side_events.values()] if f["title"] == title), {})
            venue = (event.get("venue") or {}).get("name", "").strip()
            # The same film often starts in several theatres at once. That is
            # one showing to plan around, in all of those theatres.
            key = (title, start.isoformat())
            if key in seen:
                if venue:
                    seen[key].append(venue)
                continue
            seen[key] = [venue] if venue else []
            screening = {
                "film": title,
                "date": start.date().isoformat(),
                "time": start.strftime("%I:%M %p").lstrip("0"),
                "runtime": film.get("runtime") or length,
                "_key": key,
            }
            screenings.append(screening)

    for screening in screenings:
        venue = theatres(seen[screening.pop("_key")])
        if venue:
            screening["venue"] = venue

    lineup = sorted([*films.values(), *side_events.values()], key=lambda f: match_key(f["title"]))
    screened = {s["film"] for s in screenings}
    unscreened = [f["title"] for f in lineup if f["title"] not in screened]
    lineup = [f for f in lineup if f["title"] in screened]
    screenings.sort(key=lambda s: (s["date"], datetime.strptime(s["time"], "%I:%M %p").time(), s["film"]))

    newest = max(p.stat().st_mtime for p in folder.glob("*.json"))
    captured = args.captured or datetime.fromtimestamp(newest).date().isoformat()
    data = {
        "festival": args.name,
        "captured": captured,
        "days": sorted({s["date"] for s in screenings}),
        "films": lineup,
        "screenings": screenings,
    }
    Path(args.out).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    real = [f for f in lineup if f["kind"] == "film"]
    print(f"Wrote {args.out}: {len(real)} films, {len(lineup) - len(real)} events, "
          f"{len(screenings)} showings over {len(data['days'])} days (captured {captured})")
    print(f"  {sum(1 for f in lineup if f.get('synopsis'))} with a synopsis, "
          f"{sum(1 for f in lineup if f.get('poster'))} with a poster")
    if unscreened:
        print(f"  left out, no showings: {', '.join(unscreened)}")


if __name__ == "__main__":
    main()
