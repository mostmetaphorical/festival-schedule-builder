"""A standard rec-sys diagnostic of the shipped recommender.

run_eval.py answers this project's own question (does it rank a person's
held-out films better than their own average?). This answers the textbook
ones, on the same MovieLens data, with the shipped configuration:

  1. 80/20 per-user split (and optional 5-fold cross-validation)
  2. RMSE and MAE; Precision@10 and Recall@10 (relevant = rated >= 4.0)
  3. leakage probes, cold-start users, cold-start films, train/serve skew
  4. inference latency for a top-10

    python diagnose.py                 # 80/20, everything
    python diagnose.py --folds 5       # 5-fold cross-validation for the accuracy table

Writes results/diagnose/report.json, plus js_input.json for diagnose_js.mjs,
which checks the browser implementation against this one.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from festrec_eval.data import UserSplit, eligible_users, load_movielens
from festrec_eval.features import (
    PEOPLE_FACETS,
    RECOMMENDED_FACETS,
    FeatureSpace,
    compute_item_stats,
    people_support,
)
from festrec_eval.models import BiasModel, ContentRidge, GlobalMean, UserMean

RELEVANT = 4.0
K = 10
SHIPPED_SHRINKAGE = 0.5


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--metadata", default="data/film_metadata.json")
    p.add_argument("--folds", type=int, default=0, help="0 = single 80/20 split")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--catalogue-users", type=int, default=30)
    p.add_argument("--coldstart-users", type=int, default=60)
    p.add_argument("--out", default="results/diagnose")
    return p.parse_args()


def log(message: str) -> None:
    print(message, flush=True)


# ---------------------------------------------------------------- splitting

def fold_splits(dataset, users, n_folds: int, seed: int) -> list[list[UserSplit]]:
    """Per-user k-fold: every rating is tested exactly once.

    n_folds=0 gives one 80/20 split. Splitting within each user (rather than
    holding out whole users) matches the app: a person's profile is known, and
    what is predicted is films they haven't rated.
    """
    folds = max(n_folds, 1)
    out: list[list[UserSplit]] = [[] for _ in range(folds)]
    for user in users:
        history = dataset.user_ratings(user)[["movieId", "rating"]].reset_index(drop=True)
        rng = np.random.default_rng((seed, int(user)))
        order = rng.permutation(len(history))
        if n_folds <= 1:
            cut = int(round(len(history) * 0.8))
            parts = [order[cut:]]
        else:
            parts = np.array_split(order, folds)
        for index, test_rows in enumerate(parts):
            mask = np.zeros(len(history), dtype=bool)
            mask[test_rows] = True
            out[index].append(UserSplit(
                user_id=int(user),
                train=history[~mask].reset_index(drop=True),
                test=history[mask].reset_index(drop=True),
            ))
    return out


# ---------------------------------------------------------------- metrics

def rank(predicted: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Order by prediction; ties broken at random so a flat predictor ranks randomly."""
    jitter = rng.random(len(predicted)) * 1e-9
    return np.argsort(-(predicted + jitter))


def ranking_metrics(actual, predicted, rng) -> dict[str, float]:
    order = rank(predicted, rng)
    relevant = actual >= RELEVANT
    top = order[:K]
    hits = int(relevant[top].sum())
    n_rel = int(relevant.sum())
    discount = 1.0 / np.log2(np.arange(2, min(K, len(actual)) + 2))
    gains = actual[top][: len(discount)]
    ideal = np.sort(actual)[::-1][: len(discount)]
    return {
        # Precision over the slots actually available: a user with 6 test films
        # can't fill 10. Both conventions are reported.
        "precision@10": hits / min(K, len(actual)),
        "precision@10_strict": hits / K,
        "recall@10": hits / n_rel if n_rel else np.nan,
        "ndcg@10": float((gains * discount).sum() / (ideal * discount).sum()) if ideal.sum() else np.nan,
        "has_relevant": bool(n_rel),
    }


