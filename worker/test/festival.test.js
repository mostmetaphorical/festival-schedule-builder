import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { validateFestival } from '../src/festival.js';
import { RejectedUpload } from '../src/ratings.js';

const minimal = () => ({
  festival: 'Some Fest 2027',
  films: [
    {
      title: 'A Film',
      year: 2027,
      runtime: 94,
      synopsis: 'One or two sentences.',
      entities: { director: ['A Director'], cast: ['An Actor'], genre: ['horror'] },
    },
  ],
  screenings: [{ film: 'A Film', date: '2027-03-04', time: '7:30 PM', runtime: 94 }],
});

const rejects = (data, pattern) =>
  assert.throws(
    () => validateFestival(data),
    (error) => error instanceof RejectedUpload && pattern.test(error.message)
  );

test('a minimal festival passes and is summarised', () => {
  const result = validateFestival(minimal());
  assert.equal(result.summary.films, 1);
  assert.deepEqual(result.days, ['2027-03-04']);
});

test('the real Fantastic Fest file passes', () => {
  const real = JSON.parse(
    readFileSync(new URL('../../app/data/festival.json', import.meta.url), 'utf8')
  );
  const result = validateFestival(real);
  assert.ok(result.summary.films > 50);
});

test('unknown fields are dropped from the rebuild', () => {
  const data = minimal();
  data.films[0].onload = 'steal()';
  data.films[0].entities.director.push('Another');
  data.extra = { anything: true };
  data.screenings[0].script = 'x';
  const result = validateFestival(data);
  assert.equal(result.films[0].onload, undefined);
  assert.equal(result.extra, undefined);
  assert.equal(result.screenings[0].script, undefined);
});

test('markup in any text field is refused', () => {
  const data = minimal();
  data.films[0].synopsis = 'Nice film <img src=x onerror=alert(1)>';
  rejects(data, /aren't allowed/);

  const titled = minimal();
  titled.films[0].title = '<b>Bold</b>';
  titled.screenings[0].film = '<b>Bold</b>';
  rejects(titled, /aren't allowed/);
});

test('posters must be plain https addresses', () => {
  const poster = (value) => {
    const data = minimal();
    data.films[0].poster = value;
    return validateFestival(data).films[0].poster;
  };
  const festivalCdn = 'https://images.somefest.example/posters/a-film.jpg?w=400';
  assert.equal(poster(festivalCdn), festivalCdn);

  for (const bad of [
    'http://images.somefest.example/a.jpg',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'https://user:pass@images.somefest.example/a.jpg',
    'https://images.somefest.example/a.jpg" onerror="alert(1)',
    'https://images.somefest.example/<a>.jpg',
    `https://images.somefest.example/${'a'.repeat(600)}.jpg`,
    'https://localhost/a.jpg',
    '/relative/a.jpg',
  ]) {
    assert.equal(poster(bad), undefined, bad);
  }
});

test('the summary lists where posters come from, for the reviewer', () => {
  const data = minimal();
  data.films[0].poster = 'https://images.somefest.example/a.jpg';
  const { summary } = validateFestival(data);
  assert.equal(summary.posters, 1);
  assert.deepEqual(summary.posterHosts, ['images.somefest.example']);
});

test('screenings must name a film in the lineup', () => {
  const data = minimal();
  data.screenings[0].film = 'Different Film';
  rejects(data, /isn't in the lineup/);
});

test('dates and times must be real', () => {
  for (const date of ['2027-02-30', '04/03/2027', '2027-13-01', '']) {
    const data = minimal();
    data.screenings[0].date = date;
    assert.throws(() => validateFestival(data), RejectedUpload, `accepted date ${date}`);
  }
  for (const time of ['25:00', '13:30 PM', '7:75 PM', 'soon', '']) {
    const data = minimal();
    data.screenings[0].time = time;
    assert.throws(() => validateFestival(data), RejectedUpload, `accepted time ${time}`);
  }
});

test('duplicate titles are refused', () => {
  const data = minimal();
  data.films.push({ ...data.films[0] });
  rejects(data, /appears twice/);
});

test('oversized lists and wrong types are refused', () => {
  const lists = minimal();
  lists.films[0].entities.cast = Array.from({ length: 51 }, (_, i) => `Actor ${i}`);
  rejects(lists, /more than 50/);

  const types = minimal();
  types.films[0].runtime = '94';
  rejects(types, /whole number/);

  assert.throws(() => validateFestival([]), /JSON object/);
  assert.throws(() => validateFestival(null), /JSON object/);
});
