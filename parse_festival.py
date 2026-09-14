"""Turn a festival page into structured data the app can score.

Written against the Fantastic Fest 2026 page, which carries its lineup as a
JavaScript array and its screenings as table rows. Festival sites differ wildly,
so this is deliberately one adapter rather than a general scraper: the app reads
`festival.json`, and any new festival needs only something that writes that
shape.

    python parse_festival.py "path/to/fantastic-fest-2026.html"
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from festrec_eval.genres import map_genres

# `{t:"Title",y:2026,...}` - JavaScript object keys aren't quoted, so they need
# quoting before this is JSON. Only matches a short key right after { or ,
# which is not a shape that occurs inside the prose fields.
UNQUOTED_KEY = re.compile(r'([{,])\s*([a-zA-Z]{1,4})\s*:')
FILM_ARRAY = re.compile(r"const F\s*=\s*(\[.*?\n\]);", re.DOTALL)
DAY_BLOCK = re.compile(
    r'<details class="day" data-date="(\d{4}-\d{2}-\d{2})".*?>(.*?)</details>',
    re.DOTALL,
)
ROW = re.compile(
    r'<tr class="([^"]*)" data-film="([^"]*)">'
    r'<td class="time">([^<]+)</td>'
    r'(.*?)</tr>',
    re.DOTALL,
)
RUNTIME = re.compile(r"(\d+)\s*min")
SHIFT = re.compile(r'<p class="shift">On shift ([^<·]+)(?:·([^<]*))?</p>')
TAG = re.compile(r"<[^>]+>")

# Festivals are not only films. Parties, feuds, drag shows, secret screenings
# and live interruptions are part of the week and belong in the plan - they
# just can't be scored from someone's film ratings, so they are marked rather
# than dropped.
EVENT_SECTIONS = re.compile(
    r"live event|secret screening|party|panel|awards|ceremony|karaoke",
    re.IGNORECASE,
)

# "Various", "Undisclosed", "—" are not people. Left in, they would invent a
# shared director between every shorts programme and every secret screening.
PLACEHOLDER = re.compile(
    r"^\s*(various|undisclosed|unknown|tba|tbc|n/?a|—|-|\?+)\s*$", re.IGNORECASE
)

FIELDS = {
    "t": "title", "y": "year", "c": "country", "m": "runtime",
    "sec": "section", "g": "genre", "tags": "tags", "d": "director",
    "dp": "cinematographer", "cast": "cast", "desc": "synopsis",
}


def parse_films(html: str) -> list[dict]:
    match = FILM_ARRAY.search(html)
    if not match:
        raise SystemExit("could not find the film array in this page")

    raw = UNQUOTED_KEY.sub(r'\1"\2":', match.group(1))
    records = json.loads(raw)

    films = []
    for record in records:
        film = {
            name: record.get(key, "")
            for key, name in FIELDS.items()
        }
        film["tags"] = [t.strip() for t in str(film["tags"]).split(",") if t.strip()]
        film["cast"] = [c.strip() for c in str(film["cast"]).split(",") if c.strip()]
        film["director"] = [
            d.strip() for d in re.split(r"\s*[&,]\s*", str(film["director"]))
            if d.strip()
        ]
        film["synopsis"] = TAG.sub("", film["synopsis"])

        # The recommender scores films by shared credits and themes. A 2026
        # premiere isn't on Wikidata yet, so these come from the festival's own
        # listing: its tags and genre stand in for keywords.
        real_directors = [
            d for d in film["director"] if not PLACEHOLDER.match(d)
        ]
        film["entities"] = {
            "director": real_directors,
            "writer": [],
            "cast": [c for c in film["cast"] if not PLACEHOLDER.match(c)],
            "keyword": sorted({
                *(t.lower() for t in film["tags"]),
                *(
                    g.strip().lower()
                    for g in re.split(r"[/,·]", str(film["genre"]))
                    if g.strip()
                ),
            }),
            # Genre carries the weight when nobody involved is familiar, which
            # is most of a premiere-heavy festival. The model's genre vocabulary
            # is fixed, so map the festival's wording onto it.
            "genre": sorted(
                map_genres(re.split(r"[/,·]", str(film["genre"])) + film["tags"])
            ),
        }
        context = f'{film["section"]} {film["genre"]}'
        is_event = bool(EVENT_SECTIONS.search(context))
        film["kind"] = "event" if is_event else "film"

        # Scoreable means there is something for the recommender to work with.
        # A live show or a secret screening has nothing to go on, and a
        # prediction there would be the person's average dressed up as a
        # recommendation - so these are surfaced for the user to decide on
        # instead of being silently ranked.
        film["scoreable"] = not is_event and bool(
            film["entities"]["director"]
            or film["entities"]["cast"]
            or film["entities"]["keyword"]
        )
        films.append(film)
    return films


def parse_screenings(html: str) -> tuple[list[dict], list[dict]]:
    """Showtimes per day, plus any commitments the page already had on it."""
    screenings, commitments = [], []

    for date, body in DAY_BLOCK.findall(html):
        for shift in SHIFT.finditer(body):
            window = shift.group(1).strip()
            commitments.append({
                "date": date,
                "window": window,
                "label": (shift.group(2) or "volunteer shift").strip(),
            })

        for _, film, time, rest in ROW.findall(body):
            runtime = RUNTIME.search(rest)
            screenings.append({
                "film": film.strip(),
                "date": date,
                "time": time.strip(),
                "runtime": int(runtime.group(1)) if runtime else None,
            })

    return screenings, commitments


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source")
    parser.add_argument("--name", default="Fantastic Fest 2026")
    parser.add_argument("--out", default="app/data/festival.json")
    args = parser.parse_args()

    html = Path(args.source).read_text(encoding="utf-8")
    films = parse_films(html)
    screenings, commitments = parse_screenings(html)

    # Screenings name films in upper case; the lineup uses real capitalisation.
    by_upper = {f["title"].upper(): f["title"] for f in films}
    unmatched = sorted({
        s["film"] for s in screenings if s["film"].upper() not in by_upper
    })
    for screening in screenings:
        screening["film"] = by_upper.get(
            screening["film"].upper(), screening["film"]
        )

    # A runtime is on the screening row; the lineup has it too. Prefer the
    # lineup's, fall back to the row's, so shorts blocks keep something.
    runtimes = {f["title"]: f.get("runtime") for f in films}
    for screening in screenings:
        screening["runtime"] = (
            runtimes.get(screening["film"]) or screening["runtime"]
        )

    days = sorted({s["date"] for s in screenings})
    payload = {
        "festival": args.name,
        "days": days,
        "films": films,
        "screenings": screenings,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False),
                   encoding="utf-8")

    # Commitments found on the source page are somebody's volunteer shifts,
    # work hours or appointments: personal data saying where a person will be
    # at a given hour. They must never reach published festival data. They go
    # to a separate gitignored file the app can load locally instead.
    if commitments:
        private = out.with_name("my-commitments.json")
        private.write_text(
            json.dumps({"commitments": commitments}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"  {len(commitments)} personal commitments kept out of the "
              f"festival file, in {private.name} (gitignored)")

    events = [f for f in films if f["kind"] == "event"]
    unscoreable = [f for f in films if not f["scoreable"]]
    print(f"Wrote {out}")
    print(f"  {len(films)} items ({len(films) - len(events)} films, "
          f"{len(events)} events), {len(screenings)} screenings, "
          f"{len(days)} days ({days[0]} to {days[-1]})")
    print(f"  {len(unscoreable)} not scoreable (no credits or themes): "
          f"{', '.join(f['title'] for f in unscoreable[:6])}")
    print(f"  {len(commitments)} commitments found on the page")
    missing = [s["film"] for s in screenings if s["runtime"] is None]
    if missing:
        print(f"  {len(missing)} screenings without a runtime: "
              f"{', '.join(sorted(set(missing))[:5])}")
    if unmatched:
        print(f"  {len(unmatched)} screening titles not in the lineup: "
              f"{', '.join(unmatched[:5])}")


if __name__ == "__main__":
    main()
