"""The recommenders under test, and the baselines they have to beat.

A predictor is only interesting if it beats "assume they'll rate everything
the way they rate everything else". That is what UserMean is here for.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .data import UserSplit
from .features import FeatureSpace, UserProfile

RATING_MIN, RATING_MAX = 0.5, 5.0


class Model:
    """Common interface: learn from the train halves, score held-out films."""

    name = "model"
    needs_crowd = False  # True for anything a festival premiere couldn't use

    def fit(
        self,
        splits: list[UserSplit],
        space: FeatureSpace,
        profiles: dict[int, UserProfile],
    ) -> None:
        pass

    def predict(
        self, split: UserSplit, profile: UserProfile, movie_ids: list[int]
    ) -> np.ndarray:
        raise NotImplementedError

    @staticmethod
    def _clip(values: np.ndarray) -> np.ndarray:
        return np.clip(values, RATING_MIN, RATING_MAX)


class GlobalMean(Model):
    """Everyone gets the average rating. The floor."""

    name = "global_mean"

    def fit(self, splits, space, profiles) -> None:
        self.value = float(
            np.mean([r for s in splits for r in s.train.rating.to_numpy()])
        )

    def predict(self, split, profile, movie_ids) -> np.ndarray:
        return np.full(len(movie_ids), self.value)


class UserMean(Model):
    """Predict each person's own average. The baseline that actually matters."""

    name = "user_mean"

    def predict(self, split, profile, movie_ids) -> np.ndarray:
        return np.full(len(movie_ids), profile.mean)


class ItemMean(Model):
    """What the crowd thought of this film. Unavailable for premieres."""

    name = "item_mean"
    needs_crowd = True

    def __init__(self, item_stats: pd.DataFrame, global_mean: float):
        self.item_stats = item_stats
        self.global_mean = global_mean

    def predict(self, split, profile, movie_ids) -> np.ndarray:
        out = []
        for movie_id in movie_ids:
            if movie_id in self.item_stats.index:
                out.append(float(self.item_stats.loc[movie_id, "mean"]))
            else:
                out.append(profile.mean)
        return self._clip(np.array(out))


class BiasModel(Model):
    """Global + how generous this rater is + how liked this film is."""

    name = "bias"
    needs_crowd = True

    def __init__(self, item_stats: pd.DataFrame, global_mean: float):
        self.item_stats = item_stats
        self.global_mean = global_mean

    def predict(self, split, profile, movie_ids) -> np.ndarray:
        user_bias = profile.mean - self.global_mean
        out = []
        for movie_id in movie_ids:
            item_bias = (
                float(self.item_stats.loc[movie_id, "mean_dev"])
                if movie_id in self.item_stats.index
                else 0.0
            )
            out.append(self.global_mean + user_bias + item_bias)
        return self._clip(np.array(out))


