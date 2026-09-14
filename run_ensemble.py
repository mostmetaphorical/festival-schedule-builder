"""Cross-validated ensemble of recommender families, Kaggle-style.

Components (each tuned on an inner split of the first outer fold):

  user_bias     the person's shrunk average
  biases        mu + user + film bias
  mf            biased matrix factorisation (ALS)
  item_knn      baseline + similar films the person rated
  user_knn      baseline + similar people who rated the film
  content_mf    MF whose film side is predicted from content when unrated
  content_ridge the shipped taste-overlap ridge regression

Blends are stacked on probe predictions (an inner hold-out of each outer
training fold): linear, linear with meta-feature interactions, and gradient
boosting.

Two protocols:

  warm  per-user 5-fold: held-out ratings are on films others have rated.
        The standard benchmark; CF is at its strongest here.
  cold  film-level 5-fold: every rating of a held-out film is hidden, like a
        festival premiere. This is the protocol that decides what can ship.

    python run_ensemble.py --protocol both --folds 5
"""

from __future__ import annotations

import argparse
import itertools
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from diagnose import ranking_metrics
from export_model import PRIOR_WEIGHT
from festrec_eval.cf import (
    BiasedMF,
    Biases,
    ContentKNN,
    ContentToFactors,
    ItemKNN,
    Ratings,
    UserBias,
    UserKNN,
    content_matrix,
)
from festrec_eval.data import UserSplit, eligible_users, load_movielens
from festrec_eval.features import RECOMMENDED_FACETS, THIN_FACETS, FeatureSpace
from festrec_eval.models import ContentRidge

RMIN, RMAX = 0.5, 5.0


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--metadata", default="data/film_metadata.json")
    p.add_argument("--protocol", choices=["warm", "cold", "both"], default="both")
    p.add_argument("--folds", type=int, default=5)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--probe", type=float, default=0.1, help="inner hold-out share for tuning")
    p.add_argument("--stack-folds", type=int, default=3,
                   help="out-of-fold predictions over each outer training fold, for the blend")
    p.add_argument("--quick", action="store_true", help="small grids, for a smoke test")
    p.add_argument("--out", default="results/ensemble")
    return p.parse_args()


# ---------------------------------------------------------------- data plumbing

class World:
    """Everything fixed across folds: ids, content, the feature space."""

    def __init__(self, args):
        self.dataset = load_movielens(args.data)
        self.metadata = {int(k): v for k, v in json.loads(Path(args.metadata).read_text(encoding="utf-8")).items()}
        users = eligible_users(self.dataset, 15)
        ratings = self.dataset.ratings[self.dataset.ratings.userId.isin(users)]
        self.user_ids = np.sort(ratings.userId.unique())
        self.item_ids = np.sort(self.dataset.films.index.to_numpy())
        self.uix = {int(u): n for n, u in enumerate(self.user_ids)}
        self.iix = {int(m): n for n, m in enumerate(self.item_ids)}
        self.ratings = pd.DataFrame({
            "u": ratings.userId.map(self.uix).to_numpy(),
            "i": ratings.movieId.map(self.iix).to_numpy(),
            "r": ratings.rating.to_numpy(float),
        })
        self.space = FeatureSpace(self.dataset.films, metadata=self.metadata, include_facets=RECOMMENDED_FACETS)
        # Genre, decade, year, keywords and synopsis, with Wikidata's genres as the app has them.
        self.genre_space = FeatureSpace(self.dataset.films, metadata=self.metadata, include_facets=THIN_FACETS,
                                        genre_from_metadata=True)
        t = time.perf_counter()
        self.content = content_matrix([int(m) for m in self.item_ids], self.metadata, self.space.text)
        log(f"content matrix {self.content.shape} nnz {self.content.nnz} in {time.perf_counter() - t:.1f}s")

    def to_ratings(self, frame: pd.DataFrame) -> Ratings:
        return Ratings(frame.u.to_numpy(), frame.i.to_numpy(), frame.r.to_numpy(),
                       len(self.user_ids), len(self.item_ids))


class _Subset:
    """Just enough of a World to split a subset of ratings into nested folds."""

    def __init__(self, frame: pd.DataFrame):
        self.ratings = frame.reset_index(drop=True)


def warm_folds(world: World, k: int, seed: int):
    """Per-user k-fold over ratings."""
    fold = np.empty(len(world.ratings), dtype=int)
    for u, rows in world.ratings.groupby("u").indices.items():
        rng = np.random.default_rng((seed, int(u)))
        order = rng.permutation(len(rows))
        fold[rows[order]] = np.arange(len(rows)) % k
    return [(world.ratings[fold != f], world.ratings[fold == f]) for f in range(k)]


