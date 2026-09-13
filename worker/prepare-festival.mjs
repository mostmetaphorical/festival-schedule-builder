/**
 * Turn a stored festival submission into files for a pull request.
 *
 *   node worker/prepare-festival.mjs <submission.json> [repo root]
 *
 * Re-validates with the Worker's rules, writes app/data/festivals/<slug>.json,
 * and adds or replaces its entry in app/data/festivals.json. Prints the slug.
 * The index entry's city is left as a placeholder on purpose: filling it in is
 * part of the human review.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { validateFestival } from './src/festival.js';

const [submission, root = process.cwd()] = process.argv.slice(2);
if (!submission) {
  console.error('usage: node worker/prepare-festival.mjs <submission.json> [repo root]');
  process.exit(2);
}

const { summary, ...festival } = validateFestival(
  JSON.parse(readFileSync(submission, 'utf8'))
);

const slug = festival.festival
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
if (!slug) throw new Error('The festival name produces an empty file name.');

const dataDir = join(root, 'app', 'data', 'festivals');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, `${slug}.json`), `${JSON.stringify(festival, null, 2)}\n`);

const indexPath = join(root, 'app', 'data', 'festivals.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
index.festivals = index.festivals.filter((entry) => entry.id !== slug);
index.festivals.unshift({
  id: slug,
  name: festival.festival,
  city: 'CHECK AND FILL IN',
  starts: summary.from,
  ends: summary.to,
  data: `data/festivals/${slug}.json`,
  status: 'ready',
  source: 'Shared through the app - check against the official schedule',
});
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

console.log(slug);
