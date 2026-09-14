"""Collaborative filtering, for the ensemble.

These learn from other people's ratings of the same film. That makes them
strong wherever a film has been rated widely, and blind to a festival premiere
nobody has rated yet - which is why ContentToFactors exists: it predicts a
film's CF factors from its credits, keywords and synopsis, so the CF view of
someone's taste still reaches a film with no ratings.

Every model here takes ratings as integer-indexed arrays (user, item, rating)
and predicts for arrays of (user, item) pairs. Unknown users or items fall back
to whatever the model can still say, down to the global mean.
"""

from __future__ import annotations

import numpy as np
from scipy import sparse


class Ratings:
    """Integer-indexed ratings with the lookups the models share."""

    def __init__(self, users: np.ndarray, items: np.ndarray, ratings: np.ndarray,
                 n_users: int, n_items: int):
        self.u = users.astype(np.int64)
        self.i = items.astype(np.int64)
        self.r = ratings.astype(np.float64)
        self.n_users = n_users
        self.n_items = n_items
        self.mean = float(self.r.mean())

    def matrix(self, values: np.ndarray | None = None) -> sparse.csr_matrix:
        data = self.r if values is None else values
        return sparse.csr_matrix((data, (self.u, self.i)), shape=(self.n_users, self.n_items))


# ---------------------------------------------------------------- baselines

class Biases:
    """r ~ mu + b_u + b_i, regularised, by alternating least squares."""

    name = "biases"

    def __init__(self, reg_user: float = 5.0, reg_item: float = 10.0, iters: int = 10):
        self.reg_user, self.reg_item, self.iters = reg_user, reg_item, iters

    def fit(self, data: Ratings) -> "Biases":
        self.mu = data.mean
        self.bu = np.zeros(data.n_users)
        self.bi = np.zeros(data.n_items)
        cu = np.bincount(data.u, minlength=data.n_users)
        ci = np.bincount(data.i, minlength=data.n_items)
        for _ in range(self.iters):
            resid = data.r - self.mu - self.bu[data.u]
            self.bi = np.bincount(data.i, resid, data.n_items) / (ci + self.reg_item)
            resid = data.r - self.mu - self.bi[data.i]
            self.bu = np.bincount(data.u, resid, data.n_users) / (cu + self.reg_user)
        self.item_count = ci
        self.user_count = cu
        return self

    def predict(self, u: np.ndarray, i: np.ndarray) -> np.ndarray:
        return self.mu + self.bu[u] + self.bi[i]

    def residuals(self, data: Ratings) -> np.ndarray:
        return data.r - self.predict(data.u, data.i)


class UserBias(Biases):
    """mu + b_u only: the person's own (shrunk) average."""

    name = "user_bias"

    def predict(self, u, i):
        return self.mu + self.bu[u]


# ---------------------------------------------------------------- matrix factorisation

class BiasedMF:
    """r ~ mu + b_u + b_i + p_u . q_i, by alternating least squares.

    Regularisation scales with each user's and item's rating count
    (weighted-lambda), which is what keeps ALS from overfitting rare items.
    """

    name = "mf"

    def __init__(self, factors: int = 20, reg: float = 0.1, iters: int = 15,
                 bias_reg: tuple[float, float] = (5.0, 10.0), seed: int = 0):
        self.factors, self.reg, self.iters = factors, reg, iters
        self.bias_reg, self.seed = bias_reg, seed

    def fit(self, data: Ratings) -> "BiasedMF":
        self.base = Biases(*self.bias_reg).fit(data)
        resid = self.base.residuals(data)
        R = data.matrix(resid)
        Rt = R.T.tocsr()
        rng = np.random.default_rng(self.seed)
        k = self.factors
        self.P = rng.normal(0, 0.1, (data.n_users, k))
        self.Q = rng.normal(0, 0.1, (data.n_items, k))
        eye = np.eye(k)
        for _ in range(self.iters):
            self.P = self._solve(R, self.Q, eye)
            self.Q = self._solve(Rt, self.P, eye)
        return self

    def _solve(self, M: sparse.csr_matrix, fixed: np.ndarray, eye: np.ndarray) -> np.ndarray:
        out = np.zeros((M.shape[0], fixed.shape[1]))
        for row in range(M.shape[0]):
            start, end = M.indptr[row], M.indptr[row + 1]
            if start == end:
                continue
            cols = M.indices[start:end]
            vals = M.data[start:end]
            F = fixed[cols]
            out[row] = np.linalg.solve(F.T @ F + self.reg * len(cols) * eye, F.T @ vals)
        return out

    def predict(self, u, i):
        return self.base.predict(u, i) + np.einsum("ij,ij->i", self.P[u], self.Q[i])


# ---------------------------------------------------------------- neighbourhoods