class ContentRidge(Model):
    """The real candidate: ridge regression over taste-overlap features.

    Fitted across all sampled users at once, so it learns how much a shared
    director is worth relative to a shared genre. Each user's own average is
    added back at prediction time.
    """

    name = "content_ridge"

    def __init__(
        self,
        alphas: tuple[float, ...] = (1.0, 3.0, 10.0, 30.0, 100.0),
        evidence_shrinkage: float = 0.0,
    ):
        """`evidence_shrinkage` pulls predictions toward the person's own
        average when nothing is known about a film.

        Standardised features make "no evidence" a specific point in feature
        space rather than a neutral one, so a film with no credits and no
        themes gets whatever score that point happens to carry - which put
        unknown shorts at the top of a festival slate. Scaling the deviation
        by how much is actually known fixes that: no evidence, no opinion.
        """
        self.alphas = alphas
        self.evidence_shrinkage = evidence_shrinkage
        self.weights: np.ndarray | None = None
        self.alpha_: float | None = None

    def fit(self, splits, space, profiles) -> None:
        self.space = space
        blocks, targets, groups = [], [], []
        for index, split in enumerate(splits):
            profile = profiles[split.user_id]
            movie_ids = split.train.movieId.astype(int).tolist()
            if not movie_ids:
                continue
            # leave_out: a training film must not inform its own features.
            blocks.append(space.transform(profile, movie_ids, leave_out=True))
            targets.append(split.train.rating.to_numpy(float) - profile.mean)
            groups.append(np.full(len(movie_ids), index))

        features = np.vstack(blocks)
        target = np.concatenate(targets)
        group = np.concatenate(groups)

        self.center = features.mean(axis=0)
        scale = features.std(axis=0)
        self.scale = np.where(scale > 1e-9, scale, 1.0)

        scaled = (features - self.center) / self.scale
        self.alpha_ = self._choose_alpha(scaled, target, group)
        self.weights = self._solve(scaled, target, self.alpha_)

    def _solve(self, X: np.ndarray, y: np.ndarray, alpha: float) -> np.ndarray:
        gram = X.T @ X + alpha * np.eye(X.shape[1])
        return np.linalg.solve(gram, X.T @ y)

    def _choose_alpha(
        self, X: np.ndarray, y: np.ndarray, group: np.ndarray
    ) -> float:
        """Pick the ridge penalty by holding out whole users at a time."""
        unique = np.unique(group)
        if len(unique) < 5 or len(self.alphas) == 1:
            return float(self.alphas[len(self.alphas) // 2])

        folds = np.array_split(unique, 5)
        best, best_error = self.alphas[0], np.inf
        for alpha in self.alphas:
            errors = []
            for fold in folds:
                held = np.isin(group, fold)
                if held.all() or not held.any():
                    continue
                weights = self._solve(X[~held], y[~held], alpha)
                errors.append(np.mean((X[held] @ weights - y[held]) ** 2))
            error = float(np.mean(errors)) if errors else np.inf
            if error < best_error:
                best, best_error = alpha, error
        return float(best)

    def predict(self, split, profile, movie_ids) -> np.ndarray:
        assert self.weights is not None, "fit() first"
        features = self.space.transform(profile, movie_ids, leave_out=False)
        scaled = (features - self.center) / self.scale
        deviation = scaled @ self.weights

        if self.evidence_shrinkage > 0:
            evidence = self._evidence(features)
            deviation = deviation * (
                evidence / (evidence + self.evidence_shrinkage)
            )

        return self._clip(profile.mean + deviation)

    def _evidence(self, features: np.ndarray) -> np.ndarray:
        """How much the person's history actually says about each film.

        The support columns are log1p counts of matching rated films, so their
        sum is a direct measure of evidence - and zero means zero.
        """
        if not hasattr(self, "_support_columns"):
            self._support_columns = [
                i for i, name in enumerate(self.space.feature_names)
                if name.endswith("_support")
            ]
        if not self._support_columns:
            return np.ones(len(features))
        return features[:, self._support_columns].sum(axis=1)

    def coefficients(self) -> dict[str, float]:
        assert self.weights is not None
        return dict(zip(self.space.feature_names, self.weights.tolist()))


class TwoRegime(Model):
    """One model for films you have a connection to, another for the rest.

    At a festival, most of the slate is premieres by people the person has
    never seen, where every credit-based feature is zero. A model fitted on
    the general case spends its weights on signals that aren't there; this
    fits a second one on exactly the films where they aren't.
    """

    name = "two_regime"

    def __init__(self, films, tmdb, rich_facets, thin_facets, people_facets):
        self.films = films
        self.tmdb = tmdb
        self.rich_facets = rich_facets
        self.thin_facets = thin_facets
        self.people_facets = people_facets

    def fit(self, splits, space, profiles) -> None:
        from .features import FeatureSpace, people_support

        self.rich_space = FeatureSpace(
            self.films, tmdb=self.tmdb, include_facets=self.rich_facets
        )
        self.thin_space = FeatureSpace(
            self.films, tmdb=self.tmdb, include_facets=self.thin_facets
        )
        self.reference = FeatureSpace(
            self.films, tmdb=self.tmdb, include_facets=self.people_facets
        )

        self.rich_profiles = {
            s.user_id: self.rich_space.build_profile(s.user_id, s.train)
            for s in splits
        }
        self.thin_profiles = {
            s.user_id: self.thin_space.build_profile(s.user_id, s.train)
            for s in splits
        }
        self.reference_profiles = {
            s.user_id: self.reference.build_profile(s.user_id, s.train)
            for s in splits
        }

        # The thin model only learns from films whose credits told us nothing,
        # which is the situation it will be used in.
        thin_splits = []
        for split in splits:
            profile = self.reference_profiles[split.user_id]
            keep = [
                people_support(
                    self.reference, profile, int(row.movieId), leave_out=True
                )
                == 0
                for row in split.train.itertuples()
            ]
            subset = split.train[pd.Series(keep, index=split.train.index)]
            if len(subset) >= 5:
                thin_splits.append(
                    UserSplit(
                        user_id=split.user_id, train=subset, test=split.test
                    )
                )

        self.rich = ContentRidge()
        self.rich.fit(splits, self.rich_space, self.rich_profiles)
        self.thin = ContentRidge()
        self.thin.fit(thin_splits, self.thin_space, self.thin_profiles)

    def predict(self, split, profile, movie_ids) -> np.ndarray:
        from .features import people_support

        reference = self.reference_profiles[split.user_id]
        out = []
        for movie_id in movie_ids:
            has_people = people_support(self.reference, reference, movie_id) > 0
            model = self.rich if has_people else self.thin
            profiles = self.rich_profiles if has_people else self.thin_profiles
            out.append(
                float(model.predict(split, profiles[split.user_id], [movie_id])[0])
            )
        return np.array(out)
