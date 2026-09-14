/**
 * The browser half of the diagnostic: the model as it actually ships.
 *
 *   node diagnose_js.mjs [exports/]
 *
 * 1. Parity - app/js/recommend.js with app/data/model.json against the Python
 *    predictions diagnose.py wrote for the same user and films.
 * 2. Latency - loading the artifacts, building a profile, scoring a slate.
 * 3. Cold start - what a profile with zero or one rating produces.
 * 4. The festival slate - how spread out predictions are for real profiles,
 *    resolved through the shipped library exactly as the app does it.
 *
 * Rating exports are personal data: only aggregate numbers are printed.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Recommender } from './app/js/recommend.js';
import { BundleProvider, resolveLibrary } from './app/js/metadata.js';
import { readRatings } from './app/js/letterboxd.js';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const report = {};

// ---------------------------------------------------------------- 2a. loading
let t = performance.now();
const model = read('app/data/model.json');
const idf = read('app/data/idf.json');
const stopwords = read('app/data/stopwords.json');
const loadModelMs = performance.now() - t;
t = performance.now();
const library = read('app/data/library.json');
const loadLibraryMs = performance.now() - t;
const recommender = new Recommender(model, idf, stopwords);
report.load_ms = { model_idf_stopwords: loadModelMs, library: loadLibraryMs, library_films: library.films.length };

// ---------------------------------------------------------------- 1. parity
const input = read('results/diagnose/js_input.json');
const profile = recommender.buildProfile(input.rated);
const jsPredictions = input.candidates.map((film) => recommender.predict(profile, film));
const diffs = jsPredictions.map((p, i) => Math.abs(p - input.python_predictions[i]));
report.parity = {
  candidates: diffs.length,
  max_abs_diff: Math.max(...diffs),
  mean_abs_diff: diffs.reduce((a, b) => a + b, 0) / diffs.length,
  share_within_1e6: diffs.filter((d) => d < 1e-6).length / diffs.length,
};

// ---------------------------------------------------------------- 2b. latency
const timeIt = (fn, runs = 30) => {
  fn(); // warm up
  const out = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    out.push(performance.now() - start);
  }
  return { median: median(out), p90: pct(out, 0.9), runs };
};
const festival = read('app/data/festival.json');
const slate = festival.films.filter((f) => f.scoreable !== false);
const libraryFilms = library.films.map((f) => ({ ...f, entities: f }));
report.latency_ms = {
  build_profile: { rated: input.rated.length, ...timeIt(() => recommender.buildProfile(input.rated)) },
  festival_top10: {
    films: slate.length,
    ...timeIt(() => recommender.scoreSlate(recommender.buildProfile(input.rated), slate).slice(0, 10)),
  },
  library_top10: {
    films: libraryFilms.length,
    ...timeIt(() => recommender.scoreSlate(profile, libraryFilms).slice(0, 10), 5),
  },
};

// ---------------------------------------------------------------- 3. cold start
const zero = recommender.buildProfile([]);
const one = recommender.buildProfile([input.rated[0]]);
report.cold_start = {
  zero_ratings: {
    profile_mean: zero.mean,
    predictions: slate.slice(0, 5).map((f) => recommender.predict(zero, f)),
  },
  one_rating: {
    rating: input.rated[0].rating,
    profile_mean: one.mean,
    distinct_predictions: new Set(slate.map((f) => recommender.predict(one, f).toFixed(3))).size,
  },
};

// ---------------------------------------------------------------- 4. festival spread
async function slateSpread(label, text) {
  const { ratings } = readRatings(text);
  const { resolved } = await resolveLibrary(ratings, new BundleProvider(library));
  const person = recommender.buildProfile(resolved);
  const scored = recommender.scoreSlate(person, slate);
  const predictions = scored.map((f) => f.prediction);
  const deviations = predictions.map((p) => p - person.mean);
  const withSynopsis = resolved.filter((f) => f.synopsis).length;
  const supported = slate.filter((f) => {
    const row = recommender.features(person, f);
    return recommender.supportColumns.reduce((s, i) => s + row[i], 0) > 0;
  }).length;
  const textSims = slate.map((f) => recommender.textSimilarity(person, f.synopsis));
  return {
    label,
    ratings: ratings.length,
    matched: resolved.length,
    matched_with_synopsis: withSynopsis,
    slate: slate.length,
    films_with_any_evidence: supported,
    text_sim_nonzero: textSims.filter((x) => x !== 0).length,
    prediction_min: Math.min(...predictions),
    prediction_max: Math.max(...predictions),
    prediction_std: Math.sqrt(deviations.reduce((s, d) => s + d * d, 0) / deviations.length -
      (deviations.reduce((s, d) => s + d, 0) / deviations.length) ** 2),
    share_within_0_1_of_mean: deviations.filter((d) => Math.abs(d) < 0.1).length / deviations.length,
    distinct_one_decimal: new Set(predictions.map((p) => p.toFixed(1))).size,
  };
}

report.festival = [await slateSpread('demo profile', readFileSync('app/fixtures/demo-ratings.csv', 'utf8'))];
const exportsDir = process.argv[2];
if (exportsDir && existsSync(exportsDir)) {
  let n = 0;
  for (const name of readdirSync(exportsDir).filter((f) => f.endsWith('.csv')).sort()) {
    n += 1;
    // Anonymous label: these are people's own histories.
    report.festival.push(await slateSpread(`real export ${n}`, readFileSync(join(exportsDir, name), 'utf8')));
  }
}

writeFileSync('results/diagnose/js_report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
