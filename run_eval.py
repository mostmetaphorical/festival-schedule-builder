"""Run the recommender test.

Takes a random sample of raters, builds a taste profile from 70% of each
person's ratings, and scores how well the held-out 30% is predicted.

    python run_eval.py --n-users 100

Two conditions are reported:

  cold  - the candidate films carry no crowd ratings, the way a festival
          premiere doesn't. This is the number that predicts real behaviour.
  warm  - the crowd's average rating for each candidate is available. Not
          achievable at a festival; included to show what it would be worth.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from festrec_eval import metrics as M
from festrec_eval.data import build_splits, load_movielens, sample_users
from festrec_eval.features import (
    RECOMMENDED_FACETS,
    THIN_FACETS,
    FeatureSpace,
    compute_item_stats,
)
from festrec_eval.models import (
    BiasModel,
    TwoRegime,
    ContentRidge,
    GlobalMean,
    ItemMean,
    Model,
    UserMean,
)

HEADLINE = ["ndcg@10", "spearman", "precision@5", "top5_lift", "rmse", "mae"]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--n-users", type=int, default=100)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--min-ratings", type=int, default=15,
                   help="profiles below this are excluded (spec: 15)")
    p.add_argument("--train-frac", type=float, default=0.7)
    p.add_argument("--split", choices=["random", "time"], default="random")
    p.add_argument("--mode", choices=["cold", "warm", "both"], default="both")
    p.add_argument("--metadata", default="data/film_metadata.json",
                   help="film metadata cache; used if present")
    p.add_argument("--thin-evidence", action="store_true",
                   help="score only held-out films where the person has rated "
                        "nobody involved - the situation at a festival full of "
                        "premieres by first-time directors")
    p.add_argument("--facets", default="",
                   help="comma-separated subset to use, e.g. 'genre,decade' - "
                        "for attributing a gain to the signal that caused it. "
                        "Defaults to the measured-best set; 'all' uses every "
                        "available signal")
    p.add_argument("--llm", action="store_true",
                   help="also score an LLM predictor (costs money, needs a key)")
    p.add_argument("--llm-model", default="claude-opus-5")
    p.add_argument("--llm-users", type=int, default=20,
                   help="LLM is run on this many of the sampled users")
    p.add_argument("--out", default="results")
    return p.parse_args()


def load_metadata(path: str) -> dict[int, dict] | None:
    file = Path(path)
    if not file.exists():
        return None
    raw = json.loads(file.read_text(encoding="utf-8"))
    return {int(k): v for k, v in raw.items()}


PEOPLE = ("director", "writer", "cast")


def thin_evidence_masks(dataset, metadata, splits) -> dict[int, np.ndarray]:
    """Per user, which held-out films involve nobody they have rated.

    This is the festival case: a world premiere by a first-time director,
    where neither the crowd signal nor the credits signal is available.

    The mask is built from a fixed people-aware space so that every feature
    set is judged on exactly the same films. Deriving it from the set under
    test would silently hand the people-free configurations the whole test
    set instead.
    """
    reference = FeatureSpace(dataset.films, metadata=metadata, include_facets=PEOPLE)
    masks = {}
    for split in splits:
        profile = reference.build_profile(split.user_id, split.train)
        movie_ids = split.test.movieId.astype(int).tolist()
        masks[split.user_id] = np.array(
            [
                sum(
                    reference._facet_affinity(profile, movie_id, facet, False)[1]
                    for facet in PEOPLE
                )
                == 0
                for movie_id in movie_ids
            ],
            dtype=bool,
        )
    return masks


def evaluate(
    model: Model,
    splits,
    profiles,
    limit_users: set[int] | None = None,
    masks: dict[int, np.ndarray] | None = None,
) -> list[dict]:
    """Score one model on every user's held-out films."""
    rows = []
    for split in splits:
        if limit_users is not None and split.user_id not in limit_users:
            continue
        movie_ids = split.test.movieId.astype(int).tolist()
        actual = split.test.rating.to_numpy(float)

        if masks is not None:
            mask = masks[split.user_id]
            # Correlation needs a few points to mean anything.
            if mask.sum() < 3:
                continue
            movie_ids = [m for m, keep in zip(movie_ids, mask) if keep]
            actual = actual[mask]
        predicted = np.asarray(
            model.predict(split, profiles[split.user_id], movie_ids), dtype=float
        )
        row = M.user_metrics(actual, predicted)
        row["user_id"] = split.user_id
        rows.append(row)
    return rows


