"""Run the same 70/30 test on real Letterboxd exports.

MovieLens measures whether the recommender works. It can't tell us whether it
works on *this* population: Letterboxd users rate more recent and more
arthouse films, and rate them higher (a 3.9 average here against MovieLens's
3.5). This runs the identical test on real exports instead.

Drop each person's export zip - or their ratings.csv - into a folder:

    exports/
      alice-letterboxd.zip
      bob-ratings.csv

    python eval_letterboxd.py exports/

Every export is data someone chose to hand over. Nothing here contacts
Letterboxd, and nothing leaves the machine.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from festrec_eval import metrics as M
from festrec_eval.data import Dataset, build_splits
from festrec_eval.features import RECOMMENDED_FACETS, FeatureSpace
from festrec_eval.models import ContentRidge, GlobalMean, Model, UserMean
from festrec_eval.titles import key, normalise
from run_eval import HEADLINE, evaluate, print_by_profile_size, print_deltas

from export_model import EVIDENCE_SHRINKAGE, PRIOR_WEIGHT  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("exports", help="folder of export zips or ratings CSVs")
    p.add_argument("--bundle", default="app/data/library.json")
    p.add_argument("--min-ratings", type=int, default=15)
    p.add_argument("--train-frac", type=float, default=0.7)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--split", choices=["random", "time"], default="random")
    p.add_argument("--out", default="results/letterboxd")
    return p.parse_args()


def read_ratings(path: Path) -> list[dict]:
    """Ratings out of an export zip or a bare CSV."""
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.endswith("ratings.csv")]
            if not names:
                return []
            text = archive.read(names[0]).decode("utf-8-sig")
    else:
        text = path.read_text(encoding="utf-8-sig")

    rows = []
    for row in csv.DictReader(io.StringIO(text)):
        name = row.get("Name") or row.get("Title")
        rating = row.get("Rating") or row.get("Your Rating")
        if not name or not rating:
            continue
        try:
            value = float(rating)
        except ValueError:
            continue
        # IMDb rates out of ten; Letterboxd out of five.
        if value > 5:
            value /= 2
        year = row.get("Year") or ""
        rows.append({
            "title": name,
            "year": int(year) if str(year).isdigit() else None,
            "rating": value,
        })
    return rows


def build_dataset(
    exports: Path, bundle: dict, min_ratings: int
) -> tuple[Dataset, dict[int, dict], dict[int, str]]:
    """Turn a folder of exports into the same shape MovieLens arrives in."""
    films: dict[str, int] = {}
    film_rows: list[dict] = []
    ratings: list[dict] = []
    names: dict[int, str] = {}

    lookup = bundle["keys"]
    records = bundle["films"]

    def find(title: str, year) -> dict | None:
        for candidate in (
            key(title, year),
            key(title, (year or 0) - 1),
            key(title, (year or 0) + 1),
            key(title, ""),
        ):
            index = lookup.get(candidate)
            if index is not None:
                return records[index]
        return None

    files = sorted(
        p for p in exports.iterdir()
        if p.suffix.lower() in (".zip", ".csv") and not p.name.startswith(".")
    )
    if not files:
        raise SystemExit(f"No exports found in {exports}")

    for user_id, path in enumerate(files, start=1):
        rows = read_ratings(path)
        if len(rows) < min_ratings:
            print(f"  skipping {path.name}: {len(rows)} ratings (need "
                  f"{min_ratings})")
            continue

        names[user_id] = path.name
        matched = 0
        for row in rows:
            meta = find(row["title"], row["year"])
            if not meta:
                continue  # No credits means nothing to learn from.
            matched += 1
            film_key = f'{normalise(row["title"])}|{row["year"] or ""}'
            if film_key not in films:
                films[film_key] = len(film_rows) + 1
                film_rows.append({
                    "movieId": films[film_key],
                    "title": row["title"],
                    "year": row["year"],
                    "genres": [g.lower() for g in meta.get("genre", [])],
                    "meta": meta,
                })
            ratings.append({
                "userId": user_id,
                "movieId": films[film_key],
                "rating": row["rating"],
                "timestamp": 0,
            })
        print(f"  {path.name}: {len(rows)} ratings, {matched} matched "
              f"({matched / len(rows):.0%})")

    frame = pd.DataFrame(film_rows).set_index("movieId")
    dataset = Dataset(
        ratings=pd.DataFrame(ratings),
        films=frame[["title", "year", "genres"]],
    )
    metadata = {
        int(index): {
            "director": row["meta"].get("director", []),
            "writer": row["meta"].get("writer", []),
            "cast": row["meta"].get("cast", []),
            "keyword": row["meta"].get("keyword", []),
            "country": [],
            "language": [],
            "runtime": None,
            "overview": row["meta"].get("overview", ""),
        }
        for index, row in frame.iterrows()
    }
    return dataset, metadata, names


def main() -> None:
    args = parse_args()
    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))

    print(f"Reading exports from {args.exports}")
    dataset, metadata, names = build_dataset(
        Path(args.exports), bundle, args.min_ratings
    )

    user_ids = np.array(sorted(dataset.ratings.userId.unique()))
    if len(user_ids) == 0:
        raise SystemExit("No usable exports.")

    splits = build_splits(
        dataset, user_ids, args.train_frac, args.seed, args.split
    )
    space = FeatureSpace(dataset.films, metadata=metadata,
                         include_facets=RECOMMENDED_FACETS)
    profiles = {s.user_id: space.build_profile(s.user_id, s.train) for s in splits}

    print(f"\n{len(user_ids)} people, "
          f"{len(dataset.ratings)} matched ratings, "
          f"{len(dataset.films)} distinct films")
    if len(user_ids) < 10:
        print("Small sample - treat this as a smoke test, not a measurement. "
              "The confidence intervals below say how much to trust it.")

    models: list[Model] = [
        GlobalMean(),
        UserMean(),
        ContentRidge(evidence_shrinkage=EVIDENCE_SHRINKAGE, prior_weight=PRIOR_WEIGHT),
    ]
    results: dict[str, list[dict]] = {}
    for model in models:
        model.fit(splits, space, profiles)
        results[model.name] = evaluate(model, splits, profiles)

    print(f"\nReal Letterboxd exports, cold condition")
    print("-" * 86)
    print(f"{'model':<20}" + "".join(f"{k:>11}" for k in HEADLINE))
    for name, rows in results.items():
        summary = M.aggregate(rows)
        line = f"{name:<20}"
        for metric in HEADLINE:
            value = summary[metric]["mean"]
            line += f"{'-':>11}" if np.isnan(value) else f"{value:>11.3f}"
        print(line)
    print("-" * 86)

    print_deltas(results, "user_mean")
    print_by_profile_size(results, splits)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = [
        {"model": name, "export": names.get(row["user_id"], ""), **row}
        for name, per_user in results.items()
        for row in per_user
    ]
    pd.DataFrame(rows).to_csv(out / "per_user.csv", index=False)
    print(f"\nWrote {out / 'per_user.csv'}")


if __name__ == "__main__":
    main()
