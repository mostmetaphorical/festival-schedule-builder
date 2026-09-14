"""Blend components in the exact form the browser can compute.

The ensemble experiment (run_ensemble.py) used information the app doesn't
have - a MovieLens user's learned factors, MovieLens's own vectors for the
films a person rated. An app user is a stranger whose rated films are mostly
not in MovieLens. Everything here is computed only from:

  - the person's own ratings (title, rating), resolved to content
  - each film's content: synopsis words, credits, keywords, genres
  - tables precomputed offline from MovieLens: crowd scores for people,
    keywords and genres, and a content -> (bias, factors) mapping

so that what is cross-validated is what ships.
"""

from __future__ import annotations

import numpy as np
from scipy import sparse

from .cf import BiasedMF, Biases, Ratings

CREDIT_FACETS = (
    "director", "writer", "cast", "keyword", "genre", "editor", "cinematographer",
    # Collaborations: a director with their usual editor, or with a cinematographer
    # whose films land well, is a different prospect from either alone.
    "director+editor", "director+cinematographer", "editor+cinematographer",
    "director+editor+cinematographer",
)
CAST_TRACK_DEPTH = 5


def credit_entities(record: dict) -> dict[str, list[str]]:
    """Every track-record entity of a film: single credits and crew combinations.

    `record` holds lists under director, writer, cast, keyword, genre, editor
    and cinematographer - a metadata record or a festival film's entities.
    """
    def names(facet):
        return list(dict.fromkeys(record.get(facet) or []))

    out = {facet: names(facet) for facet in ("director", "writer", "keyword", "genre", "editor", "cinematographer")}
    out["cast"] = names("cast")[:CAST_TRACK_DEPTH]
    d, e, c = out["director"], out["editor"], out["cinematographer"]
    out["director+editor"] = [f"{x}|{y}" for x in d for y in e]
    out["director+cinematographer"] = [f"{x}|{y}" for x in d for y in c]
    out["editor+cinematographer"] = [f"{x}|{y}" for x in e for y in c]
    out["director+editor+cinematographer"] = [f"{x}|{y}|{z}" for x in d for y in e for z in c]
    return out


def steadied_base(sums: np.ndarray, counts: np.ndarray, prior_mean: float, prior_weight: float) -> np.ndarray:
    """Each person's average, blended with prior_weight pseudo-ratings at prior_mean."""
    return (sums + prior_weight * prior_mean) / (counts + prior_weight)


class PersonBase:
    """The steadied average - the same base the content ridge uses."""

    name = "base"

    def __init__(self, prior_weight: float = 5.0):
        self.prior_weight = prior_weight

    def fit(self, data: Ratings) -> "PersonBase":
        self.prior_mean = data.mean
        sums = np.bincount(data.u, data.r, data.n_users)
        counts = np.bincount(data.u, minlength=data.n_users).astype(float)
        self.base = steadied_base(sums, counts, self.prior_mean, self.prior_weight)
        return self

    def predict(self, u, i):
        return self.base[u]


class ServableContentKNN:
    """Base plus the residuals of the rated films that read most like the candidate.

    Residuals are taken against the steadied base, and similarity is cosine
    over content vectors built from what the app has for any film.
    """

    name = "content_knn"

    def __init__(self, content: sparse.csr_matrix, k: int = 20, damping: float = 0.1,
                 power: float = 2.0, prior_weight: float = 5.0):
        self.content, self.k, self.damping, self.power = content, k, damping, power
        self.person = PersonBase(prior_weight)

    def fit(self, data: Ratings) -> "ServableContentKNN":
        self.person.fit(data)
        resid = data.r - self.person.base[data.u]
        self.user_items = data.matrix(resid).tocsr()
        return self

    def predict(self, u, i):
        out = self.person.base[u].astype(float)
        order = np.argsort(u, kind="stable")
        for chunk in np.split(order, np.flatnonzero(np.diff(u[order])) + 1):
            if len(chunk) == 0:
                continue
            user = int(u[chunk[0]])
            start, end = self.user_items.indptr[user], self.user_items.indptr[user + 1]
            rated = self.user_items.indices[start:end]
            if len(rated) == 0:
                continue
            S = (self.content[i[chunk]] @ self.content[rated].T).toarray()
            S[np.equal.outer(i[chunk], rated)] = 0.0
            S = np.sign(S) * np.abs(S) ** self.power
            k = min(self.k, S.shape[1])
            # Ties broken by rating order, as the browser does - genre-only
            # matches often share a similarity exactly.
            top = np.argsort(-S, axis=1, kind="stable")[:, :k]
            s = np.take_along_axis(S, top, axis=1)
            v = self.user_items.data[start:end][top]
            out[chunk] += (s * v).sum(axis=1) / (np.abs(s).sum(axis=1) + self.damping)
        return out