def print_table(results: dict[str, list[dict]], title: str) -> None:
    print(f"\n{title}")
    print("-" * 86)
    print(f"{'model':<20}" + "".join(f"{k:>11}" for k in HEADLINE))
    for name, per_user in results.items():
        summary = M.aggregate(per_user)
        line = f"{name:<20}"
        for key in HEADLINE:
            value = summary[key]["mean"]
            # A flat predictor has no ranking to correlate; say so, don't print 0.
            line += f"{'-':>11}" if np.isnan(value) else f"{value:>11.3f}"
        print(line)
    print("-" * 86)


def print_deltas(results: dict[str, list[dict]], reference: str) -> None:
    """The question that matters: does it beat the person's own average?"""
    if reference not in results:
        return
    print(f"\nPaired difference vs {reference} (95% CI over users)")
    print("-" * 86)
    for name, per_user in results.items():
        if name == reference:
            continue
        parts = []
        # Spearman is left out: the reference predicts a flat line, so there
        # is nothing to correlate against and every difference would be NaN.
        for key in ("ndcg@10", "precision@5", "rmse"):
            d = M.paired_delta(per_user, results[reference], key)
            if not np.isfinite(d["lo"]):
                parts.append(
                    f"{key} {d['delta']:+.3f} (n={d['n_users']}, too few for "
                    f"an interval)"
                )
                continue
            better = "better" if (
                (d["lo"] > 0 and key != "rmse") or (d["hi"] < 0 and key == "rmse")
            ) else ("worse" if (
                (d["hi"] < 0 and key != "rmse") or (d["lo"] > 0 and key == "rmse")
            ) else "tie")
            parts.append(
                f"{key} {d['delta']:+.3f} [{d['lo']:+.3f},{d['hi']:+.3f}] {better}"
            )
        print(f"{name:<20} " + " | ".join(parts))
    print("-" * 86)


BUCKETS = ((15, 30), (31, 75), (76, 200), (201, 10**9))


def print_by_profile_size(
    results: dict[str, list[dict]], splits, model: str = "content_ridge"
) -> None:
    """Does it still work for someone with barely any ratings?"""
    if model not in results:
        return
    sizes = {s.user_id: len(s.train) + len(s.test) for s in splits}
    rows = {r["user_id"]: r for r in results[model]}
    reference = {r["user_id"]: r for r in results.get("user_mean", [])}

    print(f"\n{model} by profile size (total ratings, cold)")
    print("-" * 86)
    print(f"{'profile size':<16}{'users':>7}{'ndcg@10':>11}{'vs baseline':>13}"
          f"{'top5_lift':>11}")
    for low, high in BUCKETS:
        members = [u for u, n in sizes.items() if low <= n <= high and u in rows]
        if not members:
            continue
        ndcg = np.mean([rows[u]["ndcg@10"] for u in members])
        lift = np.mean([rows[u]["top5_lift"] for u in members])
        delta = (
            ndcg - np.mean([reference[u]["ndcg@10"] for u in members])
            if reference
            else float("nan")
        )
        label = f"{low}-{high}" if high < 10**9 else f"{low}+"
        print(f"{label:<16}{len(members):>7}{ndcg:>11.3f}{delta:>+13.3f}"
              f"{lift:>11.3f}")
    print("-" * 86)