def cold_folds(world: World, k: int, seed: int):
    """Film-level k-fold: a held-out film has none of its ratings in training."""
    items = np.sort(world.ratings.i.unique())
    rng = np.random.default_rng(seed)
    assignment = dict(zip(items, rng.permutation(len(items)) % k))
    fold = world.ratings.i.map(assignment).to_numpy()
    return [(world.ratings[fold != f], world.ratings[fold == f]) for f in range(k)]


def inner_split(world: World, train: pd.DataFrame, protocol: str, share: float, seed: int):
    if protocol == "warm":
        probe = np.zeros(len(train), dtype=bool)
        for u, rows in train.groupby("u").indices.items():
            rng = np.random.default_rng((seed + 1, int(u)))
            n = max(1, int(round(len(rows) * share))) if len(rows) >= 5 else 0
            probe[rows[rng.permutation(len(rows))[:n]]] = True
    else:
        items = np.sort(train.i.unique())
        rng = np.random.default_rng(seed + 1)
        held = set(rng.choice(items, int(len(items) * share), replace=False).tolist())
        probe = train.i.isin(held).to_numpy()
    return train[~probe], train[probe]


# ---------------------------------------------------------------- the content ridge as a component

class RidgeComponent:
    name = "content_ridge"

    def __init__(self, world: World, prior_weight: float = PRIOR_WEIGHT, genre: bool = False):
        self.world = world
        self.prior_weight = prior_weight
        self.space = world.genre_space if genre else world.space

    def fit(self, frame: pd.DataFrame) -> "RidgeComponent":
        w = self.world
        splits, self.profiles = [], {}
        for u, rows in frame.groupby("u"):
            train = pd.DataFrame({"movieId": w.item_ids[rows.i.to_numpy()], "rating": rows.r.to_numpy()})
            split = UserSplit(int(u), train, train.iloc[:0])
            splits.append(split)
            self.profiles[int(u)] = self.space.build_profile(int(u), train)
        self.model = ContentRidge(prior_weight=self.prior_weight)
        self.model.fit(splits, self.space, self.profiles)
        self.splits = {s.user_id: s for s in splits}
        self.global_mean = float(frame.r.mean())
        return self

    def predict(self, u, i):
        out = np.full(len(u), self.global_mean)
        frame = pd.DataFrame({"u": u, "i": i, "pos": np.arange(len(u))})
        for user, rows in frame.groupby("u"):
            if int(user) not in self.profiles:
                continue
            ids = [int(m) for m in self.world.item_ids[rows.i.to_numpy()]]
            out[rows.pos.to_numpy()] = self.model.predict(self.splits[int(user)], self.profiles[int(user)], ids)
        return out


# ---------------------------------------------------------------- tuning

def grids(quick: bool):
    if quick:
        return {
            "biases": [dict(reg_user=u, reg_item=i) for u, i in itertools.product((5,), (10, 25))],
            "mf": [dict(factors=f, reg=r) for f, r in itertools.product((10, 25), (0.1, 0.2))],
            "item_knn": [dict(k=30, shrink=50, damping=d) for d in (0.0, 1.0)],
            "user_knn": [dict(k=40, shrink=50, damping=d) for d in (0.0, 1.0)],
            "content_knn": [dict(k=50, damping=0.5)],
            "content_mf": [dict(factors=10, kernel_reg=1.0, min_item_ratings=5)],
        }
    return {
        "biases": [dict(reg_user=u, reg_item=i) for u, i in itertools.product((2, 5, 10, 20), (5, 10, 25, 50))],
        "mf": [dict(factors=f, reg=r) for f, r in itertools.product((10, 25, 50, 100), (0.05, 0.1, 0.2, 0.4, 0.8))],
        "item_knn": [dict(k=k, shrink=sh, damping=d)
                     for k, sh, d in itertools.product((20, 50, 100), (25, 100), (0.0, 1.0, 3.0))],
        "user_knn": [dict(k=k, shrink=sh, damping=d)
                     for k, sh, d in itertools.product((20, 50, 100), (10, 50), (0.0, 1.0, 3.0))],
        "content_knn": [dict(k=k, damping=d, power=pw)
                        for k, d, pw in itertools.product((20, 50, 150), (0.1, 0.5, 2.0), (1.0, 2.0))],
        "content_mf": [dict(factors=f, kernel_reg=r, min_item_ratings=m)
                       for f, r, m in itertools.product((10, 25), (0.1, 0.3, 1.0, 3.0), (3, 10))],
    }


