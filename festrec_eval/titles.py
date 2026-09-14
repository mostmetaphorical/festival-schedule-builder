"""Matching film titles across sources.

The same film is written differently everywhere. MovieLens moves articles to
the end ("Big Lebowski, The"), keeps original titles in brackets ("Oldboy
(Oldeuboi)"), and writes years in the title. Letterboxd writes "The Big
Lebowski". Wikidata writes it a third way, sometimes with different punctuation.

Unmatched means a film the person rated contributes nothing, so this is worth
getting right. app/js/metadata.js implements the same rules - change one,
change both.
"""

from __future__ import annotations

import re
import unicodedata

ARTICLES = ("the", "a", "an", "le", "la", "les", "les", "el", "il", "der",
            "die", "das", "l'", "les")
TRAILING_ARTICLE = re.compile(
    r",\s+(the|a|an|le|la|les|el|il|der|die|das)\s*$", re.IGNORECASE
)
BRACKETED = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")
PUNCTUATION = re.compile(r"[^\w\s]")
WHITESPACE = re.compile(r"\s+")


def strip_accents(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(c)
    )


def normalise(title: str) -> str:
    """One canonical spelling of a title."""
    text = strip_accents(str(title)).lower().strip()
    text = TRAILING_ARTICLE.sub(lambda m: "", text).strip()
    # Put the article back where English speakers write it, then drop it: a
    # lookup shouldn't hinge on whether a source kept "the" at all.
    text = BRACKETED.sub("", text)
    text = text.replace("&", " and ")
    text = PUNCTUATION.sub(" ", text)
    text = WHITESPACE.sub(" ", text).strip()
    for article in ("the ", "a ", "an "):
        if text.startswith(article):
            text = text[len(article):]
            break
    return text


def variants(title: str) -> list[str]:
    """Every spelling worth indexing, including bracketed original titles."""
    forms = {normalise(title)}
    for bracketed in re.findall(r"[\(\[]([^\)\]]*)[\)\]]", str(title)):
        # Years and format notes aren't alternate titles.
        if bracketed.isdigit() or len(bracketed) < 3:
            continue
        forms.add(normalise(bracketed))
    return sorted(f for f in forms if f)


def key(title: str, year: object = "") -> str:
    year_text = "" if year in (None, "") else str(year).strip()
    if year_text.endswith(".0"):
        year_text = year_text[:-2]
    return f"{normalise(title)}|{year_text}"
