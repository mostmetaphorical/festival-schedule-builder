"""Cross-validate the servable cold-item blend.

Film-level 5-fold (every rating of a held-out film is hidden, as for a
festival premiere), with out-of-fold stacking inside each training fold.
Components are the servable versions in festrec_eval/serve.py plus the two
ridge models, and the blend works in deviations from the person's steadied
average. Besides accuracy it reports spread: how far apart predictions for
one person's held-out films are, next to how far apart their real ratings are.

    python run_blend.py
"""

from __future__ import annotations

import argparse
import itertools
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from festrec_eval.serve import CreditsCrowd, PersonBase, ServableContentKNN, ServableContentMF, entity_matrices
from run_ensemble import RMIN, RMAX, RidgeComponent, World, _Subset, cold_folds, inner_split, log, score

VARIANTS = {
    "ridge only (shipped)": ["content_ridge"],
    "ridge + knn + mf + genre": ["content_ridge", "content_knn", "content_mf", "genre_ridge"],
    "all + track record (people)": ["content_ridge", "content_knn", "content_mf", "genre_ridge", "crowd_people"],
    "all + track record (with crew)": ["content_ridge", "content_knn", "content_mf", "genre_ridge", "crowd"],
    "fallback: no content_mf": ["content_ridge", "content_knn", "genre_ridge", "crowd"],
}
# Track-record columns from the first five facets (director, writer, cast, keyword, genre).
PEOPLE_COLUMNS = 10
PREDICTORS = ["content_ridge", "genre_ridge", "content_knn", "content_mf"]


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--metadata", default="data/film_metadata.json")
    p.add_argument("--folds", type=int, default=5)
    p.add_argument("--stack-folds", type=int, default=3)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--probe", type=float, default=0.1)
    p.add_argument("--alpha", type=float, default=10.0)
    p.add_argument("--out", default="results/blend")
    p.add_argument("--tuned", help="reuse component settings from an earlier results file")
    return p.parse_args()


def build(world, name, tuned):
    if name == "base":
        return PersonBase()
    if name == "content_ridge":
        return RidgeComponent(world)
    if name == "genre_ridge":
        return RidgeComponent(world, genre=True)
    if name == "content_knn":
        return ServableContentKNN(world.content, **tuned.get("content_knn", {}))
    if name == "content_mf":
        return ServableContentMF(world.content, **tuned.get("content_mf", {}))
    raise ValueError(name)


def run_components(world, entities, tuned, train, test):
    """Predictions for every predictor, plus base and crowd features, on `test`."""
    u, i = test.u.to_numpy(), test.i.to_numpy()
    ratings = world.to_ratings(train)
    out = {"base": PersonBase().fit(ratings).predict(u, i)}
    for name in PREDICTORS:
        model = build(world, name, tuned)
        fitted = model.fit(train) if isinstance(model, RidgeComponent) else model.fit(ratings)
        out[name] = np.clip(fitted.predict(u, i), RMIN, RMAX)
    out["crowd"] = CreditsCrowd(entities).fit(ratings).features(i)
    counts = np.bincount(train.u, minlength=len(world.user_ids))
    out["log_n"] = np.log1p(counts[u])
    return out


def design(parts, names):
    cols = []
    for name in names:
        if name == "crowd":
            cols.append(parts["crowd"])
        elif name == "crowd_people":
            cols.append(parts["crowd"][:, :PEOPLE_COLUMNS])
        else:
            cols.append((parts[name] - parts["base"])[:, None])
    cols.append(parts["log_n"][:, None])
    return np.column_stack(cols)


def fit_linear(X, y, alpha):
    Xc = np.column_stack([np.ones(len(X)), X])
    mean, std = Xc[:, 1:].mean(axis=0), Xc[:, 1:].std(axis=0)
    std[std == 0] = 1
    Z = np.column_stack([np.ones(len(X)), (Xc[:, 1:] - mean) / std])
    reg = alpha * np.eye(Z.shape[1]); reg[0, 0] = 0
    w = np.linalg.solve(Z.T @ Z + reg, Z.T @ y)
    return w, mean, std


def apply_linear(model, X):
    w, mean, std = model
    return np.column_stack([np.ones(len(X)), (X - mean) / std]) @ w


def spread(frame, pred):
    """Mean within-person std of predictions, and of the real ratings, over the same films."""
    stds, real = [], []
    for _, idx in frame.groupby("u").indices.items():
        if len(idx) >= 5:
            stds.append(np.std(pred[idx]))
            real.append(np.std(frame.r.to_numpy()[idx]))
    return float(np.mean(stds)), float(np.mean(real))