def build(world: World, name: str, params: dict, tuned: dict):
    bias = (tuned.get("biases", {}).get("reg_user", 5.0), tuned.get("biases", {}).get("reg_item", 10.0))
    if name == "user_bias":
        return UserBias(reg_user=bias[0], reg_item=bias[1])
    if name == "biases":
        return Biases(**params)
    if name == "mf":
        return BiasedMF(bias_reg=bias, **params)
    if name == "item_knn":
        return ItemKNN(bias_reg=bias, **params)
    if name == "user_knn":
        return UserKNN(bias_reg=bias, **params)
    if name == "content_knn":
        return ContentKNN(world.content, bias_reg=bias, **params)
    if name == "content_mf":
        mf = tuned.get("mf", {"factors": 25, "reg": 0.1})
        return ContentToFactors(world.content, reg=mf["reg"], **params)
    if name == "content_ridge":
        return RidgeComponent(world)
    if name == "genre_ridge":
        return RidgeComponent(world, genre=True)
    raise ValueError(name)


def fit_predict(world, model, train, test):
    fitted = model.fit(train) if isinstance(model, RidgeComponent) else model.fit(world.to_ratings(train))
    return np.clip(fitted.predict(test.u.to_numpy(), test.i.to_numpy()), RMIN, RMAX)


def rmse(p, r):
    return float(np.sqrt(np.mean((p - r) ** 2)))


def tune(world, train, probe, quick) -> tuple[dict, dict]:
    tuned, table = {}, {}
    order = ["biases", "mf", "item_knn", "user_knn", "content_knn", "content_mf"]
    for name in order:
        results = []
        for params in grids(quick)[name]:
            t = time.perf_counter()
            p = fit_predict(world, build(world, name, params, tuned), train, probe)
            results.append({"params": params, "rmse": rmse(p, probe.r.to_numpy()), "s": time.perf_counter() - t})
            log(f"    tune {name:<11} {params} rmse {results[-1]['rmse']:.4f} ({results[-1]['s']:.1f}s)")
        best = min(results, key=lambda x: x["rmse"])
        tuned[name] = best["params"]
        table[name] = results
        log(f"  best {name}: {best['params']} rmse {best['rmse']:.4f}")
    return tuned, table


# ---------------------------------------------------------------- blending

COMPONENTS = ["user_bias", "biases", "mf", "item_knn", "user_knn", "content_knn", "content_mf",
              "content_ridge", "genre_ridge"]


def meta_features(world, train, frame):
    ucount = np.bincount(train.u, minlength=len(world.user_ids))
    icount = np.bincount(train.i, minlength=len(world.item_ids))
    return np.column_stack([
        np.log1p(ucount[frame.u.to_numpy()]),
        np.log1p(icount[frame.i.to_numpy()]),
        (icount[frame.i.to_numpy()] > 0).astype(float),
    ])


def design(preds: dict, meta: np.ndarray, interactions: bool):
    P = np.column_stack([preds[c] for c in COMPONENTS])
    if not interactions:
        return P
    blocks = [P, meta]
    for m in range(meta.shape[1]):
        blocks.append(P * meta[:, [m]])
    return np.column_stack(blocks)


def fit_linear(X, y, alpha=1.0):
    Xc = np.column_stack([np.ones(len(X)), X])
    reg = alpha * np.eye(Xc.shape[1]); reg[0, 0] = 0
    return np.linalg.solve(Xc.T @ Xc + reg, Xc.T @ y)


def apply_linear(w, X):
    return np.column_stack([np.ones(len(X)), X]) @ w


# ---------------------------------------------------------------- evaluation

def score(frame: pd.DataFrame, pred: np.ndarray, seed=0) -> dict:
    rng = np.random.default_rng(seed)
    err = pred - frame.r.to_numpy()
    rows = []
    for _, idx in frame.groupby("u").indices.items():
        if len(idx) < 2:
            continue
        rows.append(ranking_metrics(frame.r.to_numpy()[idx], pred[idx], rng))
    table = pd.DataFrame(rows)
    ranked = table[table.has_relevant]
    return {
        "rmse": float(np.sqrt(np.mean(err ** 2))), "mae": float(np.mean(np.abs(err))),
        "precision@10": float(ranked["precision@10"].mean()), "recall@10": float(ranked["recall@10"].mean()),
        "ndcg@10": float(table["ndcg@10"].mean()), "users": int(len(table)), "ratings": int(len(frame)),
    }


