/**
 * Validate every festival file the app can load, with the same rules the
 * share Worker applies. Run in CI on every pull request, so a festival added
 * by hand gets exactly the scrutiny of one shared through the app.
 *
 *   node worker/validate-festivals.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateFestival } from './src/festival.js';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const index = JSON.parse(readFileSync(join(app, 'data', 'festivals.json'), 'utf8'));

let failures = 0;
for (const entry of index.festivals) {
  if (entry.status !== 'ready') continue;
  if (!entry.data) {
    console.error(`FAIL ${entry.id}: marked ready but has no data file`);
    failures++;
    continue;
  }
  try {
    const data = JSON.parse(readFileSync(join(app, entry.data), 'utf8'));
    const { summary } = validateFestival(data);
    if (JSON.stringify(data).includes('commitments')) {
      throw new Error('contains commitments - personal schedules must never be published');
    }
    console.log(
      `ok   ${entry.id}: ${summary.films} films, ${summary.screenings} screenings, ` +
        `${summary.from} to ${summary.to}`
    );
  } catch (error) {
    console.error(`FAIL ${entry.id}: ${error.message}`);
    failures++;
  }
}

process.exit(failures ? 1 : 0);