class ItemKNN:
    """Baseline + weighted residuals of the k most similar items the user rated.

    Similarity is the shrunk Pearson correlation of bias residuals:
    s_ij * n_ij / (n_ij + shrink).
    """

    name = "item_knn"

    def __init__(self, k: int = 30, shrink: float = 100.0, damping: float = 0.0,
                 bias_reg: tuple[float, float] = (5.0, 10.0)):
        self.k, self.shrink, self.damping, self.bias_reg = k, shrink, damping, bias_reg

    def fit(self, data: Ratings) -> "ItemKNN":
        self.base = Biases(*self.bias_reg).fit(data)
        resid = self.base.residuals(data)
        R = data.matrix(resid).tocsc()                     # users x items residuals
        B = data.matrix(np.ones_like(resid)).tocsc()       # rated indicator
        self.user_items = data.matrix(resid).tocsr()
        self.rated = np.asarray(B.sum(axis=0)).ravel() > 0
        # Dense item-item similarities: ~9.7k items fit in a few hundred MB.
        dot = (R.T @ R).toarray().astype(np.float32)
        co = (B.T @ B).toarray().astype(np.float32)
        norms = np.sqrt(np.diag(dot)).copy()
        norms[norms == 0] = 1.0
        dot /= norms[:, None]
        dot /= norms[None, :]
        dot *= co / (co + self.shrink)
        np.fill_diagonal(dot, 0.0)
        self.sim = dot
        return self

    def predict(self, u, i):
        out = self.base.predict(u, i).copy()
        for idx in range(len(u)):
            item, user = int(i[idx]), int(u[idx])
            if not self.rated[item]:
                continue
            start, end = self.user_items.indptr[user], self.user_items.indptr[user + 1]
            rated = self.user_items.indices[start:end]
            if len(rated) == 0:
                continue
            sims = self.sim[item, rated]
            top = np.argsort(-sims)[: self.k]
            s = sims[top]
            keep = s > 0
            if not keep.any():
                continue
            out[idx] += float(s[keep] @ self.user_items.data[start:end][top][keep]) / (float(s[keep].sum()) + self.damping)
        return out


class UserKNN:
    """Baseline + weighted residuals of the k most similar users who rated the item."""

    name = "user_knn"

    def __init__(self, k: int = 40, shrink: float = 50.0, damping: float = 0.0,
                 bias_reg: tuple[float, float] = (5.0, 10.0)):
        self.k, self.shrink, self.damping, self.bias_reg = k, shrink, damping, bias_reg

    def fit(self, data: Ratings) -> "UserKNN":
        self.base = Biases(*self.bias_reg).fit(data)
        resid = self.base.residuals(data)
        R = data.matrix(resid).tocsr()
        B = data.matrix(np.ones_like(resid)).tocsr()
        dot = (R @ R.T).toarray()
        norms = np.sqrt(np.diag(dot)); norms[norms == 0] = 1.0
        co = (B @ B.T).toarray()
        self.sim = dot / np.outer(norms, norms) * (co / (co + self.shrink))
        np.fill_diagonal(self.sim, 0.0)
        self.item_users = R.T.tocsr()
        return self

    def predict(self, u, i):
        out = self.base.predict(u, i).copy()
        for idx in range(len(u)):
            item, user = int(i[idx]), int(u[idx])
            start, end = self.item_users.indptr[item], self.item_users.indptr[item + 1]
            raters = self.item_users.indices[start:end]
            if len(raters) == 0:
                continue
            sims = self.sim[user, raters]
            top = np.argsort(-sims)[: self.k]
            s = sims[top]
            keep = s > 0
            if not keep.any():
                continue
            out[idx] += float(s[keep] @ self.item_users.data[start:end][top][keep]) / (float(s[keep].sum()) + self.damping)
        return out


class ContentKNN:
    """The person's shrunk average plus residuals of the films they rated that
    *read* most like the candidate - cosine over content (synopsis, credits,
    keywords, genres). Needs no ratings of the candidate, so it works on a
    premiere.
    """

    name = "content_knn"

    def __init__(self, content: sparse.csr_matrix, k: int = 50, damping: float = 0.5,
                 power: float = 1.0, bias_reg: tuple[float, float] = (5.0, 10.0)):
        self.content = content
        self.k, self.damping, self.power, self.bias_reg = k, damping, power, bias_reg

    def fit(self, data: Ratings) -> "ContentKNN":
        self.base = Biases(*self.bias_reg).fit(data)
        # Residuals against the person's average only: the candidate has no
        # film bias to lean on, so its neighbours shouldn't either.
        resid = data.r - (self.base.mu + self.base.bu[data.u])
        self.user_items = data.matrix(resid).tocsr()
        return self

    def predict(self, u, i):
        out = self.base.mu + self.base.bu[u]
        order = np.argsort(u, kind="stable")
        bounds = np.flatnonzero(np.diff(u[order])) + 1
        for chunk in np.split(order, bounds):
            if len(chunk) == 0:
                continue
            user = int(u[chunk[0]])
            start, end = self.user_items.indptr[user], self.user_items.indptr[user + 1]
            rated = self.user_items.indices[start:end]
            if len(rated) == 0:
                continue
            values = self.user_items.data[start:end]
            S = (self.content[i[chunk]] @ self.content[rated].T).toarray()
            S[np.equal.outer(i[chunk], rated)] = 0.0
            if self.power != 1.0:
                S = np.sign(S) * np.abs(S) ** self.power
            k = min(self.k, S.shape[1])
            top = np.argpartition(-S, k - 1, axis=1)[:, :k]
            s = np.take_along_axis(S, top, axis=1)
            v = values[top]
            out[chunk] += (s * v).sum(axis=1) / (np.abs(s).sum(axis=1) + self.damping)
        return out