class ContentFactors:
    """Offline: MF on the crowd, then kernel ridge from content to each film's (bias, factors).

    `item_side(rows)` gives the predicted bias and factors for any film whose
    content row is known - a MovieLens film or a festival premiere alike.
    """

    def __init__(self, content: sparse.csr_matrix, factors: int = 25, reg: float = 0.1,
                 kernel_reg: float = 0.3, min_item_ratings: int = 3):
        self.content = content
        self.mf = BiasedMF(factors=factors, reg=reg)
        self.kernel_reg, self.min_item_ratings = kernel_reg, min_item_ratings

    def fit(self, data: Ratings) -> "ContentFactors":
        self.mf.fit(data)
        counts = self.mf.base.item_count
        train_items = np.where(counts >= self.min_item_ratings)[0]
        self.X = self.content[train_items]
        K = (self.X @ self.X.T).toarray()
        self.mu = self.mf.base.mu
        targets = np.column_stack([self.mf.base.bi[train_items], self.mf.Q[train_items]])
        self.alpha = np.linalg.solve(K + self.kernel_reg * np.eye(len(train_items)), targets)
        return self

    def item_side(self, rows: sparse.csr_matrix) -> tuple[np.ndarray, np.ndarray]:
        pred = np.asarray((rows @ self.X.T) @ self.alpha)
        return pred[:, 0], pred[:, 1:]


class ServableContentMF:
    """A person's CF taste, folded in from their ratings of content-predicted films.

    Every film - rated or candidate - uses its content-predicted bias and
    factors, since that is all the app has for most of what someone rated.
    """

    name = "content_mf"

    def __init__(self, content: sparse.csr_matrix, factors: int = 25, reg: float = 0.1,
                 kernel_reg: float = 0.3, fold_reg: float = 0.1, user_reg: float = 5.0, iters: int = 4):
        self.factors = ContentFactors(content, factors=factors, reg=reg, kernel_reg=kernel_reg)
        self.content = content
        self.fold_reg, self.user_reg, self.iters = fold_reg, user_reg, iters

    def fit(self, data: Ratings) -> "ServableContentMF":
        self.factors.fit(data)
        self.bi_hat, self.q_hat = self.factors.item_side(self.content)
        self.mu = self.factors.mu
        self.user_side = fold_in(data, self.mu, self.bi_hat, self.q_hat, self.fold_reg, self.user_reg, self.iters)
        return self

    def predict(self, u, i):
        bu, P = self.user_side
        return self.mu + bu[u] + self.bi_hat[i] + np.einsum("ij,ij->i", P[u], self.q_hat[i])


def fold_in(data: Ratings, mu, bi_hat, q_hat, fold_reg, user_reg, iters):
    """Solve each person's bias and factors against fixed film-side predictions."""
    k = q_hat.shape[1]
    bu = np.zeros(data.n_users)
    P = np.zeros((data.n_users, k))
    order = np.argsort(data.u, kind="stable")
    bounds = np.flatnonzero(np.diff(data.u[order])) + 1
    eye = np.eye(k)
    for rows in np.split(order, bounds):
        if len(rows) == 0:
            continue
        user = int(data.u[rows[0]])
        items, r = data.i[rows], data.r[rows]
        Q = q_hat[items]
        b, p = 0.0, np.zeros(k)
        for _ in range(iters):
            b = float((r - mu - bi_hat[items] - Q @ p).sum() / (len(rows) + user_reg))
            target = r - mu - b - bi_hat[items]
            p = np.linalg.solve(Q.T @ Q + fold_reg * len(rows) * eye, Q.T @ target)
        bu[user], P[user] = b, p
    return bu, P


class CreditsCrowd:
    """How the crowd rated other films sharing each credit - a track record.

    For every entity (a director, an actor, a keyword, a genre): the shrunk mean
    of the crowd's film biases over the films it appears in. A film's feature
    per facet is the average over its entities, leaving the film's own bias out.
    Returns features, not a prediction: the blend weighs them.
    """

    name = "credits_crowd"

    def __init__(self, entity_rows: dict[str, sparse.csr_matrix], shrink: float = 3.0,
                 bias_reg: tuple[float, float] = (5.0, 10.0)):
        # facet -> items x entities indicator
        self.entity_rows = entity_rows
        self.shrink, self.bias_reg = shrink, bias_reg

    def fit(self, data: Ratings) -> "CreditsCrowd":
        base = Biases(*self.bias_reg).fit(data)
        rated = (base.item_count > 0).astype(float)
        self.bi = base.bi * rated
        self.rated = rated
        self.tables = {}
        for facet, M in self.entity_rows.items():
            sums = np.asarray(M.T @ self.bi).ravel()
            counts = np.asarray(M.T @ rated).ravel()
            self.tables[facet] = (sums, counts)
        return self

    def features(self, i: np.ndarray) -> np.ndarray:
        cols = []
        for facet, M in self.entity_rows.items():
            sums, counts = self.tables[facet]
            rows = M[i]
            # Leave the film's own contribution out: it has no crowd at serving time.
            own_b = self.bi[i]
            own_c = self.rated[i]
            n_entities = np.asarray(rows.sum(axis=1)).ravel()
            s = np.asarray(rows @ sums).ravel() - own_b * n_entities
            c = np.asarray(rows @ counts).ravel() - own_c * n_entities
            cols.append(s / (c + self.shrink))
            cols.append(np.log1p(np.maximum(c, 0)))
        return np.column_stack(cols)