def tune(world, train0, entities):
    """Small grids for the two new predictors, on a film-level inner split."""
    itrain, iprobe = inner_split(world, train0, "cold", 0.1, 0)
    ratings = world.to_ratings(itrain)
    y = iprobe.r.to_numpy()
    u, i = iprobe.u.to_numpy(), iprobe.i.to_numpy()
    tuned = {}
    best = None
    for k, damping, power in itertools.product((10, 20, 50), (0.05, 0.1, 0.5), (1.0, 2.0, 3.0)):
        p = ServableContentKNN(world.content, k=k, damping=damping, power=power).fit(ratings).predict(u, i)
        e = float(np.sqrt(np.mean((np.clip(p, RMIN, RMAX) - y) ** 2)))
        if best is None or e < best[0]:
            best = (e, dict(k=k, damping=damping, power=power))
    tuned["content_knn"] = best[1]
    log(f"  content_knn {best[1]} rmse {best[0]:.4f}")
    best = None
    for factors, kernel_reg, fold_reg in itertools.product((10, 25), (0.3, 1.0), (0.05, 0.1, 0.3)):
        t = time.perf_counter()
        p = ServableContentMF(world.content, factors=factors, kernel_reg=kernel_reg, fold_reg=fold_reg) \
            .fit(ratings).predict(u, i)
        e = float(np.sqrt(np.mean((np.clip(p, RMIN, RMAX) - y) ** 2)))
        log(f"    content_mf f={factors} kr={kernel_reg} fr={fold_reg} rmse {e:.4f} ({time.perf_counter() - t:.0f}s)")
        if best is None or e < best[0]:
            best = (e, dict(factors=factors, kernel_reg=kernel_reg, fold_reg=fold_reg))
    tuned["content_mf"] = best[1]
    log(f"  content_mf {best[1]} rmse {best[0]:.4f}")
    return tuned


def main():
    args = parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    world = World(args)
    entities, _ = entity_matrices([int(m) for m in world.item_ids], world.metadata)
    folds = cold_folds(world, args.folds, args.seed)

    if args.tuned:
        tuned = json.loads(Path(args.tuned).read_text())["tuned"]
        log(f"reusing settings {tuned}")
    else:
        log("tuning")
        tuned = tune(world, folds[0][0], entities)

    rows, weights = [], []
    for f, (train, test) in enumerate(folds):
        t = time.perf_counter()
        inner = cold_folds(_Subset(train), args.stack_folds, args.seed + 100 + f)
        probe_frames, probe_parts = [], []
        for itrain, ifold in inner:
            probe_frames.append(ifold)
            probe_parts.append(run_components(world, entities, tuned, itrain, ifold))
        probe = pd.concat(probe_frames)
        pp = {k: (np.vstack([p[k] for p in probe_parts]) if k == "crowd" else np.concatenate([p[k] for p in probe_parts]))
              for k in probe_parts[0]}
        tp = run_components(world, entities, tuned, train, test)

        y_probe = probe.r.to_numpy() - pp["base"]
        result = {"base (steadied average)": {**score(test, tp["base"]), "spread": spread(test, tp["base"])[0]}}
        for name in PREDICTORS:
            result[name] = {**score(test, tp[name]), "spread": spread(test, tp[name])[0]}
        for label, names in VARIANTS.items():
            model = fit_linear(design(pp, names), y_probe, args.alpha)
            pred = np.clip(tp["base"] + apply_linear(model, design(tp, names)), RMIN, RMAX)
            sp, real = spread(test, pred)
            result[f"blend: {label}"] = {**score(test, pred), "spread": sp}
            if label == "all + track record (with crew)":
                weights.append(model[0].tolist())
        result["actual ratings"] = {"spread": spread(test, tp["base"])[1]}
        rows.append(result)
        log(f"fold {f + 1} in {time.perf_counter() - t:.0f}s: " + ", ".join(
            f"{k} {v['rmse']:.4f}/{v['spread']:.3f}" for k, v in result.items() if "rmse" in v and k.startswith("blend")))

    keys = ("rmse", "mae", "precision@10", "recall@10", "ndcg@10", "spread")
    summary = {}
    for name in rows[0]:
        summary[name] = {k: {"mean": float(np.mean([r[name][k] for r in rows])), "std": float(np.std([r[name][k] for r in rows]))}
                         for k in keys if k in rows[0][name]}
    log(f"\nCOLD blend, {args.folds}-fold mean ± std (spread = mean within-person std of predictions)")
    log(f"{'model':<34}" + "".join(f"{k:>16}" for k in keys))
    for name, s in summary.items():
        log(f"{name:<34}" + "".join(f"{s[k]['mean']:>9.4f}±{s[k]['std']:.4f}" if k in s else f"{'':>16}" for k in keys))
    (out / "cold.json").write_text(json.dumps({"tuned": tuned, "summary": summary, "weights_all": weights}, indent=2))
    log(f"\ntotal {time.perf_counter() - t0:.0f}s")


if __name__ == "__main__":
    main()
