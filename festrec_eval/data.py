"""Loading, filtering and splitting of rating histories.

The test treats every rater as a separate "festival-goer": 70% of their ratings
build the taste profile, the remaining 30% stand in for the festival slate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

TITLE_YEAR = re.compile(r"\s*\((\d{4})\)\s*$")
NO_GENRES = "(no genres listed)"


@dataclass
class Dataset:
    """Ratings plus the film metadata they point at."""

    ratings: pd.DataFrame  # userId, movieId, rating, timestamp
    films: pd.DataFrame  # indexed by movieId: title, year, genres (list[str])

    def user_ratings(self, user_id: int) -> pd.DataFrame:
        return self.ratings[self.ratings.userId == user_id]


@dataclass
class UserSplit:
    """One festival-goer: the profile we learn from, the films we're judged on."""

    user_id: int
    train: pd.DataFrame  # movieId, rating
    test: pd.DataFrame  # movieId, rating

    @property
    def train_mean(self) -> float:
        return float(self.train.rating.mean())


def load_movielens(directory: str | Path) -> Dataset:
    """Read a MovieLens export (ml-latest-small and friends share this layout)."""
    directory = Path(directory)
    ratings = pd.read_csv(directory / "ratings.csv")
    movies = pd.read_csv(directory / "movies.csv")

    years = movies.title.str.extract(TITLE_YEAR, expand=False)
    # Take values positionally. Passing the Series themselves would make pandas
    # align their row numbers against the movieId index, turning most rows null.
    films = pd.DataFrame(
        {
            "title": movies.title.str.replace(TITLE_YEAR, "", regex=True).to_numpy(),
            "year": pd.to_numeric(years, errors="coerce").to_numpy(),
            "genres": [
                [] if g == NO_GENRES else g.split("|") for g in movies.genres
            ],
        },
        index=pd.Index(movies.movieId, name="movieId"),
    )

    # A rating pointing at a film we have no metadata for is unusable.
    ratings = ratings[ratings.movieId.isin(films.index)]
    return Dataset(ratings=ratings, films=films)


def eligible_users(dataset: Dataset, min_ratings: int = 15) -> np.ndarray:
    """Users with enough history to build a profile from, per the spec."""
    counts = dataset.ratings.groupby("userId").size()
    return np.sort(counts[counts >= min_ratings].index.to_numpy())


def sample_users(
    dataset: Dataset,
    n_users: int,
    seed: int = 0,
    min_ratings: int = 15,
) -> np.ndarray:
    """Draw a random sample of eligible users."""
    pool = eligible_users(dataset, min_ratings)
    if n_users >= len(pool):
        return pool
    rng = np.random.default_rng(seed)
    return np.sort(rng.choice(pool, size=n_users, replace=False))


def split_user(
    dataset: Dataset,
    user_id: int,
    train_frac: float = 0.7,
    seed: int = 0,
    strategy: str = "random",
) -> UserSplit:
    """Hold out a slice of one user's ratings.

    "random" shuffles; "time" trains on what they watched first and tests on
    what came later, which is closer to how the app is actually used.
    """
    history = dataset.user_ratings(user_id)[["movieId", "rating", "timestamp"]]

    if strategy == "time":
        ordered = history.sort_values("timestamp")
    elif strategy == "random":
        rng = np.random.default_rng((seed, int(user_id)))
        order = rng.permutation(len(history))
        ordered = history.iloc[order]
    else:
        raise ValueError(f"unknown split strategy: {strategy!r}")

    cut = int(round(len(ordered) * train_frac))
    # Both halves must be non-empty for the split to mean anything.
    cut = min(max(cut, 1), len(ordered) - 1)
    columns = ["movieId", "rating"]
    return UserSplit(
        user_id=int(user_id),
        train=ordered.iloc[:cut][columns].reset_index(drop=True),
        test=ordered.iloc[cut:][columns].reset_index(drop=True),
    )


def build_splits(
    dataset: Dataset,
    user_ids: np.ndarray,
    train_frac: float = 0.7,
    seed: int = 0,
    strategy: str = "random",
) -> list[UserSplit]:
    return [
        split_user(dataset, uid, train_frac=train_frac, seed=seed, strategy=strategy)
        for uid in user_ids
    ]