def evaluate(model, splits, profiles, seed=0, only=None) -> dict:
    rng = np.random.default_rng(seed)
    errors, per_user = [], []
    for split in splits:
        ids = split.test.movieId.astype(int).tolist()
        actual = split.test.rating.to_numpy(float)
        if only is not None:
            keep = only[split.user_id]
            if keep.sum() == 0:
                continue
            ids = [m for m, k in zip(ids, keep) if k]
            actual = actual[keep]
        predicted = np.asarray(model.predict(split, profiles[split.user_id], ids), float)
        errors.append(predicted - actual)
        row = ranking_metrics(actual, predicted, rng)
        row["rmse"] = float(np.sqrt(np.mean((predicted - actual) ** 2)))
        row["mae"] = float(np.mean(np.abs(predicted - actual)))
        per_user.append(row)
    pooled = np.concatenate(errors) if errors else np.array([np.nan])
    frame = pd.DataFrame(per_user)
    ranked = frame[frame.has_relevant] if len(frame) else frame
    return {
        "n_users": int(len(frame)),
        "n_ratings": int(len(pooled)),
        "rmse": float(np.sqrt(np.mean(pooled ** 2))),
        "mae": float(np.mean(np.abs(pooled))),
        "rmse_per_user": float(frame.rmse.mean()) if len(frame) else np.nan,
        "precision@10": float(ranked["precision@10"].mean()) if len(ranked) else np.nan,
        "precision@10_strict": float(ranked["precision@10_strict"].mean()) if len(ranked) else np.nan,
        "recall@10": float(ranked["recall@10"].mean()) if len(ranked) else np.nan,
        "ndcg@10": float(frame["ndcg@10"].mean()) if len(frame) else np.nan,
    }


class Popularity(GlobalMean):
    """Rank by how many train ratings a film has; predict the person's mean."""

    name = "popularity"

    def __init__(self, counts: pd.Series):
        self.counts = counts

    def predict(self, split, profile, movie_ids):
        count = self.counts.reindex(movie_ids).fillna(0).to_numpy(float)
        # A tiny nudge by popularity: RMSE equals user_mean's, ranking differs.
        return profile.mean + 1e-6 * np.log1p(count)


def fit_all(dataset, metadata, splits):
    space = FeatureSpace(dataset.films, metadata=metadata, include_facets=RECOMMENDED_FACETS)
    t = time.perf_counter()
    profiles = {s.user_id: space.build_profile(s.user_id, s.train) for s in splits}
    profile_s = time.perf_counter() - t

    train_ratings = pd.concat([s.train.assign(userId=s.user_id) for s in splits])
    stats = compute_item_stats(train_ratings)
    global_mean = float(train_ratings.rating.mean())

    models = {
        "global_mean": GlobalMean(),
        "user_mean": UserMean(),
        "popularity": Popularity(train_ratings.groupby("movieId").size()),
        "bias (crowd, not usable at a festival)": BiasModel(stats, global_mean),
        "content_ridge (shipped, shrink 0.5)": ContentRidge(evidence_shrinkage=SHIPPED_SHRINKAGE),
        "content_ridge (no shrink)": ContentRidge(),
    }
    timings = {"profiles_s": profile_s}
    for name, model in models.items():
        t = time.perf_counter()
        model.fit(splits, space, profiles)
        timings[f"fit {name}_s"] = time.perf_counter() - t
    # The two ridges share their fit; copy rather than solve twice if identical.
    return space, profiles, models, timings


# ---------------------------------------------------------------- main