CONTENT_FACETS = ("director", "writer", "cast", "keyword", "genre")
HASH_WIDTH = 1 << 20


class ContentSpace:
    """Content vectors for any film described as a dict, in one fixed column space.

    Columns: the model's synopsis vocabulary (tf-idf, as festrec_eval/text.py
    weighs it), then each facet's entities hashed into a wide block. Each block
    is L2-normalised, then the whole row - so the dot product of two rows is
    the same cosine festrec_eval/cf.content_matrix gives, and a festival film
    built later lands in the same space as the MovieLens films it is compared
    with. Hashing (crc32) means no vocabulary has to be carried around.
    """

    def __init__(self, text_index):
        self.text = text_index
        self.width = len(text_index.vocabulary) + HASH_WIDTH * len(CONTENT_FACETS)

    def rows(self, records: list[dict]) -> sparse.csr_matrix:
        import math
        import zlib
        from collections import Counter

        rows, cols, vals = [], [], []
        vocab, idf = self.text.vocabulary, self.text.idf
        text_width = len(vocab)
        for row, record in enumerate(records):
            blocks = []
            counts = Counter(t for t in self.text._tokenize(record.get("overview") or record.get("synopsis") or "")
                             if t in vocab)
            if counts:
                entries = [(vocab[t], (1.0 + math.log(c)) * idf[vocab[t]]) for t, c in counts.items()]
                norm = math.sqrt(sum(v * v for _, v in entries))
                blocks.append([(c, v / norm) for c, v in entries])
            for f, facet in enumerate(CONTENT_FACETS):
                names = list(dict.fromkeys(record.get(facet) or []))
                if names:
                    offset = text_width + f * HASH_WIDTH
                    value = 1.0 / math.sqrt(len(names))
                    blocks.append([(offset + zlib.crc32(n.encode("utf-8")) % HASH_WIDTH, value) for n in names])
            if not blocks:
                continue
            scale = 1.0 / math.sqrt(len(blocks))
            merged: dict[int, float] = {}
            for block in blocks:
                for c, v in block:
                    merged[c] = merged.get(c, 0.0) + v * scale
            rows.extend([row] * len(merged))
            cols.extend(merged.keys())
            vals.extend(merged.values())
        return sparse.csr_matrix((vals, (rows, cols)), shape=(len(records), self.width))


def fit_content_factors(dataset, metadata, text_index, factors: int, kernel_reg: float,
                        reg: float = 0.1, min_item_ratings: int = 3, seed_users=None):
    """The shipped content -> (bias, factors) mapping, trained on all of MovieLens."""
    item_ids = [int(m) for m in np.sort(dataset.films.index.to_numpy())]
    space = ContentSpace(text_index)
    content = space.rows([metadata.get(m) or {} for m in item_ids])
    ratings = dataset.ratings
    uix = {u: n for n, u in enumerate(np.sort(ratings.userId.unique()))}
    iix = {m: n for n, m in enumerate(item_ids)}
    data = Ratings(ratings.userId.map(uix).to_numpy(), ratings.movieId.map(iix).to_numpy(),
                   ratings.rating.to_numpy(float), len(uix), len(item_ids))
    model = ContentFactors(content, factors=factors, reg=reg, kernel_reg=kernel_reg,
                           min_item_ratings=min_item_ratings).fit(data)
    return space, model


def entity_matrices(item_ids, metadata, facets=CREDIT_FACETS):
    """facet -> sparse items x entities indicator, plus each facet's vocabulary."""
    per_item = [credit_entities(metadata.get(movie_id) or {}) for movie_id in item_ids]
    out, vocabularies = {}, {}
    for facet in facets:
        vocab: dict[str, int] = {}
        rows, cols = [], []
        for row, entities in enumerate(per_item):
            for entity in entities.get(facet, []):
                cols.append(vocab.setdefault(entity, len(vocab)))
                rows.append(row)
        out[facet] = sparse.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(item_ids), max(len(vocab), 1)))
        vocabularies[facet] = vocab
    return out, vocabularies
