"""Checks on the test itself.

An evaluation that leaks will happily report a great score for a model that
cannot work. These assertions are what let the headline numbers be trusted.

    python test_sanity.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from festrec_eval import metrics as M
from festrec_eval.data import build_splits, load_movielens, sample_users
from festrec_eval.features import (
    RECOMMENDED_FACETS,
    FeatureSpace,
    compute_item_stats,
)
from festrec_eval.models import ContentRidge, UserMean

DATA = "data/ml-latest-small"
checks: list[tuple[str, bool, str]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    checks.append((name, passed, detail))


def main() -> None:
    dataset = load_movielens(DATA)
    user_ids = sample_users(dataset, 40, seed=1, min_ratings=15)
    splits = build_splits(dataset, user_ids, 0.7, seed=1)

    # 1. The minimum-ratings rule is actually enforced.
    counts = dataset.ratings.groupby("userId").size()
    check(
        "profiles under 15 ratings are excluded",
        bool((counts.loc[user_ids] >= 15).all()),
        f"smallest sampled profile: {int(counts.loc[user_ids].min())} ratings",
    )

    # 1b. Film metadata actually loaded. A silent index misalignment once left
    #     45% of titles and years null, which quietly emptied the year and
    #     decade features rather than raising anything.
    films = dataset.films
    null_titles = int(films.title.isna().sum())
    null_years = int(films.year.isna().sum())
    sample = films.loc[1] if 1 in films.index else films.iloc[0]
    check(
        "film titles and years survived loading",
        null_titles == 0 and null_years < len(films) * 0.05,
        f"{null_titles} null titles, {null_years} null years, "
        f"first film: {sample.title!r} ({sample.year})",
    )

    # 2. Train and test never overlap, and the split is really 70/30.
    overlap = sum(
        len(set(s.train.movieId) & set(s.test.movieId)) for s in splits
    )
    fractions = [len(s.train) / (len(s.train) + len(s.test)) for s in splits]
    check("no film appears in both halves", overlap == 0, f"{overlap} overlaps")
    check(
        "split is ~70/30",
        0.65 <= float(np.mean(fractions)) <= 0.75,
        f"mean train share {np.mean(fractions):.3f}",
    )

    # 3. The cold feature space exposes no crowd statistics at all.
    cold = FeatureSpace(dataset.films)
    check(
        "cold condition has no crowd features",
        not any("item_" in n for n in cold.feature_names),
        ", ".join(cold.feature_names),
    )

    # 4. Crowd stats used in the warm condition come from other raters only.
    sampled = set(int(u) for u in user_ids)
    stats = compute_item_stats(dataset.ratings, exclude_users=sampled)
    contributors = dataset.ratings[
        dataset.ratings.movieId.isin(stats.index)
        & dataset.ratings.userId.isin(sampled)
    ]
    recomputed_clean = compute_item_stats(
        dataset.ratings[~dataset.ratings.userId.isin(sampled)]
    )
    check(
        "warm crowd stats exclude the sampled users",
        bool(np.allclose(stats["mean"].to_numpy(), recomputed_clean["mean"].to_numpy())),
        f"{len(contributors)} sampled-user ratings correctly left out",
    )

    # 5. Leave-one-out really removes a training film's own rating from its
    #    own features - otherwise the model would be scored on memorisation.
    profile = cold.build_profile(splits[0].user_id, splits[0].train)
    train_ids = splits[0].train.movieId.astype(int).tolist()[:20]
    with_loo = cold.transform(profile, train_ids, leave_out=True)
    without_loo = cold.transform(profile, train_ids, leave_out=False)
    check(
        "leave-one-out changes training features",
        not np.allclose(with_loo, without_loo),
        f"mean abs diff {np.abs(with_loo - without_loo).mean():.4f}",
    )

    # 5b. Synopsis similarity has its own leave-one-out path: a training film
    #     must not be compared against a taste profile it helped build.
    cache = Path("data/tmdb_cache.json")
    if cache.exists():
        tmdb = {
            int(k): v
            for k, v in json.loads(cache.read_text(encoding="utf-8")).items()
        }
        rich = FeatureSpace(dataset.films, tmdb=tmdb, include_facets=("text",))
        rich_profile = rich.build_profile(splits[0].user_id, splits[0].train)
        ids = splits[0].train.movieId.astype(int).tolist()[:20]
        column = rich.feature_names.index("text_sim")
        loo = rich.transform(rich_profile, ids, leave_out=True)[:, column]
        raw = rich.transform(rich_profile, ids, leave_out=False)[:, column]

        # The invariant is equivalence with a profile that never saw the film -
        # not that the score drops. For a film rated below the person's average,
        # its contribution is negative, so removing it correctly raises the score.
        # Hold the person's average fixed while dropping the film, so this
        # measures the leave-one-out arithmetic alone. (Rebuilding the average
        # over one fewer film shifts every centered rating a little, which is
        # expected and would otherwise show up as a spurious gap.)
        rebuilt = []
        for movie_id in ids:
            without = {
                m: v for m, v in rich_profile.centered.items() if m != movie_id
            }
            rebuilt.append(
                rich.text.similarity(rich.text.profile(without), movie_id)
            )
        matches = np.allclose(loo, np.array(rebuilt), atol=1e-9)
        check(
            "synopsis leave-one-out matches a profile rebuilt without the film",
            bool(matches and not np.allclose(loo, raw)),
            f"max gap {np.max(np.abs(loo - np.array(rebuilt))):.5f}, "
            f"mean shift vs no-LOO {np.mean(np.abs(raw - loo)):.4f}",
        )

    # 6. The decisive one: with ratings shuffled inside each profile, there is
    #    no taste left to learn, so the model must collapse to the baseline.
    #    Run against the configuration we actually ship - a richer feature set
    #    has more room to fit noise, so this is where it must be measured.
    if cache.exists():
        cold = FeatureSpace(
            dataset.films, tmdb=tmdb, include_facets=RECOMMENDED_FACETS
        )
    rng = np.random.default_rng(0)
    shuffled = []
    for split in splits:
        copy = split.train.copy()
        copy["rating"] = rng.permutation(copy.rating.to_numpy())
        shuffled.append(
            type(split)(user_id=split.user_id, train=copy, test=split.test)
        )

    profiles = {
        s.user_id: cold.build_profile(s.user_id, s.train) for s in shuffled
    }
    model = ContentRidge()
    model.fit(shuffled, cold, profiles)
    baseline = UserMean()

    def score(m) -> float:
        rows = []
        for split in shuffled:
            ids = split.test.movieId.astype(int).tolist()
            actual = split.test.rating.to_numpy(float)
            rows.append(
                M.user_metrics(
                    actual,
                    np.asarray(m.predict(split, profiles[split.user_id], ids), float),
                )
            )
        return M.aggregate(rows)["ndcg@10"]["mean"]

    noise_gain = score(model) - score(baseline)
    check(
        "shuffled ratings destroy the signal",
        noise_gain < 0.02,
        f"ndcg@10 gain on noise: {noise_gain:+.3f} "
        f"(real signal is +0.063 on 300 users)",
    )

    print("\nSanity checks")
    print("-" * 78)
    for name, passed, detail in checks:
        print(f"[{'PASS' if passed else 'FAIL'}] {name:<45} {detail}")
    print("-" * 78)
    failures = sum(1 for _, passed, _ in checks if not passed)
    print(f"{len(checks) - failures}/{len(checks)} passed")
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
