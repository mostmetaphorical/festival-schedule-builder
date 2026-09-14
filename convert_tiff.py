"""Build a festival file from TIFF's film list, saved by hand.

tiff.net's schedule page loads one response, `festivalfilmlist`, holding every
title with its screenings. Save it from the browser's network panel, then:

    python convert_tiff.py raw/tiff/films.json --name "TIFF 2026"

Only public screenings are kept: press, industry, market and buyer screenings
aren't open to ticket holders, and cancelled ones are gone. Nothing here
fetches from tiff.net.

Run enrich_festival.py afterwards to add Wikidata credits for known films.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

from convert_eventive import LONGEST_SYNOPSIS, people, plain_text
from festrec_eval.genres import map_genres
from parse_festival import PLACEHOLDER

# Programmes of talks rather than screenings. Festival Street and Special
# Events screen films (often free classics), so those stay films.
EVENT_PROGRAMMES = {"Summit", "In Conversation With..."}
EVENT_TITLE = re.compile(r"\b(conversation|fireside|chat|panel|masterclass|talk|party|concert|live)\b", re.I)
# TIFF tags that describe who made a film or where it's from, not what it's like.
NOT_A_THEME = {"Canadian", "First Feature", "Directed by Women"}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("source", help="the saved festivalfilmlist response")
    p.add_argument("--name", required=True)
    p.add_argument("--out", default="app/data/festivals/tiff-2026.json")
    p.add_argument("--captured", help="YYYY-MM-DD the file was saved (default: its modification date)")
    return p.parse_args()


def public(screening: dict) -> bool:
    return not any(screening.get(flag) for flag in
                   ("marketScreening", "pressAndIndustry", "pressAndMarket", "industry", "cancelled"))


def trim(text: str) -> str:
    if len(text) <= LONGEST_SYNOPSIS:
        return text
    cut = text[:LONGEST_SYNOPSIS]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[: end + 1] if end > LONGEST_SYNOPSIS // 2 else cut.rsplit(" ", 1)[0] + "…"


def main() -> None:
    args = parse_args()
    source = Path(args.source)
    data = json.loads(source.read_text(encoding="utf-8-sig"))

    films, screenings = [], {}
    for item in data["items"]:
        shows = [s for s in item.get("scheduleItems") or [] if public(s)]
        if not shows:
            continue
        programmes = item.get("webProgrammes") or []
        tags = item.get("genre") or []
        # "Mystery + Thriller" is two genres.
        genre_words = [part.strip() for tag in tags for part in tag.split("+") if part.strip()]
        directors = [d for d in people(item.get("directors") or []) if not PLACEHOLDER.match(d)]
        is_event = bool(set(programmes) & EVENT_PROGRAMMES) or (
            not directors and bool(EVENT_TITLE.search(item["title"])))
        keywords = sorted({t.lower() for t in tags if t not in NOT_A_THEME} | {w.lower() for w in genre_words})
        film = {
            "title": item["title"].strip(),
            "country": (item.get("countries") or "").replace(",", ", "),
            "section": ", ".join(programmes),
            "genre": " / ".join(tags),
            "tags": tags,
            "director": directors,
            "cast": [],
            "synopsis": trim(plain_text(item.get("description") or "")),
            "entities": {
                "director": directors,
                "writer": [],
                "cast": [],
                "keyword": keywords,
                "genre": sorted(map_genres(genre_words)),
            },
            "kind": "event" if is_event else "film",
        }
        film["scoreable"] = not is_event and bool(directors or keywords)
        poster = item.get("posterUrl") or item.get("img") or ""
        if poster:
            film["poster"] = ("https:" + poster) if poster.startswith("//") else poster
        films.append({k: v for k, v in film.items() if v not in ("", None)} | {"tags": tags, "cast": []})

        for show in shows:
            start = datetime.strptime(show["startTime"], "%Y-%m-%d %H:%M:%S")
            end = datetime.strptime(show["endTime"], "%Y-%m-%d %H:%M:%S")
            venue = show.get("venue") or {}
            where = venue.get("name", "").strip()
            room = (venue.get("room") or "").strip()
            key = (film["title"], show["startTime"])
            entry = screenings.get(key)
            if entry:
                # Same film, same start, another room: one showing in both.
                if room and room not in entry["_rooms"]:
                    entry["_rooms"].append(room)
                continue
            screenings[key] = {
                "film": film["title"],
                "date": start.date().isoformat(),
                "time": start.strftime("%I:%M %p").lstrip("0"),
                # TIFF publishes an end time, not a runtime; the slot is what matters for planning.
                "runtime": round((end - start).total_seconds() / 60),
                "_venue": where,
                "_rooms": [room] if room else [],
            }

    out_screenings = []
    for entry in sorted(screenings.values(), key=lambda s: (s["date"], datetime.strptime(s["time"], "%I:%M %p"), s["film"])):
        venue, rooms = entry.pop("_venue"), entry.pop("_rooms")
        label = venue if not rooms or rooms == [venue] else f"{venue} ({', '.join(rooms)})"
        if label:
            entry["venue"] = label[:120]
        out_screenings.append(entry)

    captured = args.captured or datetime.fromtimestamp(source.stat().st_mtime).date().isoformat()
    result = {
        "festival": args.name,
        "captured": captured,
        "days": sorted({s["date"] for s in out_screenings}),
        "films": sorted(films, key=lambda f: f["title"].lower()),
        "screenings": out_screenings,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    real = [f for f in films if f["kind"] == "film"]
    print(f"Wrote {out}: {len(real)} films, {len(films) - len(real)} events, {len(out_screenings)} public showings "
          f"over {len(result['days'])} days ({result['days'][0]} to {result['days'][-1]}), captured {captured}")
    print(f"  {sum(1 for f in films if f.get('synopsis'))} with a synopsis, "
          f"{sum(1 for f in films if f.get('poster'))} with a poster, "
          f"{sum(1 for f in real if f['entities']['director'])} films with directors")


if __name__ == "__main__":
    main()
