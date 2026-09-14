"""Give films their content-predicted CF bias and factors (`cf`), for the blend.

    python add_content_factors.py app/data/festival.json app/data/festivals/tiff-2026.json

The browser folds a person's taste in from the factors of films they rated and
applies it to a festival film's factors. Both sides come from the same
content -> factors mapping (export_blend.py), computed here offline because it
needs MovieLens. build_bundle.py calls `factors_for` for the library.
A festival shared by someone later, without `cf`, still gets a blend - just
without that component.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy import sparse

from festrec_eval.serve import ContentSpace
from festrec_eval.text import TextIndex

DECIMALS = 4


class ContentFactorModel:
    def __init__(self, metadata_path="data/film_metadata.json", x_path="data/content_factors_X.npz",
                 params_path="data/content_factors.npz"):
        metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
        # The same synopsis vocabulary and weights the model was trained with.
        self.text = TextIndex({int(k): (v or {}).get("overview", "") for k, v in metadata.items()})
        self.space = ContentSpace(self.text)
        self.X = sparse.load_npz(x_path)
        params = np.load(params_path)
        self.alpha, self.mu = params["alpha"], float(params["mu"])

    def factors_for(self, records: list[dict]) -> list[list[float] | None]:
        """[bias, factor_1, ...] per record, or None for a film with no content at all."""
        rows = self.space.rows(records)
        pred = np.asarray((rows @ self.X.T) @ self.alpha)
        empty = np.diff(rows.indptr) == 0
        return [None if empty[n] else [round(float(x), DECIMALS) for x in pred[n]] for n in range(len(records))]


def festival_record(film: dict) -> dict:
    entities = film.get("entities") or {}
    return {
        "synopsis": film.get("synopsis") or "",
        **{facet: entities.get(facet) or [] for facet in ("director", "writer", "cast", "keyword", "genre")},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("festivals", nargs="+")
    args = p.parse_args()
    model = ContentFactorModel()
    for path in args.festivals:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        films = [f for f in data["films"] if f.get("kind") != "event"]
        for film, cf in zip(films, model.factors_for([festival_record(f) for f in films])):
            if cf is None:
                film.pop("cf", None)
            else:
                film["cf"] = cf
        Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"{path}: factors for {sum(1 for f in films if f.get('cf'))} of {len(films)} films")


if __name__ == "__main__":
    main()
