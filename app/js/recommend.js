/**
 * Scoring, in the browser.
 *
 * This mirrors festrec_eval/features.py exactly - same shrinkage, same
 * overlap weighting, same word weights - because the model's coefficients were
 * fitted against those definitions. If you change one side, change both, and
 * re-run the Python test to see what it did to the numbers.
 *
 * Nothing here talks to a network. The ratings stay on the device.
 */

const SHRINKAGE = 3.0;         // must match features.py
const YEAR_SIGMA = 10.0;       // must match features.py
const FACETS = ['director', 'writer', 'cast', 'keyword', 'genre', 'decade'];
const PEOPLE = ['director', 'writer', 'cast'];
const TOKEN = /[a-z][a-z']+/g;
const MIN_TOKEN = 3;

const indexOf = (features) => new Map(features.map((name, i) => [name, i]));

const numericYear = (film) => {
  const year = Number(film.year);
  return Number.isFinite(year) && year > 1800 ? year : NaN;
};

/**
 * Decade is derived from the year rather than stored, matching features.py.
 * Returns the film's entities with the derived facets filled in.
 */
function withDerived(film) {
  const entities = { ...(film.entities || {}) };
  if (!entities.decade) {
    const year = numericYear(film);
    entities.decade = Number.isFinite(year)
      ? [String(Math.floor(year / 10) * 10)]
      : [];
  }
  if (!entities.genre) entities.genre = [];
  return entities;
}

export class Recommender {
  constructor(model, idf, stopwords) {
    this.model = model;
    this.idf = idf.idf || idf;
    this.stopwords = new Set(stopwords);
    this.index = indexOf(model.features);
    this.supportColumns = model.features
      .map((name, i) => (name.endsWith('_support') ? i : -1))
      .filter((i) => i >= 0);
  }

  /** Tokenise a synopsis the same way the Python side does. */
  tokenize(text) {
    const out = [];
    for (const token of (text || '').toLowerCase().matchAll(TOKEN)) {
      const word = token[0];
      if (word.length >= MIN_TOKEN && !this.stopwords.has(word)) out.push(word);
    }
    return out;
  }

  /** L2-normalised tf-idf vector for one synopsis, as a Map. */
  textVector(text) {
    const counts = new Map();
    for (const term of this.tokenize(text)) {
      if (this.idf[term] === undefined) continue;
      counts.set(term, (counts.get(term) || 0) + 1);
    }
    const vector = new Map();
    let norm = 0;
    for (const [term, count] of counts) {
      // Sublinear tf, matching the Python.
      const value = (1 + Math.log(count)) * this.idf[term];
      vector.set(term, value);
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [term, value] of vector) vector.set(term, value / norm);
    return vector;
  }

  /**
   * Build a taste profile from rated films.
   * `rated` is [{rating, year, entities: {director: [...], ...}, synopsis}].
   */
  buildProfile(rated) {
    const ratings = rated.map((f) => f.rating);
    const mean = ratings.reduce((a, b) => a + b, 0) / (ratings.length || 1);
    const variance =
      ratings.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (ratings.length || 1);

    // facet -> entity -> [sum of centred ratings, count]
    const stats = {};
    for (const facet of FACETS) stats[facet] = new Map();

    const textProfile = new Map();
    const years = [];
    for (const film of rated) {
      const centred = film.rating - mean;
      const entities = withDerived(film);
      for (const facet of FACETS) {
        for (const entity of entities[facet] || []) {
          const slot = stats[facet].get(entity) || [0, 0];
          slot[0] += centred;
          slot[1] += 1;
          stats[facet].set(entity, slot);
        }
      }
      if (Number.isFinite(film.year)) years.push([film.year, centred]);
      if (film.synopsis) {
        for (const [term, value] of this.textVector(film.synopsis)) {
          textProfile.set(term, (textProfile.get(term) || 0) + centred * value);
        }
      }
    }

    const genreVector = new Map();
    for (const [entity, [total, count]] of stats.genre) {
      genreVector.set(entity, total / count);
    }

    return {
      mean,
      count: rated.length,
      std: Math.sqrt(variance),
      stats,
      years,
      genreVector,
      genreNorm: Math.sqrt(
        [...genreVector.values()].reduce((sum, v) => sum + v * v, 0)
      ),
      textProfile,
      textNorm: Math.sqrt(
        [...textProfile.values()].reduce((sum, v) => sum + v * v, 0)
      ),
    };
  }

  /** Gaussian-weighted affinity on a numeric axis - films near in years count more. */
  yearAffinity(profile, year) {
    if (!Number.isFinite(year) || profile.years.length === 0) return [0, 0];
    let total = 0;
    let weight = 0;
    for (const [filmYear, centred] of profile.years) {
      const w = Math.exp(-(((filmYear - year) / YEAR_SIGMA) ** 2));
      total += w * centred;
      weight += w;
    }
    if (weight <= 0) return [0, 0];
    return [total / (weight + SHRINKAGE), Math.log1p(weight)];
  }

  genreCosine(profile, entities) {
    const genres = entities.genre || [];
    if (!genres.length || profile.genreNorm === 0) return 0;
    let shared = 0;
    for (const genre of genres) shared += profile.genreVector.get(genre) || 0;
    return shared / (Math.sqrt(genres.length) * profile.genreNorm);
  }

  /**
   * Overlap-weighted mean of the person's ratings on films that share entities.
   * `entities` must already carry the derived facets - use withDerived().
   */
  facetAffinity(profile, entities, facet) {
    let total = 0;
    let weight = 0;
    for (const entity of (entities && entities[facet]) || []) {
      const slot = profile.stats[facet].get(entity);
      if (slot) {
        total += slot[0];
        weight += slot[1];
      }
    }
    if (weight <= 0) return [0, 0];
    // Shrink toward neutral: one shared actor is not an opinion.
    return [total / (weight + SHRINKAGE), Math.log1p(weight)];
  }

  textSimilarity(profile, synopsis) {
    if (!synopsis || profile.textNorm === 0) return 0;
    let dot = 0;
    for (const [term, value] of this.textVector(synopsis)) {
      const weight = profile.textProfile.get(term);
      if (weight) dot += weight * value;
    }
    return dot / profile.textNorm;
  }

  /** Has the person rated anyone who worked on this film? */
  peopleSupport(profile, entities) {
    return PEOPLE.reduce(
      (total, facet) => total + this.facetAffinity(profile, entities, facet)[1],
      0
    );
  }

  /** Features in the exact order the model expects. */
  features(profile, film) {
    const entities = withDerived(film);
    const row = new Array(this.model.features.length).fill(0);
    const set = (name, value) => {
      const index = this.index.get(name);
      if (index !== undefined) row[index] = value;
    };

    for (const facet of FACETS) {
      const [affinity, support] = this.facetAffinity(profile, entities, facet);
      set(`${facet}_aff`, affinity);
      set(`${facet}_support`, support);
    }

    const [yearAff, yearSupport] = this.yearAffinity(profile, numericYear(film));
    set('year_aff', yearAff);
    set('year_support', yearSupport);
    set('genre_cosine', this.genreCosine(profile, entities));
    set('n_train_log', Math.log1p(profile.count));
    set('user_rating_std', profile.std);
    set('text_sim', this.textSimilarity(profile, film.synopsis));
    return row;
  }

  /** Predicted rating on the person's own scale. */
  predict(profile, film) {
    const { center, scale, weights, rating_range: range } = this.model;
    const row = this.features(profile, film);

    let deviation = 0;
    for (let i = 0; i < row.length; i++) {
      deviation += ((row[i] - center[i]) / scale[i]) * weights[i];
    }

    // With nothing known about a film, say nothing. Standardised features make
    // "no evidence" a specific point rather than a neutral one, which had
    // unknown shorts programmes outranking films the person would love.
    const shrinkage = this.model.evidence_shrinkage || 0;
    if (shrinkage > 0) {
      const evidence = this.supportColumns.reduce((sum, i) => sum + row[i], 0);
      deviation *= evidence / (evidence + shrinkage);
    }

    return Math.min(Math.max(profile.mean + deviation, range[0]), range[1]);
  }

  /**
   * Score a slate, with the reasons that drove each score.
   * The explanations are read off the features, not generated, so they
   * cannot claim anything the model didn't actually use.
   */
  scoreSlate(profile, films) {
    return films
      .map((film) => {
        const prediction = this.predict(profile, film);
        return {
          ...film,
          prediction,
          reasons: this.explain(profile, film),
          confidence: this.confidence(profile, film),
        };
      })
      .sort((a, b) => b.prediction - a.prediction);
  }

  /** Which people the person has history with, and how they rated them. */
  explain(profile, film) {
    const reasons = [];
    for (const facet of PEOPLE) {
      for (const entity of film.entities?.[facet] || []) {
        const slot = profile.stats[facet].get(entity);
        if (!slot || slot[1] === 0) continue;
        reasons.push({
          facet,
          name: entity,
          films: slot[1],
          average: profile.mean + slot[0] / slot[1],
        });
      }
    }
    reasons.sort((a, b) => b.films - a.films || b.average - a.average);

    const keywords = (film.entities?.keyword || []).filter((k) =>
      profile.stats.keyword.has(k)
    );

    // For a premiere by people you've never seen, genre is most of what the
    // score rests on, so it belongs in the explanation.
    const genres = [];
    for (const genre of withDerived(film).genre) {
      const slot = profile.stats.genre.get(genre);
      if (slot && slot[1] >= 3) {
        genres.push({
          name: genre,
          films: slot[1],
          average: profile.mean + slot[0] / slot[1],
        });
      }
    }
    genres.sort((a, b) => b.average - a.average);

    return {
      people: reasons.slice(0, 3),
      keywords: keywords.slice(0, 4),
      genres: genres.slice(0, 2),
    };
  }

  /**
   * How much evidence sits behind this particular score. With no shared
   * people or keywords, a prediction is barely more than the person's average.
   */
  confidence(profile, film) {
    const entities = withDerived(film);
    // Genre and decade match almost everything, so they say little about how
    // much is really known here. Confidence tracks the specific signals.
    const evidence = ['director', 'writer', 'cast', 'keyword'].reduce(
      (total, facet) => total + this.facetAffinity(profile, entities, facet)[1],
      0
    );
    if (evidence >= 3) return 'high';
    if (evidence >= 1.5) return 'medium';
    return 'low';
  }
}

/**
 * How much the recommendations can be trusted overall, from profile size.
 * The thresholds come from the measured results in README.md, not from taste.
 */
export function profileStrength(count) {
  if (count < 15) {
    return {
      level: 'too-small',
      headline: 'Not enough ratings',
      detail: `${count} ratings. Below 15 there isn't enough to work from, so the picks would be guesswork.`,
    };
  }
  if (count < 30) {
    return {
      level: 'weak',
      headline: 'Rough picks only',
      detail: `${count} ratings. In testing, profiles this size scored barely better than assuming you like everything equally. Treat the order as a hint.`,
    };
  }
  if (count < 76) {
    return {
      level: 'fair',
      headline: 'Reasonable picks',
      detail: `${count} ratings. Testing showed a real but modest gain at this size - the top picks averaged about 0.2 stars better than picking blind.`,
    };
  }
  if (count < 201) {
    return {
      level: 'good',
      headline: 'Solid picks',
      detail: `${count} ratings. Testing showed the top picks averaged about 0.34 stars better than picking blind.`,
    };
  }
  return {
    level: 'strong',
    headline: 'Strong picks',
    detail: `${count} ratings. This is the range where the recommender did best - top picks averaged about 0.73 stars better than picking blind.`,
  };
}
