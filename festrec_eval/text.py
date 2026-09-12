"""Synopsis similarity.

For a festival premiere there is no cast you've heard of and no crowd verdict -
often just a paragraph of description. This scores that paragraph against the
paragraphs of films the person already loved or hated.

TF-IDF is deliberate: it needs no model download, no API, and no network, so it
can run in a browser on the user's own device for free. A sentence-embedding
model would read the text better; this establishes whether the signal is worth
that complexity at all.
"""

from __future__ import annotations

import math
import re
from collections import Counter

import numpy as np
from scipy import sparse

TOKEN = re.compile(r"[a-z][a-z']+")
MIN_DF = 3  # a word in one or two synopses is noise, not a theme
MIN_LEN = 3

# Words that say nothing about what a film is like.
STOPWORDS = frozenset("""
a an the and or but if while of to in on at by for with from into over after
before he she it they them his her its their our your my me you i we us who
whom whose which that this these those there here when where why how all any
both each few more most other some such no nor not only own same so than too
very can will just should now then also been being have has had having do does
did doing is are was were be am as up down out off again further once about
against between through during above below film movie story life man woman
young old new find finds must becomes turns comes goes based
""".split())


class TextIndex:
    """A TF-IDF view of every film's synopsis."""

    def __init__(self, overviews: dict[int, str]):
        self.movie_ids = [m for m, text in overviews.items() if text]
        self.row_of = {m: i for i, m in enumerate(self.movie_ids)}

        docs = [self._tokenize(overviews[m]) for m in self.movie_ids]
        document_freq = Counter(term for doc in docs for term in set(doc))
        self.vocabulary = {
            term: i
            for i, (term, count) in enumerate(
                sorted(t for t in document_freq.items() if t[1] >= MIN_DF)
            )
        }

        n_docs = max(len(docs), 1)
        self.idf = np.zeros(len(self.vocabulary))
        for term, index in self.vocabulary.items():
            self.idf[index] = math.log(n_docs / (1 + document_freq[term])) + 1.0

        self.matrix = self._build(docs)

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        return [
            t for t in TOKEN.findall(text.lower())
            if len(t) >= MIN_LEN and t not in STOPWORDS
        ]

    def _build(self, docs: list[list[str]]) -> sparse.csr_matrix:
        rows, cols, values = [], [], []
        for row, doc in enumerate(docs):
            counts = Counter(t for t in doc if t in self.vocabulary)
            if not counts:
                continue
            for term, count in counts.items():
                index = self.vocabulary[term]
                rows.append(row)
                cols.append(index)
                # Sublinear tf: a word used six times isn't six times the theme.
                values.append((1.0 + math.log(count)) * self.idf[index])

        matrix = sparse.csr_matrix(
            (values, (rows, cols)),
            shape=(len(docs), len(self.vocabulary)),
            dtype=np.float64,
        )
        norms = sparse.linalg.norm(matrix, axis=1)
        norms[norms == 0] = 1.0
        return sparse.diags(1.0 / norms) @ matrix

    def vector(self, movie_id: int):
        row = self.row_of.get(movie_id)
        return None if row is None else self.matrix[row]

    def profile(self, centered: dict[int, float]):
        """Taste as a direction in word space: liked themes minus disliked ones."""
        rows = [(self.row_of[m], v) for m, v in centered.items() if m in self.row_of]
        if not rows:
            return None
        indices = np.array([r for r, _ in rows])
        weights = np.array([v for _, v in rows])
        return sparse.csr_matrix(weights @ self.matrix[indices])

    def similarity(
        self, profile, movie_id: int, own_weight: float | None = None
    ) -> float:
        """Cosine between a film and the taste direction.

        `own_weight` removes the film's own contribution from the profile,
        for the leave-one-out case.
        """
        vector = self.vector(movie_id)
        if vector is None or profile is None:
            return 0.0

        if own_weight is not None:
            profile = profile - own_weight * vector

        norm = sparse.linalg.norm(profile)
        if norm == 0:
            return 0.0
        return float((vector @ profile.T).toarray()[0, 0] / norm)
