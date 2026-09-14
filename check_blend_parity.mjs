/**
 * Browser half of the blend parity check: app/js/blend.js on the inputs
 * check_blend_parity.py wrote, compared component by component.
 *
 *   python check_blend_parity.py && node check_blend_parity.mjs
 */

import { readFileSync } from 'node:fs';
import { BlendRecommender } from './app/js/blend.js';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const input = read('results/blend_parity.json');
const recommender = new BlendRecommender(
  read('app/data/model.json'),
  read('app/data/idf.json'),
  read('app/data/stopwords.json'),
  { genreModel: read('app/data/model-genre.json'), blend: read('app/data/blend.json'), track: read('app/data/track.json') }
);

const profile = recommender.buildProfile(input.rated);
const report = { base: [profile.base, input.base] };
const worst = {};
for (const [n, film] of input.candidates.entries()) {
  const parts = recommender.components(profile, film);
  parts.final = recommender.predict(profile, film);
  for (const [name, value] of Object.entries(parts)) {
    if (name === 'base') continue;
    const expected = input.python[name][n];
    if (value === null && expected === null) continue;
    const diff = Math.abs((value ?? NaN) - (expected ?? NaN));
    worst[name] = Math.max(worst[name] ?? 0, Number.isNaN(diff) ? Infinity : diff);
  }
}
report.max_abs_diff = worst;
console.log(JSON.stringify(report, null, 2));
// The synopsis word weights ship rounded to 4 decimals; the text feature's
// small scale magnifies that to a few thousandths of a star in the ridge.
const TOLERANCE = 0.005;
const failing = Object.entries(worst).filter(([, d]) => !(d < TOLERANCE));
if (failing.length) {
  console.error('PARITY FAIL:', failing);
  process.exit(1);
}
console.log('parity ok');
