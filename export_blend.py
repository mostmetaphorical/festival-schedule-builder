"""Train the cold-item blend on all of MovieLens and write it out for the browser.

    python export_blend.py            # after export_model.py

Writes:
  app/data/blend.json         component settings and the stacked blend weights
  app/data/model-genre.json   the genre ridge, in model.json's format
  app/data/track.json         track records: crowd scores for people, crew,
                              collaborations, keywords and genres
  data/content_factors.npz    the content -> (bias, factors) mapping, used by
                              add_content_factors.py for the library and festivals

Blend weights come from out-of-fold predictions (film-level folds, so every
film is predicted as if unrated), exactly as run_blend.py cross-validated them.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse

from export_model import PRIOR_WEIGHT
from festrec_eval.serve import (
    CREDIT_FACETS,
    ContentFactors,
    ContentSpace,
    CreditsCrowd,
    entity_matrices,
)
from run_blend import PREDICTORS, apply_linear, design, fit_linear, run_components
from run_ensemble import RidgeComponent, World, cold_folds, log

FULL = ["content_ridge", "content_knn", "content_mf", "genre_ridge", "crowd"]
NO_MF = ["content_ridge", "content_knn", "genre_ridge", "crowd"]


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--metadata", default="data/film_metadata.json")
    p.add_argument("--tuned", default="results/blend/cold.json")
    p.add_argument("--stack-folds", type=int, default=3)
    p.add_argument("--alpha", type=float, default=10.0)
    p.add_argument("--seed", type=int, default=0)
    return p.parse_args()


def input_names(names):
    out = []
    for name in names:
        if name == "crowd":
            for facet in CREDIT_FACETS:
                out += [f"track:{facet}:mean", f"track:{facet}:log_count"]
        else:
            out.append(name)
    return out + ["log_n"]


def ridge_payload(component: RidgeComponent) -> dict:
    model, space = component.model, component.space
    return {
        "trained_on": {"dataset": "MovieLens ml-latest-small", "users": len(component.profiles)},
        "facets": list(space.facets) + (["year"] if space.use_year else []) + (["text"] if space.use_text else []),
        "genre_from_metadata": space.genre_from_metadata,
        "shrinkage": 3.0,
        "evidence_shrinkage": 0.0,
        "prior_weight": model.prior_weight,
        "prior_mean": model.prior_mean,
        "rating_range": [0.5, 5.0],
        "features": space.feature_names,
        "center": model.center.tolist(),
        "scale": model.scale.tolist(),
        "weights": model.weights.tolist(),
        "alpha": model.alpha_,
    }


def main():
    args = parse_args()
    tuned = json.loads(Path(args.tuned).read_text())["tuned"]
    world = World(args)
    # Serve-time content vectors, so what the blend learns from is what the app computes.
    space = ContentSpace(world.space.text)
    world.content = space.rows([world.metadata.get(int(m)) or {} for m in world.item_ids])
    entities, vocabularies = entity_matrices([int(m) for m in world.item_ids], world.metadata)
    log(f"settings {tuned}")

    # Out-of-fold predictions over everything, film-level.
    folds = cold_folds(world, args.stack_folds, args.seed)
    frames, parts = [], []
    for n, (train, test) in enumerate(folds):
        log(f"stacking fold {n + 1}/{len(folds)}")
        frames.append(test)
        parts.append(run_components(world, entities, tuned, train, test))
    oof = {k: (np.vstack([p[k] for p in parts]) if k == "crowd" else np.concatenate([p[k] for p in parts]))
           for k in parts[0]}
    y = pd.concat(frames).r.to_numpy() - oof["base"]

    blends = {}
    for label, names in (("full", FULL), ("no_content_mf", NO_MF)):
        w, mean, std = fit_linear(design(oof, names), y, args.alpha)
        pred = oof["base"] + apply_linear((w, mean, std), design(oof, names))
        rmse = float(np.sqrt(np.mean((np.clip(pred, 0.5, 5) - (y + oof["base"])) ** 2)))
        blends[label] = {"inputs": input_names(names), "intercept": float(w[0]), "weights": w[1:].tolist(),
                         "mean": mean.tolist(), "std": std.tolist(), "oof_rmse": rmse}
        log(f"blend {label}: out-of-fold RMSE {rmse:.4f}")
        for name, weight in zip(input_names(names), w[1:]):
            log(f"    {name:<48} {weight:+.4f}")

    # Final components on all ratings.
    all_ratings = world.ratings
    data = world.to_ratings(all_ratings)
    genre = RidgeComponent(world, genre=True).fit(all_ratings)
    Path("app/data/model-genre.json").write_text(json.dumps(ridge_payload(genre), indent=2), encoding="utf-8")

    crowd = CreditsCrowd(entities).fit(data)
    tables = {}
    for facet in CREDIT_FACETS:
        sums, counts = crowd.tables[facet]
        names = {index: name for name, index in vocabularies[facet].items()}
        tables[facet] = {names[j]: [round(float(sums[j]), 4), int(counts[j])]
                         for j in np.flatnonzero(counts > 0) if j in names}
    Path("app/data/track.json").write_text(json.dumps(
        {"source": "MovieLens ml-latest-small film biases, by credit", "shrink": crowd.shrink,
         "cast_depth": 5, "facets": list(CREDIT_FACETS), "tables": tables},
        separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    mf_settings = tuned["content_mf"]
    factors = ContentFactors(world.content, factors=mf_settings["factors"], kernel_reg=mf_settings["kernel_reg"]).fit(data)
    sparse.save_npz("data/content_factors_X.npz", factors.X.tocsr())
    np.savez("data/content_factors.npz", alpha=factors.alpha, mu=factors.mu)

    blend = {
        "trained_on": {"dataset": "MovieLens ml-latest-small", "ratings": int(len(all_ratings))},
        "prior_mean": float(all_ratings.r.mean()),
        "prior_weight": PRIOR_WEIGHT,
        "knn": tuned["content_knn"],
        "content_facets": ["director", "writer", "cast", "keyword", "genre"],
        "mf": {"mu": float(factors.mu), "factors": mf_settings["factors"], "fold_reg": mf_settings["fold_reg"],
               "user_reg": 5.0, "iters": 4},
        "blends": blends,
    }
    Path("app/data/blend.json").write_text(json.dumps(blend, indent=2), encoding="utf-8")
    sizes = {p: Path(p).stat().st_size // 1024 for p in
             ("app/data/blend.json", "app/data/model-genre.json", "app/data/track.json")}
    log(f"wrote {sizes} (KB), content factors to data/")


if __name__ == "__main__":
    main()
