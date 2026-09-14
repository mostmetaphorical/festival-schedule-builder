"""The genre words the model knows, and how other sources' wording maps onto them.

The model was fitted on a fixed list of broad genres. Festivals invent their own
("Dream-logic slasher", "Children in Peril") and Wikidata is finer-grained
("folk horror film", "comedy-drama"), so both are mapped onto the same list.
Anything unmapped contributes nothing to the genre signal - better than
inventing a category the model has never seen - and is kept as a keyword
instead, where a specific phrase can still match.

app/js/recommend.js reads genres in this vocabulary; change one, check both.
"""

from __future__ import annotations

import re

GENRES = (
    "action", "adventure", "animation", "comedy", "crime", "documentary",
    "drama", "family", "fantasy", "history", "horror", "music", "mystery",
    "romance", "science fiction", "thriller", "war", "western",
)

WORDS = {
    "action": "action", "adventure": "adventure", "animation": "animation",
    "animated": "animation", "stop-motion": "animation", "anime": "animation",
    "comedy": "comedy", "dark comedy": "comedy", "black comedy": "comedy",
    "comedic": "comedy", "crime": "crime", "documentary": "documentary",
    "doc": "documentary", "drama": "drama", "family": "family",
    "fantasy": "fantasy", "dark fantasy": "fantasy", "history": "history",
    "historical": "history", "horror": "horror", "creature horror": "horror",
    "body horror": "horror", "folk horror": "horror", "slasher": "horror",
    "supernatural": "horror", "music": "music", "musical": "music",
    "mystery": "mystery", "romance": "romance", "romantic": "romance",
    "rom-com": "romance", "science fiction": "science fiction",
    "sci-fi": "science fiction", "scifi": "science fiction",
    "thriller": "thriller", "war": "war", "western": "western",
    "neo-western": "western",
    # Wording that means one of the genres without using its word.
    "satire": "comedy", "parody": "comedy", "splatter": "horror", "gory": "horror",
    "ghost": "horror", "giallo": "horror", "creature": "horror", "zombie": "horror",
    "vampire": "horror", "psychodrama": "drama", "melodrama": "drama",
    "noir": "thriller", "neo-noir": "thriller", "heist": "crime",
    "gangster": "crime", "spy": "thriller", "espionage": "thriller",
    "survival": "thriller", "kaiju": "science fiction",
    "cyberpunk": "science fiction", "dystopian": "science fiction",
    "space": "science fiction", "swordplay": "action", "martial": "action",
    "wuxia": "action", "revenge": "thriller", "erotic": "romance",
    "concert": "music", "biographical": "history", "biopic": "history",
    "docudrama": "documentary", "superhero": "action", "disaster": "action",
    "detective": "mystery", "whodunit": "mystery", "coming-of-age": "drama",
    "sports": "drama", "legal": "drama", "teen": "drama", "christmas": "family",
    "children's": "family", "fairy tale": "fantasy", "sword and sorcery": "fantasy",
}

# Names that are genuinely two genres at once.
COMPOUNDS = {
    "romantic comedy": {"romance", "comedy"},
    "rom-com": {"romance", "comedy"},
    "comedy-drama": {"comedy", "drama"},
    "comedy drama": {"comedy", "drama"},
    "dramedy": {"comedy", "drama"},
    "horror comedy": {"horror", "comedy"},
    "comedy horror": {"horror", "comedy"},
    "musical comedy": {"music", "comedy"},
    "science fiction comedy": {"science fiction", "comedy"},
    "action comedy": {"action", "comedy"},
}

# Words that describe the medium, not a genre: "horror film" is horror.
MEDIUM = re.compile(r"\b(feature |short |television |tv )?(film|movie|cinema)s?\b")


def clean(phrase: str) -> str:
    """"Folk horror film" -> "folk horror"."""
    text = MEDIUM.sub("", str(phrase).lower())
    return re.sub(r"\s+", " ", text).strip(" -,")


def map_genres(phrases: list[str]) -> set[str]:
    """Map any source's genre wording onto the model's genres.

    A whole phrase that is itself a genre wins ("romantic comedy"). Otherwise
    the phrase is read by its head word, the way English builds genre names:
    "crime drama" is a drama, "psychological horror" is horror, "action
    thriller" is a thriller. Counting every word instead gave Seven six genres
    and blurred them all. A hyphenated pair ("comedy-drama") is both, and a
    phrase listing several ("horror / comedy") is each of them.
    """
    found: set[str] = set()
    for phrase in phrases:
        for part in re.split(r"\s*[/,·|]\s*", clean(phrase)):
            part = part.strip()
            if not part:
                continue
            if part in COMPOUNDS:
                found.update(COMPOUNDS[part])
                continue
            if part in WORDS:
                found.add(WORDS[part])
                continue
            head = part.split()[-1]
            if head in WORDS:
                found.add(WORDS[head])
                continue
            pieces = [WORDS[p] for p in head.split("-") if p in WORDS]
            if pieces:
                found.update(pieces)
                continue
            # "Slasher horror comedy" style run-ons: fall back to any genre word.
            found.update(WORDS[w] for w in part.split() if w in WORDS)
    return found
