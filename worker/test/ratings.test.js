import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeText,
  parseCSV,
  rebuildRatings,
  RejectedUpload,
  validateRatings,
} from '../src/ratings.js';

const NOW = new Date('2026-09-13T12:00:00Z');

function csv(rows, header = 'Name,Year,Rating') {
  return [header, ...rows].join('\n');
}

const goodRows = Array.from({ length: 40 }, (_, i) => `Film ${i},${1980 + i},${(i % 10) / 2 + 0.5}`);

const rejects = (fn, pattern) =>
  assert.throws(fn, (error) => error instanceof RejectedUpload && pattern.test(error.message));

test('a normal file passes', () => {
  const ratings = validateRatings(csv(goodRows), NOW);
  assert.equal(ratings.length, 40);
  assert.deepEqual(ratings[0], { name: 'Film 0', year: 1980, rating: 0.5 });
});

test('quoted titles with commas and quotes survive', () => {
  const rows = [...goodRows.slice(1), '"Usual Suspects, The",1995,4.5', '"The ""Burbs""",1989,3'];
  const ratings = validateRatings(csv(rows), NOW);
  assert.equal(ratings.at(-2).name, 'Usual Suspects, The');
  assert.equal(ratings.at(-1).name, 'The "Burbs"');
});

test('an empty year is allowed', () => {
  const ratings = validateRatings(csv([...goodRows.slice(1), 'Unknown Year,,3']), NOW);
  assert.equal(ratings.at(-1).year, null);
});

test('fewer than 30 ratings are refused, with the reason', () => {
  rejects(() => validateRatings(csv(goodRows.slice(0, 29)), NOW), /At least 30/);
});

test('a raw Letterboxd export (wrong columns) is refused', () => {
  const letterboxd = csv(
    goodRows.map((r) => `2026-01-01,${r},https://boxd.it/abc`),
    'Date,Name,Year,Letterboxd URI,Rating'
  );
  rejects(() => validateRatings(letterboxd, NOW), /Unexpected columns/);
});

test('ratings outside half stars are refused', () => {
  for (const bad of ['6', '0', '4.3', '-1', '5.5', 'NaN', '1e1', '']) {
    rejects(() => validateRatings(csv([...goodRows.slice(1), `X,2000,${bad}`]), NOW), /half stars/);
  }
});

test('impossible years are refused', () => {
  rejects(() => validateRatings(csv([...goodRows.slice(1), 'X,1500,3']), NOW), /outside/);
  rejects(() => validateRatings(csv([...goodRows.slice(1), 'X,2099,3']), NOW), /outside/);
  rejects(() => validateRatings(csv([...goodRows.slice(1), 'X,20xx,3']), NOW), /not a year/);
});

test('rows with the wrong number of fields are refused', () => {
  rejects(() => validateRatings(csv([...goodRows.slice(1), 'X,2000,3,extra']), NOW), /fields/);
});

test('very long titles are refused', () => {
  rejects(() => validateRatings(csv([...goodRows.slice(1), `${'a'.repeat(301)},2000,3`]), NOW), /1-300/);
});

test('malformed CSV is refused rather than guessed at', () => {
  assert.throws(() => parseCSV('Name,Year,Rating\n"unclosed,2000,3'), /never closed/);
  assert.throws(() => parseCSV('Name,Year,Rating\nab"cd,2000,3'), /quote in the middle/);
});

test('binary data is refused', () => {
  const zipHeader = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  assert.throws(() => decodeText(zipHeader), RejectedUpload);
  const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
  assert.throws(() => decodeText(invalidUtf8), /not a text file/);
});

test('a byte-order mark is stripped, not treated as data', () => {
  const text = decodeText(new TextEncoder().encode(`\uFEFF${csv(goodRows)}`));
  assert.equal(validateRatings(text, NOW).length, 40);
});

test('HTML and script in a title cannot reach the rebuilt file as markup-looking data', () => {
  // A title is just text: it is kept as text, quoted where needed, and the
  // app escapes it when rendering. What matters is the file stays a plain CSV.
  const rows = [...goodRows.slice(1), '<script>alert(1)</script>,2000,3'];
  const rebuilt = rebuildRatings(validateRatings(csv(rows), NOW));
  assert.equal(rebuilt.split('\n')[0], 'Name,Year,Rating');
  assert.equal(parseCSV(rebuilt).length, 41);
});

test('spreadsheet formulas are neutralised in the rebuilt file', () => {
  const rows = [
    ...goodRows.slice(4),
    '"=HYPERLINK(""http://evil.example"",""click"")",2000,3',
    '+cmd|calc,2000,3',
    '-2+3,2000,3',
    '@SUM(A1),2000,3',
  ];
  const rebuilt = rebuildRatings(validateRatings(csv(rows), NOW));
  const names = parseCSV(rebuilt).slice(1).map((row) => row[0]);
  for (const name of names.slice(-4)) {
    assert.ok(name.startsWith("'"), `not neutralised: ${name}`);
  }
});

test('the rebuilt file keeps only title, year and rating', () => {
  const rebuilt = rebuildRatings(validateRatings(csv(goodRows), NOW));
  const parsed = parseCSV(rebuilt);
  assert.deepEqual(parsed[0], ['Name', 'Year', 'Rating']);
  assert.ok(parsed.every((row) => row.length === 3));
});
