/**
 * The cold-item blend, in the browser.
 *
 * Four predictions of how someone would rate a film nobody has rated yet, plus
 * the track record of the people behind it, combined with weights learned by
 * cross-validation (export_blend.py; tested by run_blend.py):
 *
 *   content ridge  taste overlap with credits, keywords and synopsis (recommend.js)
 *   genre ridge    the same idea over genre, era and themes
 *   content kNN    how they rated the films that read most like this one
 *   content MF     their crowd-style taste vector, fitted from their ratings,
 *                  against this film's content-predicted factors
 *   track record   how the crowd rated earlier films by this director, writer,
 *                  cast, editor, cinematographer - and by these collaborations
 *
 * This mirrors festrec_eval/serve.py. Change one side, change both.
 */

import { Recommender } from './recommend.js';

const RANGE = [0.5, 5.0];
const clip = (x) => Math.min(Math.max(x, RANGE[0]), RANGE[1]);
const CAST_DEPTH = 5;

/** Track-record entities: single credits and crew combinations (serve.credit_entities). */
export function creditEntities(entities = {}) {
  const names = (facet) => [...new Set(entities[facet] || [])];
  const out = {};
  for (const facet of ['director', 'writer', 'keyword', 'genre', 'editor', 'cinematographer']) {
    out[facet] = names(facet);
  }
  out.cast = names('cast').slice(0, CAST_DEPTH);
  const d = out.director;
  const e = out.editor;
  const c = out.cinematographer;
  out['director+editor'] = d.flatMap((x) => e.map((y) => `${x}|${y}`));
  out['director+cinematographer'] = d.flatMap((x) => c.map((y) => `${x}|${y}`));
  out['editor+cinematographer'] = e.flatMap((x) => c.map((y) => `${x}|${y}`));
  out['director+editor+cinematographer'] = d.flatMap((x) => e.flatMap((y) => c.map((z) => `${x}|${y}|${z}`)));
  return out;
}

