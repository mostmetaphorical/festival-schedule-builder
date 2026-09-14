/**
 * How spread out predictions are on real festival slates, ridge versus blend.
 *
 *   node check_slate_spread.mjs [exports/]
 *
 * Profiles are resolved through the shipped library exactly as the app does.
 * Rating exports are personal: only aggregates are printed.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BlendRecommender } from './app/js/blend.js';
import { Recommender } from './app/js/recommend.js';
import { BundleProvider, resolveLibrary } from './app/js/metadata.js';
import { readRatings } from './app/js/letterboxd.js';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const model = read('app/data/model.json');
const idf = read('app/data/idf.json');
const stopwords = read('app/data/stopwords.json');
const ridge = new Recommender(model, idf, stopwords);
const blend = new BlendRecommender(model, idf, stopwords, {
  genreModel: read('app/data/model-genre.json'),
  blend: read('app/data/blend.json'),
  track: read('app/data/track.json'),
});
const library = new BundleProvider(read('app/data/library.json'));

const stats = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    std: +std.toFixed(3),
    range: [+sorted[0].toFixed(2), +sorted[sorted.length - 1].toFixed(2)],
    p10_p90: [+sorted[Math.floor(xs.length * 0.1)].toFixed(2), +sorted[Math.floor(xs.length * 0.9)].toFixed(2)],
    distinct_one_decimal: new Set(xs.map((x) => x.toFixed(1))).size,
  };
};

const profiles = [['demo profile', readFileSync('app/fixtures/demo-ratings.csv', 'utf8')]];
const dir = process.argv[2];
if (dir && existsSync(dir)) {
  readdirSync(dir).filter((f) => f.endsWith('.csv')).sort()
    .forEach((f, n) => profiles.push([`real export ${n + 1}`, readFileSync(join(dir, f), 'utf8')]));
}

for (const [festival, path] of [['Fantastic Fest 2026', 'app/data/festival.json'], ['TIFF 2026', 'app/data/festivals/tiff-2026.json']]) {
  const slate = read(path).films.filter((f) => f.scoreable !== false);
  for (const [label, text] of profiles) {
    const { resolved } = await resolveLibrary(readRatings(text).ratings, library);
    const withCf = resolved.filter((f) => f.cf).length;
    const pr = ridge.buildProfile(resolved);
    const t = performance.now();
    const pb = blend.buildProfile(resolved);
    const scored = blend.scoreSlate(pb, slate);
    const ms = performance.now() - t;
    console.log(JSON.stringify({
      festival, profile: label, rated: resolved.length, rated_with_factors: withCf, slate: slate.length,
      ridge: stats(slate.map((f) => ridge.predict(pr, f))),
      blend: stats(scored.map((f) => f.prediction)),
      blend_ms: Math.round(ms),
    }));
  }
}
