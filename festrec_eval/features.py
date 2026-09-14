"""Turning a taste profile into numbers a model can fit.

Every feature answers one question: how has this person rated films that share
something with the candidate? Sharing a director, a genre, a release decade.
Crucially, none of it needs the crowd's opinion of the candidate itself, which
is what makes it usable on a festival premiere nobody has seen yet.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .text import TextIndex

# Affinity with thin evidence is pulled toward "no signal". One shared actor is
# not an opinion; twelve films by the same director is.
SHRINKAGE = 3.0
YEAR_SIGMA = 10.0
RUNTIME_SIGMA = 25.0

# Facets from MovieLens alone. Film metadata (credits, keywords and so on,
# from Wikidata) adds the rest when it's been fetched.
BASE_FACETS = ("genre", "decade")
RICH_FACETS = ("director", "writer", "cast", "keyword", "country", "language")

# The set that measured best (see README). Genre, decade and year are
# deliberately absent: they are crude enough to dilute the sharper signals
# rather than add to them.
RECOMMENDED_FACETS = ("director", "writer", "cast", "keyword", "text")

# When the person has rated nobody involved - a world premiere by a first-time
# director, which is most of a festival - the sharp signals are all zero and
# the crude ones are all there is. Genre roughly doubles the top-5 lift in that
# case (see README), so a second model is fitted for it.
THIN_FACETS = ("genre", "decade", "year", "keyword", "text")
PEOPLE_FACETS = ("director", "writer", "cast")


@dataclass
class UserProfile:
    """One person's train-half history, indexed for fast lookup."""

    user_id: int
    mean: float
    n_train: int
    rating_std: float
    # facet -> entity -> [sum of centered ratings, count of films]
    facet_stats: dict[str, dict[str, list[float]]]
    # movieId -> centered rating, for the leave-one-out correction
    centered: dict[int, float]
    years: np.ndarray
    runtimes: np.ndarray
    genre_vector: dict[str, float] = field(default_factory=dict)
    text_profile: object | None = None  # sparse taste direction over words