/** Solve A x = b for a small dense system (Gaussian elimination with pivoting). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const p = M[col][col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let k = r + 1; k < n; k++) sum -= M[r][k] * x[k];
    x[r] = sum / (M[r][r] || 1e-12);
  }
  return x;
}

export class BlendRecommender extends Recommender {
  constructor(model, idf, stopwords, { genreModel, blend, track }) {
    super(model, idf, stopwords);
    this.genre = new Recommender(genreModel, idf, stopwords);
    this.blend = blend;
    this.track = track;
  }

  /** Cosine-ready content vector: synopsis tf-idf and credit blocks, each normalised (serve.ContentSpace). */
  contentVector(film) {
    const blocks = [];
    const text = this.textVector(film.synopsis);
    if (text.size) blocks.push([...text].map(([term, value]) => [`t${term}`, value]));
    const entities = film.entities || {};
    for (const facet of this.blend.content_facets) {
      const names = [...new Set(entities[facet] || [])];
      if (!names.length) continue;
      const value = 1 / Math.sqrt(names.length);
      blocks.push(names.map((name) => [`${facet}${name}`, value]));
    }
    const vector = new Map();
    if (!blocks.length) return vector;
    const scale = 1 / Math.sqrt(blocks.length);
    for (const block of blocks) {
      for (const [key, value] of block) vector.set(key, (vector.get(key) || 0) + value * scale);
    }
    return vector;
  }

  buildProfile(rated) {
    const profile = super.buildProfile(rated);
    profile.genreProfile = this.genre.buildProfile(rated);
    profile.base = this.base(profile);
    profile.neighbours = rated.map((film) => ({
      vector: this.contentVector(film),
      residual: film.rating - profile.base,
    }));
    profile.taste = this.foldIn(rated);
    return profile;
  }

  /** A person's bias and factors against the content-predicted factors of what they rated (serve.fold_in). */
  foldIn(rated) {
    const items = rated.filter((film) => Array.isArray(film.cf) && film.cf.length === this.blend.mf.factors + 1);
    if (!items.length) return null;
    const { mu, fold_reg: foldReg, user_reg: userReg, iters, factors: k } = this.blend.mf;
    const n = items.length;
    const QtQ = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const film of items) {
      for (let a = 0; a < k; a++) {
        const qa = film.cf[a + 1];
        for (let b = 0; b < k; b++) QtQ[a][b] += qa * film.cf[b + 1];
      }
    }
    for (let a = 0; a < k; a++) QtQ[a][a] += foldReg * n;
    let bias = 0;
    let p = new Array(k).fill(0);
    for (let it = 0; it < iters; it++) {
      let sum = 0;
      for (const film of items) {
        let dot = 0;
        for (let a = 0; a < k; a++) dot += film.cf[a + 1] * p[a];
        sum += film.rating - mu - film.cf[0] - dot;
      }
      bias = sum / (n + userReg);
      const rhs = new Array(k).fill(0);
      for (const film of items) {
        const target = film.rating - mu - bias - film.cf[0];
        for (let a = 0; a < k; a++) rhs[a] += film.cf[a + 1] * target;
      }
      p = solve(QtQ, rhs);
    }
    return { bias, p };
  }

  knnPredict(profile, film) {
    const { k, damping, power } = this.blend.knn;
    const vector = this.contentVector(film);
    if (!vector.size) return profile.base;
    const scored = [];
    for (const neighbour of profile.neighbours) {
      const [small, large] = vector.size < neighbour.vector.size ? [vector, neighbour.vector] : [neighbour.vector, vector];
      let dot = 0;
      for (const [key, value] of small) {
        const other = large.get(key);
        if (other) dot += value * other;
      }
      if (dot > 0) scored.push([dot ** power, neighbour.residual]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    let top = 0;
    let weight = 0;
    for (const [s, residual] of scored.slice(0, k)) {
      top += s * residual;
      weight += s;
    }
    return profile.base + top / (weight + damping);
  }

  mfPredict(profile, film) {
    if (!profile.taste || !Array.isArray(film.cf) || film.cf.length !== this.blend.mf.factors + 1) return null;
    let dot = 0;
    for (let a = 0; a < this.blend.mf.factors; a++) dot += profile.taste.p[a] * film.cf[a + 1];
    return this.blend.mf.mu + profile.taste.bias + film.cf[0] + dot;
  }

  /** Track-record features, named as blend.json names them. */
  trackFeatures(film) {
    const out = {};
    const entities = creditEntities(film.entities);
    const { tables, shrink } = this.track;
    for (const facet of this.track.facets) {
      let sum = 0;
      let count = 0;
      const table = tables[facet] || {};
      for (const name of entities[facet] || []) {
        const entry = table[name];
        if (entry) {
          sum += entry[0];
          count += entry[1];
        }
      }
      out[`track:${facet}:mean`] = sum / (count + shrink);
      out[`track:${facet}:log_count`] = Math.log1p(Math.max(count, 0));
    }
    return out;
  }

  /** Every component on its own - kept for explanations and the diagnostic. */
  components(profile, film) {
    const base = profile.base;
    const mf = this.mfPredict(profile, film);
    return {
      base,
      content_ridge: clip(super.predict(profile, film)),
      genre_ridge: clip(this.genre.predict(profile.genreProfile, film)),
      content_knn: clip(this.knnPredict(profile, film)),
      content_mf: mf === null ? null : clip(mf),
    };
  }

  predict(profile, film) {
    const parts = this.components(profile, film);
    const blend = parts.content_mf === null ? this.blend.blends.no_content_mf : this.blend.blends.full;
    const inputs = {
      ...this.trackFeatures(film),
      log_n: Math.log1p(profile.count),
    };
    for (const name of ['content_ridge', 'genre_ridge', 'content_knn', 'content_mf']) {
      if (parts[name] !== null) inputs[name] = parts[name] - parts.base;
    }
    let deviation = blend.intercept;
    blend.inputs.forEach((name, j) => {
      deviation += blend.weights[j] * ((inputs[name] - blend.mean[j]) / blend.std[j]);
    });
    return clip(parts.base + deviation);
  }
}
