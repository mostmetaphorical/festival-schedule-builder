"""Python half of the blend parity check: the same predictions, computed the Python way.

    python check_blend_parity.py && node check_blend_parity.mjs

Takes one MovieLens user, describes their rated films and some films they
haven't rated the way the app describes films (entities, synopsis, cf), and
writes those inputs with the Python blend's component and final predictions to
results/blend_parity.json for check_blend_parity.mjs to reproduce.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from add_content_factors import ContentFactorModel
from festrec_eval.serve import CREDIT_FACETS, fold_in, credit_entities
from run_ensemble import RidgeComponent, World, log

USER = 414   # a long rating history
CANDIDATES = 120


class Args:
    data = "data/ml-latest-small"
    metadata = "data/film_metadata.json"


def main():
    world = World(Args())
    blend = json.loads(Path("app/data/blend.json").read_text())
    track = json.loads(Path("app/data/track.json").read_text())
    cfm = ContentFactorModel()

    ratings = world.ratings
    uix = world.uix[USER]
    mine = ratings[ratings.u == uix]
    rated_ids = [int(world.item_ids[i]) for i in mine.i]
    rng = np.random.default_rng(0)
    unrated = [int(m) for m in world.item_ids if int(m) not in set(rated_ids) and world.metadata.get(int(m))]
    cand_ids = [int(m) for m in rng.choice(unrated, CANDIDATES, replace=False)]

    def film(mid, rating=None):
        meta = world.metadata.get(mid) or {}
        year = world.dataset.films.loc[mid].year
        record = {
            "movieId": mid,
            "year": None if np.isnan(year) else int(year),
            "synopsis": meta.get("overview") or "",
            "entities": {f: list(meta.get(f) or []) for f in
                         ("director", "writer", "cast", "keyword", "genre", "editor", "cinematographer")},
        }
        if rating is not None:
            record["rating"] = float(rating)
        return record

    rated = [film(m, r) for m, r in zip(rated_ids, mine.r)]
    candidates = [film(m) for m in cand_ids]
    records = [{"synopsis": f["synopsis"], **f["entities"]} for f in rated + candidates]
    for f, cf in zip(rated + candidates, cfm.factors_for(records)):
        if cf is not None:
            f["cf"] = cf

    # Components, from the same definitions the app mirrors.
    base = (sum(f["rating"] for f in rated) + blend["prior_weight"] * blend["prior_mean"]) / (len(rated) + blend["prior_weight"])

    ridge = RidgeComponent(world).fit(ratings)
    genre = RidgeComponent(world, genre=True).fit(ratings)
    u = np.full(len(cand_ids), uix)
    idx = np.array([world.iix[m] for m in cand_ids])
    clip = lambda x: np.clip(x, 0.5, 5.0)
    parts = {"content_ridge": clip(ridge.predict(u, idx)), "genre_ridge": clip(genre.predict(u, idx))}

    # Content kNN over ContentSpace rows.
    rows = cfm.space.rows(records)
    R, C = rows[: len(rated)], rows[len(rated):]
    S = (C @ R.T).toarray()
    knn = blend["knn"]
    resid = np.array([f["rating"] for f in rated]) - base
    out = []
    for srow in S:
        s = np.where(srow > 0, srow ** knn["power"], 0.0)
        top = np.argsort(-s, kind="stable")[: knn["k"]]
        out.append(base + (s[top] * resid[top]).sum() / (s[top].sum() + knn["damping"]))
    parts["content_knn"] = clip(np.array(out))

    # Content MF fold-in over rated films with factors.
    mf = blend["mf"]
    with_cf = [f for f in rated if "cf" in f]
    Q = np.array([f["cf"] for f in with_cf])

    class Data:  # the fold_in interface, one user
        u = np.zeros(len(with_cf), dtype=int); i = np.arange(len(with_cf))
        r = np.array([f["rating"] for f in with_cf]); n_users = 1
    bu, P = fold_in(Data, mf["mu"], Q[:, 0], Q[:, 1:], mf["fold_reg"], mf["user_reg"], mf["iters"])
    mf_pred = np.array([mf["mu"] + bu[0] + f["cf"][0] + P[0] @ np.array(f["cf"][1:]) if "cf" in f else np.nan
                        for f in candidates])
    parts["content_mf"] = clip(mf_pred)

    # Track record from the shipped tables.
    feats = []
    for f in candidates:
        ents = credit_entities(f["entities"])
        row = {}
        for facet in CREDIT_FACETS:
            s = c = 0.0
            for name in ents[facet]:
                entry = track["tables"][facet].get(name)
                if entry:
                    s += entry[0]; c += entry[1]
            row[f"track:{facet}:mean"] = s / (c + track["shrink"])
            row[f"track:{facet}:log_count"] = float(np.log1p(max(c, 0)))
        feats.append(row)

    final = []
    for n, f in enumerate(candidates):
        use = "full" if not np.isnan(parts["content_mf"][n]) else "no_content_mf"
        spec = blend["blends"][use]
        inputs = {**feats[n], "log_n": float(np.log1p(len(rated)))}
        for name in ("content_ridge", "genre_ridge", "content_knn", "content_mf"):
            inputs[name] = float(parts[name][n] - base)
        dev = spec["intercept"] + sum(w * (inputs[name] - m) / s for name, w, m, s in
                                      zip(spec["inputs"], spec["weights"], spec["mean"], spec["std"]))
        final.append(float(np.clip(base + dev, 0.5, 5.0)))

    Path("results").mkdir(exist_ok=True)
    Path("results/blend_parity.json").write_text(json.dumps({
        "rated": rated, "candidates": candidates, "base": base,
        "python": {k: [None if np.isnan(x) else float(x) for x in v] for k, v in parts.items()} | {"final": final},
    }))
    log(f"user {USER}: {len(rated)} rated, {len(candidates)} candidates; prediction spread {np.std(final):.3f}")


if __name__ == "__main__":
    main()