class FeatureSpace:
    """Builds feature matrices for (user, candidate film) pairs."""

    def __init__(
        self,
        films: pd.DataFrame,
        metadata: dict[int, dict] | None = None,
        item_stats: pd.DataFrame | None = None,
        include_facets: tuple[str, ...] | None = None,
    ):
        """`item_stats` is crowd data: supply it only for the warm comparison.

        `include_facets` narrows the signals in play, so an ablation run can
        show which of them a gain actually came from.
        """
        self.films = films
        self.metadata = metadata or {}
        self.item_stats = item_stats
        self.facets = list(BASE_FACETS)
        if self.metadata:
            self.facets += list(RICH_FACETS)
        # Runtime and synopsis text aren't sets of entities, but they are
        # switchable by name like the rest.
        self.use_runtime = bool(self.metadata)
        self.use_text = bool(self.metadata)
        self.use_year = True
        if include_facets is not None:
            extras = {"runtime", "text", "year"}
            unknown = set(include_facets) - set(self.facets) - extras
            if unknown:
                raise ValueError(f"unknown facets: {sorted(unknown)}")
            self.facets = [f for f in self.facets if f in include_facets]
            self.use_runtime = self.use_runtime and "runtime" in include_facets
            self.use_text = self.use_text and "text" in include_facets
            self.use_year = "year" in include_facets
        # The genre cosine is a second view of the genre facet, so it follows it.
        self.use_genre_cosine = "genre" in self.facets

        self.text = (
            TextIndex({
                movie_id: (meta or {}).get("overview", "")
                for movie_id, meta in self.metadata.items()
            })
            if self.use_text
            else None
        )

        self._entities = {mid: self._film_entities(mid) for mid in films.index}
        self._year = films.year.to_dict()
        self._runtime = {
            mid: (meta or {}).get("runtime") for mid, meta in self.metadata.items()
        }

    # ---------- film side ----------

    def _film_entities(self, movie_id: int) -> dict[str, frozenset[str]]:
        row = self.films.loc[movie_id]
        entities: dict[str, frozenset[str]] = {
            "genre": frozenset(row.genres),
            "decade": frozenset(
                [str(int(row.year // 10 * 10))] if pd.notna(row.year) else []
            ),
        }
        meta = self.metadata.get(movie_id)
        if self.metadata:
            meta = meta or {}
            for facet in RICH_FACETS:
                entities[facet] = frozenset(meta.get(facet) or [])
        return entities

    # ---------- user side ----------

    def build_profile(self, user_id: int, train: pd.DataFrame) -> UserProfile:
        mean = float(train.rating.mean())
        centered = {
            int(r.movieId): float(r.rating) - mean for r in train.itertuples()
        }

        stats: dict[str, dict[str, list[float]]] = {f: {} for f in self.facets}
        for movie_id, value in centered.items():
            for facet, entities in self._entities.get(movie_id, {}).items():
                bucket = stats.setdefault(facet, {})
                for entity in entities:
                    slot = bucket.setdefault(entity, [0.0, 0.0])
                    slot[0] += value
                    slot[1] += 1.0

        genre_vector = {
            entity: total / count
            for entity, (total, count) in stats.get("genre", {}).items()
        }

        movie_ids = list(centered)
        years = np.array(
            [self._year.get(m, np.nan) for m in movie_ids], dtype=float
        )
        runtimes = np.array(
            [
                self._runtime.get(m) if self._runtime.get(m) else np.nan
                for m in movie_ids
            ],
            dtype=float,
        )
        values = np.array([centered[m] for m in movie_ids], dtype=float)

        return UserProfile(
            user_id=int(user_id),
            mean=mean,
            n_train=len(centered),
            rating_std=float(train.rating.std(ddof=0)) if len(train) > 1 else 0.0,
            facet_stats=stats,
            centered=centered,
            years=np.vstack([years, values]) if len(movie_ids) else np.empty((2, 0)),
            runtimes=(
                np.vstack([runtimes, values]) if len(movie_ids) else np.empty((2, 0))
            ),
            genre_vector=genre_vector,
            text_profile=self.text.profile(centered) if self.text else None,
        )

    # ---------- features ----------

    @property
    def feature_names(self) -> list[str]:
        names: list[str] = []
        for facet in self.facets:
            names += [f"{facet}_aff", f"{facet}_support"]
        if self.use_year:
            names += ["year_aff", "year_support"]
        if self.use_genre_cosine:
            names += ["genre_cosine"]
        # Constant within a user, so they shift predictions but never the order.
        names += ["n_train_log", "user_rating_std"]
        if self.use_runtime:
            names += ["runtime_aff", "runtime_support"]
        if self.use_text:
            names += ["text_sim"]
        if self.item_stats is not None:
            names += ["item_mean_dev", "item_count_log"]
        return names

    def _facet_affinity(
        self, profile: UserProfile, movie_id: int, facet: str, leave_out: bool
    ) -> tuple[float, float]:
        """Overlap-weighted mean of the user's centered ratings, shrunk."""
        entities = self._entities.get(movie_id, {}).get(facet, frozenset())
        if not entities:
            return 0.0, 0.0

        bucket = profile.facet_stats.get(facet, {})
        total = 0.0
        weight = 0.0
        for entity in entities:
            slot = bucket.get(entity)
            if slot:
                total += slot[0]
                weight += slot[1]

        if leave_out and movie_id in profile.centered:
            # The candidate is in the train half; strip its own contribution so
            # the feature can't peek at the answer.
            own = profile.centered[movie_id]
            shared = sum(1 for e in entities if e in bucket)
            total -= own * shared
            weight -= shared

        if weight <= 0:
            return 0.0, 0.0
        return total / (weight + SHRINKAGE), math.log1p(weight)

    def _kernel_affinity(
        self,
        pairs: np.ndarray,
        target: float,
        sigma: float,
        profile: UserProfile,
        movie_id: int,
        leave_out: bool,
    ) -> tuple[float, float]:
        """Same idea for a numeric axis: near-in-years films count for more."""
        if pairs.size == 0 or not np.isfinite(target):
            return 0.0, 0.0

        values, centered = pairs[0], pairs[1]
        valid = np.isfinite(values)
        if not valid.any():
            return 0.0, 0.0

        weights = np.zeros_like(values)
        weights[valid] = np.exp(-(((values[valid] - target) / sigma) ** 2))

        if leave_out and movie_id in profile.centered:
            own = profile.centered[movie_id]
            match = np.isclose(centered, own) & np.isclose(values, target)
            if match.any():
                weights[np.argmax(match)] = 0.0

        weight = float(weights.sum())
        if weight <= 0:
            return 0.0, 0.0
        return float((weights * centered).sum()) / (weight + SHRINKAGE), math.log1p(
            weight
        )

    def _genre_cosine(self, profile: UserProfile, movie_id: int) -> float:
        genres = self._entities.get(movie_id, {}).get("genre", frozenset())
        if not genres or not profile.genre_vector:
            return 0.0
        shared = [profile.genre_vector.get(g, 0.0) for g in genres]
        norm = math.sqrt(sum(v * v for v in profile.genre_vector.values()))
        if norm == 0:
            return 0.0
        return float(sum(shared) / (math.sqrt(len(genres)) * norm))

    def transform(
        self, profile: UserProfile, movie_ids: list[int], leave_out: bool = False
    ) -> np.ndarray:
        """Feature matrix for one user against a list of candidate films."""
        rows = []
        for movie_id in movie_ids:
            row: list[float] = []
            for facet in self.facets:
                row.extend(self._facet_affinity(profile, movie_id, facet, leave_out))

            if self.use_year:
                row.extend(
                    self._kernel_affinity(
                        profile.years,
                        float(self._year.get(movie_id, np.nan)),
                        YEAR_SIGMA,
                        profile,
                        movie_id,
                        leave_out,
                    )
                )
            if self.use_genre_cosine:
                row.append(self._genre_cosine(profile, movie_id))
            row.append(math.log1p(profile.n_train))
            row.append(profile.rating_std)

            if self.use_runtime:
                runtime = self._runtime.get(movie_id)
                row.extend(
                    self._kernel_affinity(
                        profile.runtimes,
                        float(runtime) if runtime else float("nan"),
                        RUNTIME_SIGMA,
                        profile,
                        movie_id,
                        leave_out,
                    )
                )

            if self.text is not None:
                own = (
                    profile.centered.get(movie_id)
                    if leave_out and movie_id in profile.centered
                    else None
                )
                row.append(
                    self.text.similarity(profile.text_profile, movie_id, own)
                )

            if self.item_stats is not None:
                row.extend(self._item_features(movie_id))

            rows.append(row)

        return np.array(rows, dtype=float)

    def _item_features(self, movie_id: int) -> tuple[float, float]:
        """Crowd opinion of the candidate. Warm mode only."""
        assert self.item_stats is not None
        if movie_id not in self.item_stats.index:
            return 0.0, 0.0
        row = self.item_stats.loc[movie_id]
        return float(row["mean_dev"]), math.log1p(float(row["count"]))


def people_support(
    space: FeatureSpace,
    profile: UserProfile,
    movie_id: int,
    leave_out: bool = False,
) -> float:
    """How many of the person's rated films share a director, writer or actor.

    Zero means the recommender's strongest signal is unavailable for this film,
    which is the normal case at a festival of premieres.

    `leave_out` matters when the film is itself in the profile: without it,
    every film matches itself through its own credits and nothing ever looks
    thin.
    """
    return sum(
        space._facet_affinity(profile, movie_id, facet, leave_out)[1]
        for facet in PEOPLE_FACETS
        if facet in space.facets
    )


def compute_item_stats(
    ratings: pd.DataFrame, exclude_users: set[int] | None = None
) -> pd.DataFrame:
    """Average rating per film, from users outside the test sample.

    This is the crowd signal a festival premiere does not have. It exists here
    only so the warm comparison can show how much it is worth.
    """
    pool = ratings
    if exclude_users:
        pool = pool[~pool.userId.isin(exclude_users)]
    global_mean = float(pool.rating.mean())
    grouped = pool.groupby("movieId").rating.agg(["mean", "count"])
    grouped["mean_dev"] = grouped["mean"] - global_mean
    return grouped
