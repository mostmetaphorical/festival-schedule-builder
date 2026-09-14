"""Film credits from Wikidata, synopses from Wikipedia.

Wikidata's data is CC0 - free for any use, including fitting a model and
shipping what it knows inside an app. Wikipedia's text is CC BY-SA 4.0, so any
synopsis taken from it keeps its article title for attribution.

Both services ask to be used politely: a descriptive User-Agent, batched
requests, and backing off when told to. Everything fetched is cached, so a
build only ever asks once per film.

Records come out in the shape the features expect:
    {title, year, runtime, genre, director, writer, cast, keyword, country,
     language, overview, wikipedia, qid, imdb}
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .genres import GENRES, clean, map_genres

USER_AGENT = (
    "festival-schedule-builder/0.2 "
    "(https://github.com/mostmetaphorical/festival-schedule-builder)"
)
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
SPARQL = "https://query.wikidata.org/sparql"
WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"

CAST_DEPTH = 6  # beyond the top billing, shared actors stop meaning much
OVERVIEW_CHARS = 700
BATCH = 50  # wbgetentities' limit per request
EXTRACT_BATCH = 20  # prop=extracts' limit per request

# Things that are films. Instance-of paths through subclasses are too slow to
# query for a whole year, so the common film types are listed directly.
FILM_TYPES = (
    "Q11424",     # film
    "Q24869",     # feature film
    "Q29168811",  # animated feature film
    "Q202866",    # animated film
    "Q93204",     # documentary film
    "Q226730",    # silent film
    "Q506240",    # television film
)

MINUTE, HOUR, SECOND = "Q7727", "Q25235", "Q11574"


def request_json(url: str, params: dict, attempts: int = 6) -> dict:
    """GET with a proper User-Agent, retrying on rate limits and lag."""
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"{url}?{query}",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                payload = json.loads(response.read().decode("utf-8"))
            # The API reports replication lag as an error with a retry hint.
            if isinstance(payload, dict) and payload.get("error", {}).get("code") == "maxlag":
                time.sleep(5 + 2**attempt)
                continue
            return payload
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503, 504):
                time.sleep(float(error.headers.get("Retry-After") or 2**attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            time.sleep(2**attempt + 1)
    raise RuntimeError(f"gave up on {url} after {attempts} attempts")


def sparql(query: str) -> list[dict]:
    payload = request_json(SPARQL, {"query": query, "format": "json"})
    return payload["results"]["bindings"]


def chunks(items: list, size: int):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def qids_for_imdb(imdb_ids: list[str]) -> dict[str, str]:
    """IMDb title IDs -> Wikidata items. Wikidata records the IMDb ID of most films."""
    found: dict[str, str] = {}
    for batch in chunks(sorted(set(imdb_ids)), 300):
        values = " ".join(f'"{i}"' for i in batch)
        for row in sparql(f"SELECT ?imdb ?film WHERE {{ VALUES ?imdb {{ {values} }} ?film wdt:P345 ?imdb . }}"):
            found.setdefault(row["imdb"]["value"], row["film"]["value"].rsplit("/", 1)[1])
    return found


def popular_films(year: int, limit: int) -> list[str]:
    """The films of a year that the most Wikipedias write about.

    Sitelinks are a decent proxy for "widely seen" that needs no ratings data.
    """
    types = " ".join(f"wd:{t}" for t in FILM_TYPES)
    rows = sparql(f"""
        SELECT ?film (MAX(?links) AS ?n) WHERE {{
          VALUES ?type {{ {types} }}
          ?film wdt:P31 ?type ; wdt:P577 ?date ; wikibase:sitelinks ?links .
          FILTER(?date >= "{year}-01-01"^^xsd:dateTime && ?date < "{year + 1}-01-01"^^xsd:dateTime)
          FILTER(?links >= 3)
        }} GROUP BY ?film ORDER BY DESC(?n) LIMIT {limit}
    """)
    return [row["film"]["value"].rsplit("/", 1)[1] for row in rows]


def get_entities(ids: list[str], props: str, workers: int = 4) -> dict[str, dict]:
    """wbgetentities in batches of 50, a few at a time."""
    def fetch(batch: list[str]) -> dict:
        payload = request_json(WIKIDATA_API, {
            "action": "wbgetentities", "ids": "|".join(batch), "props": props,
            "languages": "en|mul", "languagefallback": "1", "sitefilter": "enwiki",
            "format": "json", "maxlag": "5",
        })
        return payload.get("entities", {})

    entities: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(fetch, list(chunks(sorted(set(ids)), BATCH))):
            entities.update({k: v for k, v in result.items() if "missing" not in v})
    return entities


def label(entity: dict) -> str:
    labels = entity.get("labels", {})
    for language in ("en", "mul"):
        if language in labels:
            return labels[language]["value"]
    return next(iter(labels.values()), {}).get("value", "")


def claim_ids(entity: dict, prop: str) -> list[str]:
    """Item values of a property, in the order they're listed, best rank first."""
    statements = entity.get("claims", {}).get(prop, [])
    preferred = [s for s in statements if s.get("rank") == "preferred"]
    ordered = preferred or [s for s in statements if s.get("rank") != "deprecated"]
    ids = []
    for statement in ordered:
        value = statement.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(value, dict) and value.get("id") and value["id"] not in ids:
            ids.append(value["id"])
    return ids