def main() -> None:
    args = parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report: dict = {"config": vars(args)}

    t0 = time.perf_counter()
    dataset = load_movielens(args.data)
    metadata = {int(k): v for k, v in json.loads(Path(args.metadata).read_text(encoding="utf-8")).items()}
    users = eligible_users(dataset, 15)
    log(f"loaded {len(dataset.ratings)} ratings, {dataset.ratings.userId.nunique()} users "
        f"({len(users)} with >=15), {len(dataset.films)} films, metadata for {len(metadata)} "
        f"in {time.perf_counter() - t0:.1f}s")
    report["dataset"] = {
        "ratings": int(len(dataset.ratings)), "users": int(dataset.ratings.userId.nunique()),
        "eligible_users": int(len(users)), "films": int(len(dataset.films)),
        "films_with_metadata": int(len(metadata)),
        "films_with_synopsis": int(sum(1 for m in metadata.values() if m.get("overview"))),
        "rating_mean": float(dataset.ratings.rating.mean()),
        "share_relevant": float((dataset.ratings.rating >= RELEVANT).mean()),
    }

    # ------------------------------------------------ 1-2. split, fit, evaluate
    fold_sets = fold_splits(dataset, users, args.folds, args.seed)
    accuracy: dict[str, list[dict]] = {}
    first = None
    for index, splits in enumerate(fold_sets):
        n_train = sum(len(s.train) for s in splits)
        n_test = sum(len(s.test) for s in splits)
        log(f"\nfold {index + 1}/{len(fold_sets)}: {n_train} train / {n_test} test ratings "
            f"({n_train / (n_train + n_test):.1%} train)")

        # Leakage: no (user, film) pair on both sides.
        overlap = sum(len(set(s.train.movieId) & set(s.test.movieId)) for s in splits)
        assert overlap == 0, f"{overlap} user-film pairs in both train and test"

        t = time.perf_counter()
        space, profiles, models, timings = fit_all(dataset, metadata, splits)
        log(f"  fitted in {time.perf_counter() - t:.1f}s  "
            + ", ".join(f"{k} {v:.1f}" for k, v in timings.items()))
        for name, model in models.items():
            t = time.perf_counter()
            result = evaluate(model, splits, profiles, seed=args.seed)
            result["eval_s"] = time.perf_counter() - t
            accuracy.setdefault(name, []).append(result)
            log(f"  {name:<40} RMSE {result['rmse']:.4f}  MAE {result['mae']:.4f}  "
                f"P@10 {result['precision@10']:.4f}  R@10 {result['recall@10']:.4f}  "
                f"nDCG@10 {result['ndcg@10']:.4f}")
        if first is None:
            first = (splits, space, profiles, models)

    report["accuracy"] = {
        name: {
            key: {"mean": float(np.mean([r[key] for r in rows])),
                  "std": float(np.std([r[key] for r in rows]))}
            for key in rows[0]
        }
        for name, rows in accuracy.items()
    }
    splits, space, profiles, models = first
    ridge = models["content_ridge (shipped, shrink 0.5)"]
    report["ridge"] = {"alpha": ridge.alpha_, "coefficients": ridge.coefficients()}

    # ------------------------------------------------ 3a. leakage probes
    log("\nleakage probes")
    probe: dict = {}
    # (i) Scrambling every test rating must not change a single prediction.
    rng = np.random.default_rng(1)
    sample = splits[:80]
    before = [ridge.predict(s, profiles[s.user_id], s.test.movieId.astype(int).tolist()) for s in sample]
    scrambled = [UserSplit(s.user_id, s.train, s.test.assign(rating=rng.uniform(0.5, 5, len(s.test))))
                 for s in sample]
    after = [ridge.predict(s, profiles[s.user_id], s.test.movieId.astype(int).tolist()) for s in scrambled]
    probe["predictions_ignore_test_ratings"] = bool(all(np.allclose(a, b) for a, b in zip(before, after)))
    # (ii) Refit with scrambled test ratings: weights must be identical.
    small_profiles = {s.user_id: profiles[s.user_id] for s in sample}
    a = ContentRidge(evidence_shrinkage=SHIPPED_SHRINKAGE); a.fit(sample, space, small_profiles)
    b = ContentRidge(evidence_shrinkage=SHIPPED_SHRINKAGE); b.fit(scrambled, space, small_profiles)
    probe["fit_ignores_test_ratings"] = bool(np.allclose(a.weights, b.weights) and a.alpha_ == b.alpha_)
    # (iii) Profiles are built from train only: a test film is never in the profile.
    probe["test_films_absent_from_profiles"] = bool(all(
        not (set(s.test.movieId.astype(int)) & set(profiles[s.user_id].centered)) for s in splits))
    # (iv) Features for a film don't use its own rating (leave-one-out in training).
    s0 = splits[0]
    ids = s0.train.movieId.astype(int).tolist()[:25]
    loo = space.transform(profiles[s0.user_id], ids, leave_out=True)
    raw = space.transform(profiles[s0.user_id], ids, leave_out=False)
    probe["leave_one_out_active"] = bool(not np.allclose(loo, raw))
    # (v) Shuffled-label test: with taste destroyed, the model must not beat user_mean.
    shuffled = [UserSplit(s.user_id, s.train.assign(rating=rng.permutation(s.train.rating.to_numpy())), s.test)
                for s in splits[:150]]
    sh_profiles = {s.user_id: space.build_profile(s.user_id, s.train) for s in shuffled}
    noise = ContentRidge(evidence_shrinkage=SHIPPED_SHRINKAGE); noise.fit(shuffled, space, sh_profiles)
    probe["shuffled_labels"] = {
        "ridge_ndcg": evaluate(noise, shuffled, sh_profiles)["ndcg@10"],
        "user_mean_ndcg": evaluate(UserMean(), shuffled, sh_profiles)["ndcg@10"],
    }
    # (vi) Temporal: random splits let the profile include films watched after
    # the test ones. Compare with training on each person's earliest 80%.
    time_splits = []
    for user in users[:200]:
        h = dataset.user_ratings(user).sort_values("timestamp")[["movieId", "rating"]].reset_index(drop=True)
        cut = int(round(len(h) * 0.8))
        time_splits.append(UserSplit(int(user), h.iloc[:cut].reset_index(drop=True), h.iloc[cut:].reset_index(drop=True)))
    t_profiles = {s.user_id: space.build_profile(s.user_id, s.train) for s in time_splits}
    t_ridge = ContentRidge(evidence_shrinkage=SHIPPED_SHRINKAGE); t_ridge.fit(time_splits, space, t_profiles)
    random_200 = [s for s in splits if s.user_id in set(int(u) for u in users[:200])]
    r_profiles = {s.user_id: profiles[s.user_id] for s in random_200}
    r_ridge = ContentRidge(evidence_shrinkage=SHIPPED_SHRINKAGE); r_ridge.fit(random_200, space, r_profiles)
    probe["temporal"] = {
        "random_split": {"ridge": evaluate(r_ridge, random_200, r_profiles),
                         "user_mean": evaluate(UserMean(), random_200, r_profiles)},
        "time_split": {"ridge": evaluate(t_ridge, time_splits, t_profiles),
                       "user_mean": evaluate(UserMean(), time_splits, t_profiles)},
    }
    report["leakage"] = probe
    log(json.dumps({k: v for k, v in probe.items() if k != "temporal"}, indent=1, default=float))

    # ------------------------------------------------ 3b. cold-start users
    log("\ncold-start users")
    rich = [s for s in splits if len(s.train) >= 80]
    rich = [rich[i] for i in np.random.default_rng(2).choice(len(rich), min(args.coldstart_users, len(rich)), replace=False)]
    cold_rows = []
    for k in (1, 3, 5, 10, 20, 50, "all"):
        truncated = []
        for s in rich:
            train = s.train if k == "all" else s.train.sample(n=k, random_state=int(s.user_id))
            truncated.append(UserSplit(s.user_id, train.reset_index(drop=True), s.test))
        k_profiles = {s.user_id: space.build_profile(s.user_id, s.train) for s in truncated}
        row = {"train_ratings": k}
        for name in ("global_mean", "user_mean", "content_ridge (shipped, shrink 0.5)"):
            row[name] = evaluate(models[name], truncated, k_profiles)
        cold_rows.append(row)
        log(f"  k={k!s:>3}  ridge RMSE {row['content_ridge (shipped, shrink 0.5)']['rmse']:.3f} "
            f"vs user_mean {row['user_mean']['rmse']:.3f} vs global {row['global_mean']['rmse']:.3f}  "
            f"ridge P@10 {row['content_ridge (shipped, shrink 0.5)']['precision@10']:.3f} "
            f"vs user_mean {row['user_mean']['precision@10']:.3f}")
    # Zero ratings: what does the Python model do?
    try:
        empty = space.build_profile(0, rich[0].train.iloc[:0])
        zero = models["content_ridge (shipped, shrink 0.5)"].predict(rich[0], empty, rich[0].test.movieId.astype(int).tolist()[:5])
        zero_result = {"predictions": [float(x) for x in zero], "mean": float(empty.mean)}
    except Exception as error:  # noqa: BLE001 - reporting the failure is the point
        zero_result = {"error": f"{type(error).__name__}: {error}"}
    report["cold_start_users"] = {"rows": cold_rows, "zero_ratings_python": zero_result}
    log(f"  k=0 (python): {zero_result}")

    # ------------------------------------------------ 3c. cold-start films
    log("\ncold-start films (nobody involved has been rated - the festival case)")
    people_space = FeatureSpace(dataset.films, metadata=metadata, include_facets=PEOPLE_FACETS)
    masks = {}
    for s in splits:
        prof = people_space.build_profile(s.user_id, s.train)
        masks[s.user_id] = np.array(
            [people_support(people_space, prof, int(m)) == 0 for m in s.test.movieId], dtype=bool)
    thin_share = float(np.mean(np.concatenate(list(masks.values()))))
    no_meta = {s.user_id: np.array([int(m) not in metadata for m in s.test.movieId], dtype=bool) for s in splits}
    no_text = {s.user_id: np.array([not (metadata.get(int(m)) or {}).get("overview") for m in s.test.movieId], dtype=bool)
               for s in splits}
    # No shared people *and* no shared keywords: every support column is zero,
    # so the shipped evidence shrinkage multiplies the prediction's deviation
    # by zero - synopsis similarity included. This is most of a festival slate.
    no_evidence = {}
    for s in splits:
        rows = space.transform(profiles[s.user_id], s.test.movieId.astype(int).tolist())
        no_evidence[s.user_id] = ridge._evidence(rows) == 0
    no_shrink = models["content_ridge (no shrink)"]
    report["cold_start_films"] = {
        "share_of_test_with_no_evidence": float(np.mean(np.concatenate(list(no_evidence.values())))),
        "no_evidence": {
            "user_mean": evaluate(models["user_mean"], splits, profiles, only=no_evidence),
            "content_ridge (shipped, shrink 0.5)": evaluate(ridge, splits, profiles, only=no_evidence),
            "content_ridge (no shrink)": evaluate(no_shrink, splits, profiles, only=no_evidence),
        },
        "share_of_test_with_no_shared_people": thin_share,
        "no_shared_people": {n: evaluate(models[n], splits, profiles, only=masks)
                              for n in ("user_mean", "content_ridge (shipped, shrink 0.5)")},
        "no_metadata_at_all": {n: evaluate(models[n], splits, profiles, only=no_meta)
                               for n in ("user_mean", "content_ridge (shipped, shrink 0.5)")},
        "no_synopsis": {n: evaluate(models[n], splits, profiles, only=no_text)
                        for n in ("user_mean", "content_ridge (shipped, shrink 0.5)")},
    }
    log(f"  {thin_share:.0%} of test ratings share no people with the profile; "
        f"{report['cold_start_films']['share_of_test_with_no_evidence']:.1%} share no people or keywords")
    for name, r in report["cold_start_films"]["no_evidence"].items():
        spread = "flat by construction" if "shrink 0.5" in name else ""
        log(f"  no evidence: {name:<38} RMSE {r['rmse']:.4f} nDCG@10 {r['ndcg@10']:.4f} "
            f"(n={r['n_ratings']}) {spread}")
    for label in ("no_shared_people", "no_metadata_at_all", "no_synopsis"):
        r = report["cold_start_films"][label]
        log(f"  {label:<20} ridge nDCG {r['content_ridge (shipped, shrink 0.5)']['ndcg@10']:.3f} "
            f"vs user_mean {r['user_mean']['ndcg@10']:.3f} (n={r['user_mean']['n_ratings']})")

    # ------------------------------------------------ 3d. train/serve skew: synopses
    log("\ntrain/serve skew: the app's library has no synopses for rated films")
    skew_space = FeatureSpace(dataset.films, metadata=metadata, include_facets=RECOMMENDED_FACETS)
    # Serve-time profiles: rated films contribute no text, so the text profile is empty.
    blank = {mid: {**meta, "overview": ""} for mid, meta in metadata.items()}
    served = FeatureSpace(dataset.films, metadata=blank, include_facets=RECOMMENDED_FACETS)
    served.text = skew_space.text  # candidates still have synopses (festival films do)
    served_profiles = {}
    for s in splits:
        p = served.build_profile(s.user_id, s.train)
        p.text_profile = skew_space.text.profile({})
        served_profiles[s.user_id] = p
    report["train_serve_skew"] = {
        "as_evaluated": evaluate(ridge, splits, profiles),
        "as_served_no_rated_synopses": evaluate(ridge, splits, served_profiles),
    }
    for label, r in report["train_serve_skew"].items():
        log(f"  {label:<30} RMSE {r['rmse']:.4f} P@10 {r['precision@10']:.4f} nDCG {r['ndcg@10']:.4f}")

    # ------------------------------------------------ 2b. catalogue top-10
    log("\ncatalogue top-10 (rank every unrated film with metadata; relevant = test films rated >= 4)")
    pick = np.random.default_rng(3).choice(len(splits), min(args.catalogue_users, len(splits)), replace=False)
    catalogue = [int(m) for m in dataset.films.index if int(m) in metadata]
    counts = pd.concat([s.train for s in splits]).groupby("movieId").size()
    cat_rows = {"content_ridge (shipped, shrink 0.5)": [], "popularity": [], "random": []}
    latencies = []
    rng = np.random.default_rng(4)
    for i in pick:
        s = splits[i]
        seen = set(s.train.movieId.astype(int))
        candidates = [m for m in catalogue if m not in seen]
        relevant = set(s.test[s.test.rating >= RELEVANT].movieId.astype(int))
        if not relevant:
            continue
        t = time.perf_counter()
        profile = space.build_profile(s.user_id, s.train)
        scores = ridge.predict(s, profile, candidates)
        top = [candidates[j] for j in np.argsort(-scores)[:K]]
        latencies.append((time.perf_counter() - t) * 1000)
        pop_top = [m for m, _ in sorted(((m, counts.get(m, 0)) for m in candidates), key=lambda x: -x[1])[:K]]
        rand_top = list(rng.choice(candidates, K, replace=False))
        for name, chosen in (("content_ridge (shipped, shrink 0.5)", top), ("popularity", pop_top), ("random", rand_top)):
            hits = len(set(chosen) & relevant)
            cat_rows[name].append({"precision@10": hits / K, "recall@10": hits / len(relevant)})
    report["catalogue_top10"] = {
        name: {k: float(np.mean([r[k] for r in rows])) for k in ("precision@10", "recall@10")} | {"n_users": len(rows)}
        for name, rows in cat_rows.items()
    }
    report["catalogue_top10"]["n_candidates"] = len(catalogue)
    for name, r in report["catalogue_top10"].items():
        if isinstance(r, dict):
            log(f"  {name:<40} P@10 {r['precision@10']:.4f}  R@10 {r['recall@10']:.4f}  (n={r['n_users']})")

    # ------------------------------------------------ 4. latency (python)
    report["latency_python_ms"] = {
        "catalogue_top10_per_user": {"n": len(latencies), "median": float(np.median(latencies)),
                                     "p90": float(np.percentile(latencies, 90)), "candidates": len(catalogue)},
    }
    slate = catalogue[:106]
    small = []
    for _ in range(20):
        t = time.perf_counter()
        prof = space.build_profile(splits[0].user_id, splits[0].train)
        sc = ridge.predict(splits[0], prof, slate)
        np.argsort(-sc)[:K]
        small.append((time.perf_counter() - t) * 1000)
    report["latency_python_ms"]["slate_106_top10"] = {"median": float(np.median(small)), "p90": float(np.percentile(small, 90))}
    log(f"\npython latency: catalogue top-10 median {np.median(latencies):.0f} ms over {len(catalogue)} films; "
        f"106-film slate median {np.median(small):.1f} ms")

    # ------------------------------------------------ parity input for the JS check
    user = splits[0]
    def film_record(mid, rating=None):
        meta = metadata.get(mid) or {}
        year = dataset.films.loc[mid].year
        record = {
            "movieId": mid,
            "year": None if pd.isna(year) else int(year),
            "entities": {f: list(meta.get(f) or []) for f in ("director", "writer", "cast", "keyword")},
            "synopsis": meta.get("overview") or "",
        }
        if rating is not None:
            record["rating"] = float(rating)
        return record
    shipped = json.loads(Path("app/data/model.json").read_text(encoding="utf-8"))
    parity_model = ContentRidge(evidence_shrinkage=shipped["evidence_shrinkage"])
    parity_model.space = space
    parity_model.center = np.array(shipped["center"]); parity_model.scale = np.array(shipped["scale"])
    parity_model.weights = np.array(shipped["weights"]); parity_model.alpha_ = shipped["alpha"]
    assert space.feature_names == shipped["features"], (space.feature_names, shipped["features"])
    full = dataset.user_ratings(user.user_id)
    rated = [film_record(int(r.movieId), r.rating) for r in full.itertuples()]
    full_profile = space.build_profile(user.user_id, full[["movieId", "rating"]])
    candidates = [m for m in catalogue if m not in set(full.movieId.astype(int))][:400]
    py_predictions = parity_model.predict(user, full_profile, candidates)
    (out / "js_input.json").write_text(json.dumps({
        "rated": rated,
        "candidates": [film_record(m) for m in candidates],
        "python_predictions": [float(x) for x in py_predictions],
    }), encoding="utf-8")

    (out / "report.json").write_text(json.dumps(report, indent=2, default=float), encoding="utf-8")
    log(f"\nwrote {out / 'report.json'} and {out / 'js_input.json'} in {time.perf_counter() - t0:.0f}s")


if __name__ == "__main__":
    main()