# ---------------------------------------------------------------- content -> CF

class ContentToFactors:
    """Matrix factorisation whose item side can be predicted from content.

    Fits BiasedMF, then kernel ridge from each item's content vector (tf-idf
    synopsis plus one-hot credits, keywords and genres, L2-normalised) to its
    bias and factors. A film nobody has rated gets factors from films that read
    like it, so the person's CF taste vector still applies.

    `use_content_for_known` = False keeps learned factors for rated films and
    uses the content mapping only for unrated ones.
    """

    name = "content_mf"

    def __init__(self, content: sparse.csr_matrix, factors: int = 20, reg: float = 0.1,
                 kernel_reg: float = 1.0, iters: int = 15, min_item_ratings: int = 5,
                 use_content_for_known: bool = False):
        self.content = content
        self.mf = BiasedMF(factors=factors, reg=reg, iters=iters)
        self.kernel_reg = kernel_reg
        self.min_item_ratings = min_item_ratings
        self.use_content_for_known = use_content_for_known

    def fit(self, data: Ratings) -> "ContentToFactors":
        self.mf.fit(data)
        counts = self.mf.base.item_count
        train_items = np.where(counts >= self.min_item_ratings)[0]
        X = self.content[train_items]
        K = (X @ X.T).toarray()
        targets = np.column_stack([self.mf.base.bi[train_items], self.mf.Q[train_items]])
        # Weight each film by how well its factors are known.
        alpha = np.linalg.solve(K + self.kernel_reg * np.eye(len(train_items)), targets)
        self.train_items = train_items
        self.alpha = alpha
        self.X = X
        self.known = counts > 0
        return self

    def item_side(self, items: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Content-predicted bias and factors for the given items."""
        k = self.content[items] @ self.X.T
        pred = np.asarray(k @ self.alpha)
        return pred[:, 0], pred[:, 1:]

    def predict(self, u, i):
        bi_hat, q_hat = self.item_side(i)
        base = self.mf.base
        pred = base.mu + base.bu[u] + bi_hat + np.einsum("ij,ij->i", self.mf.P[u], q_hat)
        if not self.use_content_for_known:
            known = self.known[i]
            pred[known] = self.mf.predict(u[known], i[known])
        return pred


def content_matrix(item_ids: list[int], metadata: dict[int, dict], text_index) -> sparse.csr_matrix:
    """One row per item: tf-idf synopsis, then one-hot people, keywords and genres.

    Each block is L2-normalised and weighted equally, then the row normalised,
    so a cosine kernel over rows compares films on all of them at once.
    """
    blocks = []
    n = len(item_ids)
    # Synopsis block, aligned to item order.
    rows, cols, vals = [], [], []
    for row, movie_id in enumerate(item_ids):
        vec = text_index.vector(movie_id) if text_index is not None else None
        if vec is not None and vec.nnz:
            rows.extend([row] * vec.nnz); cols.extend(vec.indices.tolist()); vals.extend(vec.data.tolist())
    width = len(text_index.vocabulary) if text_index is not None else 0
    blocks.append(sparse.csr_matrix((vals, (rows, cols)), shape=(n, width)))

    for facet in ("director", "writer", "cast", "keyword", "genre"):
        vocab: dict[str, int] = {}
        rows, cols = [], []
        for row, movie_id in enumerate(item_ids):
            for entity in (metadata.get(movie_id) or {}).get(facet) or []:
                cols.append(vocab.setdefault(entity, len(vocab)))
                rows.append(row)
        block = sparse.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, max(len(vocab), 1)))
        blocks.append(block)

    normalised = []
    for block in blocks:
        norms = np.sqrt(np.asarray(block.multiply(block).sum(axis=1)).ravel())
        norms[norms == 0] = 1.0
        normalised.append(sparse.diags(1.0 / norms) @ block)
    full = sparse.hstack(normalised).tocsr()
    norms = np.sqrt(np.asarray(full.multiply(full).sum(axis=1)).ravel())
    norms[norms == 0] = 1.0
    return (sparse.diags(1.0 / norms) @ full).tocsr()