def claim_strings(entity: dict, prop: str) -> list[str]:
    values = []
    for statement in entity.get("claims", {}).get(prop, []):
        value = statement.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(value, str):
            values.append(value)
    return values


def release_year(entity: dict) -> str:
    years = []
    for statement in entity.get("claims", {}).get("P577", []):
        value = statement.get("mainsnak", {}).get("datavalue", {}).get("value", {})
        match = re.match(r"[+-]?(\d{4})", str(value.get("time", "")))
        if match:
            years.append(match.group(1))
    return min(years) if years else ""


def runtime_minutes(entity: dict) -> int | None:
    for statement in entity.get("claims", {}).get("P2047", []):
        value = statement.get("mainsnak", {}).get("datavalue", {}).get("value", {})
        try:
            amount = float(value.get("amount"))
        except (TypeError, ValueError):
            continue
        unit = str(value.get("unit", "")).rsplit("/", 1)[-1]
        minutes = amount * 60 if unit == HOUR else amount / 60 if unit == SECOND else amount
        if 1 <= minutes <= 1000:
            return int(round(minutes))
    return None


def people_and_things(films: dict[str, dict]) -> list[str]:
    """Every item a film record points at, so their names can be fetched once."""
    wanted = set()
    for entity in films.values():
        for prop in ("P57", "P58", "P161", "P725", "P136", "P921", "P495", "P364"):
            ids = claim_ids(entity, prop)
            wanted.update(ids[:CAST_DEPTH] if prop in ("P161", "P725") else ids)
    return sorted(wanted)


# Film types that say something genre does not: Wikidata files "animated" and
# "documentary" as what a film is, and often leaves them out of its genres.
TYPE_GENRES = {
    "Q29168811": "animation", "Q202866": "animation", "Q17517379": "animation",
    "Q93204": "documentary", "Q24865": "documentary",
}


def extracts(titles: list[str], workers: int = 3) -> dict[str, str]:
    """Plain-text lead paragraphs of English Wikipedia articles."""
    def fetch(batch: list[str]) -> dict[str, str]:
        payload = request_json(WIKIPEDIA_API, {
            "action": "query", "prop": "extracts", "exintro": "1", "explaintext": "1",
            "redirects": "1", "titles": "|".join(batch), "format": "json",
            "formatversion": "2", "maxlag": "5",
        })
        query = payload.get("query", {})
        # Map back through normalisation and redirects to the asked-for title.
        back = {}
        for step in query.get("normalized", []) + query.get("redirects", []):
            back[step["to"]] = back.get(step["from"], step["from"])
        found = {}
        for page in query.get("pages", []):
            if page.get("extract"):
                asked = back.get(page["title"], page["title"])
                found[asked] = page["extract"]
        return found

    out: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(fetch, list(chunks(sorted(set(titles)), EXTRACT_BATCH))):
            out.update(result)
    return out


def trim_overview(text: str) -> str:
    """The lead's first few sentences, which is where a synopsis lives."""
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= OVERVIEW_CHARS:
        return text
    cut = text[:OVERVIEW_CHARS]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[: end + 1] if end > 200 else cut.rsplit(" ", 1)[0] + "…"


def genres_for(words: list[str], types: list[str]) -> list[str]:
    genres = map_genres(words)
    genres.update(TYPE_GENRES[t] for t in types if t in TYPE_GENRES)
    return sorted(genres)