def run_protocol(world, protocol, args, out):
    folds = warm_folds(world, args.folds, args.seed) if protocol == "warm" else cold_folds(world, args.folds, args.seed)
    log(f"\n=== {protocol.upper()} protocol, {args.folds} folds ===")

    # Hyperparameters from an inner split of the first outer training fold.
    train0, _ = folds[0]
    inner_train, inner_probe = inner_split(world, train0, protocol, args.probe, args.seed)
    log(f"tuning on {len(inner_train)} / probe {len(inner_probe)}")
    tuned, tuning_table = tune(world, inner_train, inner_probe, args.quick)

    per_fold = []
    blend_weights = []
    for f, (train, test) in enumerate(folds):
        t_fold = time.perf_counter()
        # Stacking data: out-of-fold predictions over the whole outer training
        # fold, split the same way as the outer folds (per user, or per film).
        inner = (warm_folds if protocol == "warm" else cold_folds)(
            _Subset(train), args.stack_folds, args.seed + 100 + f)
        iprobe = pd.concat([probe for _, probe in inner])
        probe_preds = {name: np.empty(len(iprobe)) for name in COMPONENTS}
        meta_probe = np.empty((len(iprobe), 3))
        offset = 0
        for itrain, ifold in inner:
            meta_probe[offset:offset + len(ifold)] = meta_features(world, itrain, ifold)
            for name in COMPONENTS:
                probe_preds[name][offset:offset + len(ifold)] = fit_predict(
                    world, build(world, name, tuned.get(name, {}), tuned), itrain, ifold)
            offset += len(ifold)
        log(f"  fold {f + 1} out-of-fold stacking set: {len(iprobe)} ratings")
        test_preds = {}
        for name in COMPONENTS:
            t = time.perf_counter()
            test_preds[name] = fit_predict(world, build(world, name, tuned.get(name, {}), tuned), train, test)
            log(f"  fold {f + 1} {name:<14} test rmse {rmse(test_preds[name], test.r.to_numpy()):.4f} "
                f"({time.perf_counter() - t:.0f}s)")

        y = iprobe.r.to_numpy()
        meta_test = meta_features(world, train, test)
        results = {name: score(test, test_preds[name]) for name in COMPONENTS}

        simple = fit_linear(design(probe_preds, meta_probe, False), y)
        results["blend: linear"] = score(test, np.clip(apply_linear(simple, design(test_preds, meta_test, False)), RMIN, RMAX))
        rich = fit_linear(design(probe_preds, meta_probe, True), y, alpha=5.0)
        results["blend: linear + meta interactions"] = score(
            test, np.clip(apply_linear(rich, design(test_preds, meta_test, True)), RMIN, RMAX))
        try:
            from sklearn.ensemble import HistGradientBoostingRegressor
            gbm = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, max_leaf_nodes=31,
                                                min_samples_leaf=40, l2_regularization=1.0,
                                                early_stopping=True, validation_fraction=0.15, random_state=0)
            X_probe = np.column_stack([design(probe_preds, meta_probe, False), meta_probe])
            X_test = np.column_stack([design(test_preds, meta_test, False), meta_test])
            gbm.fit(X_probe, y)
            results["blend: gradient boosting"] = score(test, np.clip(gbm.predict(X_test), RMIN, RMAX))
        except ImportError:
            pass
        blend_weights.append(dict(zip(["intercept"] + COMPONENTS, simple.tolist())))
        per_fold.append(results)
        log(f"  fold {f + 1} done in {time.perf_counter() - t_fold:.0f}s")
        for name, r in results.items():
            if name.startswith("blend"):
                log(f"    {name:<36} rmse {r['rmse']:.4f} P@10 {r['precision@10']:.4f} nDCG {r['ndcg@10']:.4f}")

    names = list(per_fold[0])
    summary = {
        name: {k: {"mean": float(np.mean([fold[name][k] for fold in per_fold])),
                   "std": float(np.std([fold[name][k] for fold in per_fold]))}
               for k in ("rmse", "mae", "precision@10", "recall@10", "ndcg@10")}
        for name in names
    }
    weights = {k: float(np.mean([w[k] for w in blend_weights])) for k in blend_weights[0]}
    report = {"protocol": protocol, "tuned": tuned, "tuning": tuning_table, "summary": summary,
              "linear_blend_weights": weights, "per_fold": per_fold}
    (out / f"{protocol}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    log(f"\n{protocol.upper()} summary ({args.folds}-fold mean ± std)")
    log(f"{'model':<36}{'RMSE':>16}{'MAE':>16}{'P@10':>16}{'R@10':>16}{'nDCG@10':>16}")
    for name, s in summary.items():
        log(f"{name:<36}" + "".join(f"{s[k]['mean']:>9.4f}±{s[k]['std']:.4f}"
                                     for k in ("rmse", "mae", "precision@10", "recall@10", "ndcg@10")))
    log("linear blend weights: " + ", ".join(f"{k} {v:+.3f}" for k, v in weights.items()))


def main():
    args = parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    world = World(args)
    log(f"{len(world.ratings)} ratings, {len(world.user_ids)} users, {len(world.item_ids)} films")
    for protocol in (["warm", "cold"] if args.protocol == "both" else [args.protocol]):
        run_protocol(world, protocol, args, out)
    log(f"\ntotal {time.perf_counter() - t0:.0f}s")


if __name__ == "__main__":
    main()