def main() -> None:
    args = parse_args()
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    dataset = load_movielens(args.data)
    user_ids = sample_users(dataset, args.n_users, args.seed, args.min_ratings)
    splits = build_splits(
        dataset, user_ids, args.train_frac, args.seed, args.split
    )
    metadata = load_metadata(args.metadata)

    n_eligible = len(
        dataset.ratings.groupby("userId").size().loc[
            lambda s: s >= args.min_ratings
        ]
    )
    total = dataset.ratings.userId.nunique()
    print(f"{total} raters, {n_eligible} with >= {args.min_ratings} ratings, "
          f"sampled {len(user_ids)}")
    print(f"train/test per user: {args.train_frac:.0%}/{1 - args.train_frac:.0%} "
          f"({args.split} split), "
          f"{sum(len(s.test) for s in splits)} held-out ratings")
    metadata_note = (
        f"Wikidata metadata ({len(metadata)} films)"
        if metadata
        else "MovieLens only (genres + year) - run enrich_wikidata.py to add "
        "director, cast and keywords"
    )
    print(f"film metadata: {metadata_note}")

    # Crowd statistics come from raters outside the sample, so nothing the
    # models see is contaminated by the held-out ratings themselves.
    sampled = set(int(u) for u in user_ids)
    item_stats = compute_item_stats(dataset.ratings, exclude_users=sampled)
    global_mean = float(
        dataset.ratings[~dataset.ratings.userId.isin(sampled)].rating.mean()
    )

    requested = tuple(f.strip() for f in args.facets.split(",") if f.strip())
    if requested == ("all",):
        facets = None
    elif requested:
        facets = requested
    else:
        # Without film metadata there is nothing to choose between; genre and year are all
        # there is. With it, default to the set that measured best.
        facets = RECOMMENDED_FACETS if metadata else None
    spaces = {
        "cold": FeatureSpace(dataset.films, metadata=metadata, include_facets=facets)
    }
    if args.mode in ("warm", "both"):
        spaces["warm"] = FeatureSpace(
            dataset.films, metadata=metadata, item_stats=item_stats, include_facets=facets
        )
    print(f"features in play: {', '.join(spaces['cold'].feature_names)}")

    profiles = {
        name: {s.user_id: space.build_profile(s.user_id, s.train) for s in splits}
        for name, space in spaces.items()
    }

    masks = None
    if args.thin_evidence:
        masks = thin_evidence_masks(dataset, metadata, splits)
        kept = sum(int(m.sum()) for m in masks.values())
        total_test = sum(len(m) for m in masks.values())
        print(f"thin evidence only: {kept} of {total_test} held-out ratings "
              f"({kept / total_test:.0%}) involve nobody the person has rated")

    all_results: dict[str, dict[str, list[dict]]] = {}
    coefficients: dict[str, dict[str, float]] = {}

    for condition in ("cold", "warm"):
        if condition not in spaces:
            continue
        space = spaces[condition]
        models: list[Model] = [GlobalMean(), UserMean(), ContentRidge()]
        if metadata:
            models.append(
                TwoRegime(
                    dataset.films, metadata, RECOMMENDED_FACETS, THIN_FACETS, PEOPLE
                )
            )
        if condition == "warm":
            models += [
                ItemMean(item_stats, global_mean),
                BiasModel(item_stats, global_mean),
            ]

        results: dict[str, list[dict]] = {}
        for model in models:
            model.fit(splits, space, profiles[condition])
            results[model.name] = evaluate(
                model, splits, profiles[condition], masks=masks
            )
            if isinstance(model, ContentRidge):
                coefficients[condition] = model.coefficients()

        all_results[condition] = results
        label = (
            "COLD - no crowd ratings for candidates (festival-realistic)"
            if condition == "cold"
            else "WARM - crowd ratings available (not achievable at a festival)"
        )
        print_table(results, label)
        print_deltas(results, "user_mean")
        if condition == "cold":
            print_by_profile_size(results, splits)

    if args.llm:
        from festrec_eval.llm import LLMRecommender

        subset = set(int(u) for u in user_ids[: args.llm_users])
        llm = LLMRecommender(
            dataset.films, model=args.llm_model, cache_dir=out_dir / "llm_cache"
        )
        llm.fit(splits, spaces["cold"], profiles["cold"])
        llm_rows = evaluate(llm, splits, profiles["cold"], limit_users=subset)
        cold = all_results["cold"]
        comparison = {
            name: [r for r in rows if r["user_id"] in subset]
            for name, rows in cold.items()
        }
        comparison[f"llm:{args.llm_model}"] = llm_rows
        print_table(comparison, f"LLM comparison on {len(subset)} users (cold)")
        print_deltas(comparison, "user_mean")
        print(f"\nLLM spend: ${llm.cost_usd:.2f} "
              f"({llm.calls} calls, {llm.input_tokens:,} in / "
              f"{llm.output_tokens:,} out)")
        all_results["llm"] = comparison

    summary = {
        condition: {name: M.aggregate(rows) for name, rows in results.items()}
        for condition, results in all_results.items()
    }
    (out_dir / "summary.json").write_text(
        json.dumps(
            {
                "config": vars(args),
                "n_users": len(user_ids),
                "summary": summary,
                "ridge_coefficients": coefficients,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    rows = [
        {"condition": condition, "model": name, **row}
        for condition, results in all_results.items()
        for name, per_user in results.items()
        for row in per_user
    ]
    pd.DataFrame(rows).to_csv(out_dir / "per_user.csv", index=False)
    print(f"\nWrote {out_dir / 'summary.json'} and {out_dir / 'per_user.csv'}")


if __name__ == "__main__":
    main()