def keywords_for(subjects: list[str], words: list[str]) -> list[str]:
    # A specific genre ("folk horror") is too fine for the genre list but is
    # exactly what a keyword is for.
    fine = [clean(g) for g in words]
    return list(dict.fromkeys(
        [s.lower() for s in subjects] + [f for f in fine if f and f not in GENRES]
    ))


def condense(entity: dict, names: dict[str, str], extract: str = "") -> dict:
    """One film, in the shape the features and the app expect."""
    def named(prop: str, limit: int | None = None) -> list[str]:
        ids = claim_ids(entity, prop)
        ids = ids[:limit] if limit else ids
        return [names[i] for i in ids if names.get(i)]

    genre_words = named("P136")
    subjects = named("P921")
    article = entity.get("sitelinks", {}).get("enwiki", {}).get("title", "")
    title = label(entity) or re.sub(r"\s*\((\d{4} )?film\)$", "", article)

    types = [t for t in claim_ids(entity, "P31") if t in TYPE_GENRES]

    return {
        "title": title,
        "year": release_year(entity),
        "runtime": runtime_minutes(entity),
        "genre": genres_for(genre_words, types),
        # Kept so a change to the genre mapping can be re-applied without
        # fetching every film again (see FilmCache.remap).
        "genre_source": {"words": genre_words, "types": types},
        "director": named("P57"),
        "writer": named("P58"),
        # An animated film's performers are its voice cast.
        "cast": named("P161", CAST_DEPTH) or named("P725", CAST_DEPTH),
        "keyword": keywords_for(subjects, genre_words),
        "keyword_source": subjects,
        "country": named("P495"),
        "language": named("P364"),
        "overview": trim_overview(extract),
        "wikipedia": article,
        "qid": entity.get("id", ""),
        "imdb": next(iter(claim_strings(entity, "P345")), ""),
    }


class FilmCache:
    """Condensed film records by Wikidata ID, kept on disk between runs."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.records: dict[str, dict] = (
            json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        )

    def remap(self) -> None:
        """Re-apply the current genre and keyword rules to cached films."""
        for record in self.records.values():
            source = (record or {}).get("genre_source")
            if source is None:
                continue
            record["genre"] = genres_for(source["words"], source["types"])
            record["keyword"] = keywords_for(record.get("keyword_source", []), source["words"])

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.records, ensure_ascii=False), encoding="utf-8")

    def fill_overviews(self, qids: list[str], step: int = 1000, log=print) -> None:
        """Add Wikipedia synopses to cached films fetched without them.

        Resumable: films already holding a synopsis are skipped, and progress
        is saved after each step. A film whose article has no extract is marked
        with an empty string so it isn't asked for again.
        """
        todo = [
            q for q in dict.fromkeys(qids)
            if (record := self.records.get(q))
            and record.get("wikipedia")
            and not record.get("overview")
            and not record.get("overview_checked")
        ]
        log(f"fetching synopses for {len(todo)} films")
        for start in range(0, len(todo), step):
            batch = todo[start:start + step]
            texts = extracts([self.records[q]["wikipedia"] for q in batch])
            for qid in batch:
                record = self.records[qid]
                record["overview"] = trim_overview(texts.get(record["wikipedia"], ""))
                record["overview_checked"] = True
            self.save()
            log(f"  {min(start + step, len(todo))}/{len(todo)}")

    def fill(self, qids: list[str], overviews: bool = True, step: int = 2000,
             log=print) -> None:
        """Fetch whatever isn't cached yet, saving after each step."""
        # Records from before genre sources were kept can't be remapped, so
        # they are fetched again.
        todo = [
            q for q in dict.fromkeys(qids)
            if q not in self.records
            or (self.records[q] is not None and "genre_source" not in self.records[q])
        ]
        log(f"{len(self.records)} films cached, fetching {len(todo)}")
        for start in range(0, len(todo), step):
            batch = todo[start:start + step]
            films = get_entities(batch, "labels|claims|sitelinks")
            names = {
                qid: label(entity)
                for qid, entity in get_entities(people_and_things(films), "labels").items()
            }
            articles = {
                qid: entity.get("sitelinks", {}).get("enwiki", {}).get("title")
                for qid, entity in films.items()
            }
            texts = extracts([a for a in articles.values() if a]) if overviews else {}
            for qid, entity in films.items():
                self.records[qid] = condense(entity, names, texts.get(articles[qid] or "", ""))
            # Not found at all: remember that too, so it isn't asked again.
            for qid in batch:
                self.records.setdefault(qid, None)
            self.save()
            log(f"  {min(start + step, len(todo))}/{len(todo)}")
