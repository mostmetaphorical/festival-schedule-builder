"""Optional: score the held-out films with Claude, for comparison.

This exists to answer one question with numbers rather than opinion - does an
LLM predict taste better than the free content model, and by enough to justify
paying per user? Responses are cached on disk so a rerun costs nothing.

Note the built-in advantage it has here: Claude has read about these films.
At a real festival the titles are unreleased, so treat its score as an
optimistic ceiling, not a forecast.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

from .models import Model

# $ per million tokens, input / output.
PRICES = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

SYSTEM = """You predict how a specific person will rate films they have not seen.

You are given their rating history on a 0.5-5.0 scale in half-star steps, then
a list of candidate films. Infer their taste - genres, directors, eras, tone,
how harsh or generous a rater they are - and predict a rating for every
candidate. Use their own scale: if they average 3.2, a 4.5 means something
rare. Predict a rating for every candidate, in the order given."""

SCHEMA = {
    "type": "object",
    "properties": {
        "ratings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "rating": {"type": "number"},
                },
                "required": ["index", "rating"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["ratings"],
    "additionalProperties": False,
}


class LLMRecommender(Model):
    """Ask Claude for a rating per candidate film."""

    name = "llm"

    def __init__(
        self,
        films: pd.DataFrame,
        model: str = "claude-opus-5",
        cache_dir: Path | str = "results/llm_cache",
        effort: str = "medium",
    ):
        self.films = films
        self.model = model
        self.effort = effort
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cost_usd = 0.0
        self._client = None

    @property
    def client(self):
        if self._client is None:
            import anthropic

            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise RuntimeError(
                    "ANTHROPIC_API_KEY is not set; --llm needs an API key."
                )
            self._client = anthropic.Anthropic()
        return self._client

    def _label(self, movie_id: int) -> str:
        row = self.films.loc[movie_id]
        year = "" if pd.isna(row.year) else f" ({int(row.year)})"
        genres = f" [{', '.join(row.genres)}]" if row.genres else ""
        return f"{row.title}{year}{genres}"

    def _prompt(self, profile, movie_ids: list[int], train: pd.DataFrame) -> str:
        history = "\n".join(
            f"{r.rating:.1f}  {self._label(int(r.movieId))}"
            for r in train.sort_values("rating", ascending=False).itertuples()
        )
        candidates = "\n".join(
            f"{i}. {self._label(movie_id)}"
            for i, movie_id in enumerate(movie_ids)
        )
        return (
            f"Rating history ({len(train)} films, average "
            f"{profile.mean:.2f}):\n{history}\n\n"
            f"Predict this person's rating for each of these "
            f"{len(movie_ids)} films:\n{candidates}"
        )

    def _cache_path(self, user_id: int, prompt: str) -> Path:
        digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
        return self.cache_dir / f"{self.model}_u{user_id}_{digest}.json"

    def predict(self, split, profile, movie_ids) -> np.ndarray:
        prompt = self._prompt(profile, movie_ids, split.train)
        cached = self._cache_path(split.user_id, prompt)

        if cached.exists():
            payload = json.loads(cached.read_text(encoding="utf-8"))
        else:
            payload = self._call(prompt)
            cached.write_text(json.dumps(payload), encoding="utf-8")

        # Fall back to the person's own average wherever the model skipped one.
        out = np.full(len(movie_ids), profile.mean)
        for item in payload.get("ratings", []):
            index = item.get("index")
            if isinstance(index, int) and 0 <= index < len(out):
                out[index] = float(item["rating"])
        return self._clip(out)

    def _call(self, prompt: str) -> dict:
        import anthropic

        request = dict(
            model=self.model,
            max_tokens=16000,
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
            output_config={
                "effort": self.effort,
                "format": {"type": "json_schema", "schema": SCHEMA},
            },
        )
        try:
            response = self.client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                **request,
            )
        except anthropic.BadRequestError:
            # Older account or endpoint without server-side fallbacks.
            response = self.client.messages.create(**request)

        self.calls += 1
        self.input_tokens += response.usage.input_tokens
        self.output_tokens += response.usage.output_tokens
        price_in, price_out = PRICES.get(self.model, (5.0, 25.0))
        self.cost_usd += (
            response.usage.input_tokens * price_in
            + response.usage.output_tokens * price_out
        ) / 1_000_000

        if response.stop_reason == "refusal":
            raise RuntimeError(f"model declined: {response.stop_details}")

        text = next((b.text for b in response.content if b.type == "text"), "{}")
        return json.loads(text)
