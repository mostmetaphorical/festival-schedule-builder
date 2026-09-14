"""Train the recommender on everyone, then write it out for the browser.

The app scores films on the user's own device, so the model has to travel as
data rather than code: a list of feature weights the JavaScript applies the same
way Python does. It is small enough to ship in a static file.

    python export_model.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from festrec_eval.data import build_splits, eligible_users, load_movielens
from festrec_eval.features import (
    RECOMMENDED_FACETS,
    SHRINKAGE,
    FeatureSpace,
)
from festrec_eval.models import ContentRidge

# Evidence shrinkage used to scale every prediction by how many of the
# person's rated films share credits or keywords with the candidate. At a
# festival most films share none, so it flattened them all to the person's
# average - synopsis similarity included. Without it, MovieLens accuracy is
# marginally better (RMSE 0.8810 -> 0.8794) and predictions for films with no
# shared people spread 35% more. See README.
EVIDENCE_SHRINKAGE = 0.0
# Pseudo-ratings at the training average blended into a person's own average.
PRIOR_WEIGHT = 5.0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", default="data/ml-latest-small")
    p.add_argument("--metadata", default="data/film_metadata.json")
    p.add_argument("--out", default="app/data/model.json")
    p.add_argument("--min-ratings", type=int, default=15)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    dataset = load_movielens(args.data)
    metadata = {
        int(k): v
        for k, v in json.loads(
            Path(args.metadata).read_text(encoding="utf-8")
        ).items()
    }

    # Everyone eligible, not a sample: this is the shipping model, and the
    # held-out testing that justified it has already been done.
    users = eligible_users(dataset, args.min_ratings)
    splits = build_splits(dataset, users, train_frac=1.0, seed=0)

    space = FeatureSpace(dataset.films, metadata=metadata,
                         include_facets=RECOMMENDED_FACETS)
    profiles = {s.user_id: space.build_profile(s.user_id, s.train) for s in splits}
    model = ContentRidge(evidence_shrinkage=EVIDENCE_SHRINKAGE, prior_weight=PRIOR_WEIGHT)
    model.fit(splits, space, profiles)

    payload = {
        "trained_on": {
            "dataset": "MovieLens ml-latest-small",
            "users": len(users),
            "ratings": int(sum(len(s.train) for s in splits)),
        },
        "facets": list(RECOMMENDED_FACETS),
        "shrinkage": SHRINKAGE,
        # With nothing known about a film, say nothing: shrink the prediction
        # back to the person's own average instead of to wherever the
        # standardised zero point happens to land.
        "evidence_shrinkage": EVIDENCE_SHRINKAGE,
        # The person's average is (n * mean + prior_weight * prior_mean) / (n + prior_weight).
        "prior_weight": PRIOR_WEIGHT,
        "prior_mean": model.prior_mean,
        "rating_range": [0.5, 5.0],
        "features": space.feature_names,
        "center": model.center.tolist(),
        "scale": model.scale.tolist(),
        "weights": model.weights.tolist(),
        "alpha": model.alpha_,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    # Word weights travel with the model: the browser must weigh a synopsis the
    # same way training did, and it can't re-derive that from one festival.
    if space.text is not None:
        idf = {
            term: round(float(space.text.idf[index]), 4)
            for term, index in space.text.vocabulary.items()
        }
        idf_path = out.with_name("idf.json")
        idf_path.write_text(
            json.dumps({"min_length": 3, "idf": idf}, separators=(",", ":")),
            encoding="utf-8",
        )
        print(f"Wrote {idf_path} "
              f"({idf_path.stat().st_size / 1024:.1f} KB, {len(idf)} terms)")

    print(f"Wrote {out} ({out.stat().st_size / 1024:.1f} KB)")
    print(f"trained on {len(users)} raters, alpha={model.alpha_}, "
          f"evidence shrinkage {EVIDENCE_SHRINKAGE}, prior {PRIOR_WEIGHT} at {model.prior_mean:.3f}")
    print("\nWhat the model learned (standardised weights):")
    for name, weight in sorted(
        model.coefficients().items(), key=lambda kv: -abs(kv[1])
    ):
        print(f"  {name:<20} {weight:+.4f}")


if __name__ == "__main__":
    main()
