"""Scoring.

A festival schedule only holds a handful of films, so ranking matters more
than star-rating accuracy: getting the order right is the job, and being off
by half a star on every prediction is harmless if the order survives.
"""

from __future__ import annotations

import numpy as np
from scipy import stats

# A film the person would be glad they saw.
RELEVANT_AT = 4.0
# Anything flatter than this counts as a constant prediction.
FLAT = 1e-12
# Below this many people, a bootstrap interval is theatre.
MIN_USERS_FOR_CI = 5
TOP_K = 5
NDCG_K = 10


def ndcg(actual: np.ndarray, predicted: np.ndarray, k: int = NDCG_K) -> float:
    """Ranking quality, with the person's real ratings as the payoff."""
    k = min(k, len(actual))
    if k == 0:
        return float("nan")

    discount = 1.0 / np.log2(np.arange(2, k + 2))
    chosen = actual[np.argsort(-predicted)[:k]]
    ideal = np.sort(actual)[::-1][:k]

    best = float((ideal * discount).sum())
    if best <= 0:
        return float("nan")
    return float((chosen * discount).sum()) / best


def user_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    """Everything we can say about one person's held-out films."""
    error = predicted - actual
    out: dict[str, float] = {
        "n_test": float(len(actual)),
        "rmse": float(np.sqrt(np.mean(error**2))),
        "mae": float(np.mean(np.abs(error))),
        "ndcg@10": ndcg(actual, predicted, NDCG_K),
    }

    # Correlation needs spread on both sides, or it is undefined. Compare
    # against a tolerance: a constant array's std comes back as ~1e-16, not 0.
    if len(actual) >= 3 and actual.std() > FLAT and predicted.std() > FLAT:
        out["spearman"] = float(stats.spearmanr(actual, predicted).statistic)
    else:
        out["spearman"] = float("nan")

    k = min(TOP_K, len(actual))
    top = actual[np.argsort(-predicted)[:k]]
    out["top5_actual_mean"] = float(top.mean())
    # How much better than picking at random from the same slate.
    out["top5_lift"] = float(top.mean() - actual.mean())
    out["top5_oracle_gap"] = float(np.sort(actual)[::-1][:k].mean() - top.mean())

    relevant = actual >= RELEVANT_AT
    out["precision@5"] = (
        float(np.mean(relevant[np.argsort(-predicted)[:k]]))
        if relevant.any()
        else float("nan")
    )
    return out


def aggregate(
    per_user: list[dict[str, float]], seed: int = 0, n_boot: int = 2000
) -> dict[str, dict[str, float]]:
    """Average across people, with a bootstrap interval over users."""
    if not per_user:
        return {}

    rng = np.random.default_rng(seed)
    keys = [k for k in per_user[0] if k != "n_test"]
    summary: dict[str, dict[str, float]] = {}

    for key in keys:
        values = np.array([u[key] for u in per_user], dtype=float)
        values = values[np.isfinite(values)]
        if len(values) == 0:
            summary[key] = {"mean": float("nan"), "lo": float("nan"),
                            "hi": float("nan"), "n_users": 0}
            continue

        draws = rng.choice(values, size=(n_boot, len(values)), replace=True)
        means = draws.mean(axis=1)
        summary[key] = {
            "mean": float(values.mean()),
            "lo": float(np.percentile(means, 2.5)),
            "hi": float(np.percentile(means, 97.5)),
            "n_users": int(len(values)),
        }

    summary["n_test_total"] = {
        "mean": float(sum(u["n_test"] for u in per_user)),
        "lo": float("nan"),
        "hi": float("nan"),
        "n_users": len(per_user),
    }
    return summary


def paired_delta(
    per_user_a: list[dict[str, float]],
    per_user_b: list[dict[str, float]],
    key: str,
    seed: int = 0,
    n_boot: int = 2000,
) -> dict[str, float]:
    """Is A better than B on the same users? Paired, so user difficulty cancels."""
    a = np.array([u[key] for u in per_user_a], dtype=float)
    b = np.array([u[key] for u in per_user_b], dtype=float)
    both = np.isfinite(a) & np.isfinite(b)
    diff = a[both] - b[both]
    if len(diff) == 0:
        return {"delta": float("nan"), "lo": float("nan"), "hi": float("nan"),
                "n_users": 0}
    if len(diff) < MIN_USERS_FOR_CI:
        # Bootstrapping two or three users resamples the same values and
        # returns an interval of almost no width - false precision, and the
        # most misleading thing this file could print.
        return {"delta": float(diff.mean()), "lo": float("nan"),
                "hi": float("nan"), "n_users": int(len(diff))}

    rng = np.random.default_rng(seed)
    draws = rng.choice(diff, size=(n_boot, len(diff)), replace=True).mean(axis=1)
    return {
        "delta": float(diff.mean()),
        "lo": float(np.percentile(draws, 2.5)),
        "hi": float(np.percentile(draws, 97.5)),
        "n_users": int(len(diff)),
    }
