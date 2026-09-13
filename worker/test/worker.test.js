/**
 * The Worker end to end, with KV and Turnstile faked. Exercises the things
 * that matter for staying free and staying safe: bot check first, size caps,
 * daily and total limits, and no route that reads data back.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import worker from '../src/index.js';
import { USAGE_KEY } from '../src/usage.js';

const ORIGIN = 'https://mostmetaphorical.github.io';

class FakeKV {
  constructor() {
    this.data = new Map();
  }
  async get(key, type) {
    const entry = this.data.get(key);
    if (!entry) return null;
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }
  async put(key, value, options = {}) {
    this.data.set(key, { value, metadata: options.metadata });
  }
  keys(prefix) {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix));
  }
}

let env;
let turnstileAnswer;

beforeEach(() => {
  env = {
    SHARES: new FakeKV(),
    TURNSTILE_SECRET: 'test-secret',
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8124`,
    MAX_UPLOAD_BYTES: '1000000',
    MAX_TOTAL_BYTES: '900000000',
    MAX_UPLOADS_PER_DAY: '300',
  };
  turnstileAnswer = { success: true };
  globalThis.fetch = async (url) => {
    assert.match(String(url), /challenges\.cloudflare\.com/);
    return new Response(JSON.stringify(turnstileAnswer));
  };
});

const ratingsCSV = (n = 40) =>
  ['Name,Year,Rating', ...Array.from({ length: n }, (_, i) => `Film ${i},2000,4`)].join('\n');

function post(path, body, { origin = ORIGIN, token = 'token', type = 'text/csv' } = {}) {
  const headers = { 'Content-Type': type };
  if (origin) headers.Origin = origin;
  if (token) headers['CF-Turnstile-Response'] = token;
  return worker.fetch(
    new Request(`https://share.example${path}`, { method: 'POST', headers, body }),
    env
  );
}

test('a valid ratings upload is stored under a random id, rebuilt', async () => {
  const response = await post('/ratings', ratingsCSV());
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.rows, 40);

  const keys = env.SHARES.keys('ratings/');
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^ratings\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.csv$/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('no bot-check token means nothing is read or stored', async () => {
  const response = await post('/ratings', ratingsCSV(), { token: null });
  assert.equal(response.status, 403);
  assert.equal(env.SHARES.keys('ratings/').length, 0);
});

test('a failed bot check is refused', async () => {
  turnstileAnswer = { success: false };
  const response = await post('/ratings', ratingsCSV());
  assert.equal(response.status, 403);
  assert.equal(env.SHARES.keys('ratings/').length, 0);
});

test('uploads from other websites are refused', async () => {
  for (const origin of ['https://evil.example', null]) {
    const response = await post('/ratings', ratingsCSV(), { origin });
    assert.equal(response.status, 403, `origin ${origin}`);
  }
  assert.equal(env.SHARES.keys('ratings/').length, 0);
});

test('an oversized upload is refused even if it lies about its size', async () => {
  env.MAX_UPLOAD_BYTES = '5000';
  const response = await post('/ratings', ratingsCSV(1000));
  assert.equal(response.status, 413);
  assert.equal(env.SHARES.keys('ratings/').length, 0);
});

test('invalid content is refused with a reason and nothing is stored', async () => {
  const response = await post('/ratings', 'this,is\nnot,ratings');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /columns/);
  assert.equal(env.SHARES.keys('ratings/').length, 0);
});

test('sharing pauses at the daily limit', async () => {
  env.MAX_UPLOADS_PER_DAY = '2';
  assert.equal((await post('/ratings', ratingsCSV())).status, 201);
  assert.equal((await post('/ratings', ratingsCSV())).status, 201);
  const third = await post('/ratings', ratingsCSV());
  assert.equal(third.status, 429);
  assert.equal(env.SHARES.keys('ratings/').length, 2);
});

test('sharing pauses when the storage budget is used up', async () => {
  env.MAX_TOTAL_BYTES = '600';
  const response = await post('/ratings', ratingsCSV());
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /paused/);
  assert.equal(env.SHARES.keys('ratings/').length, 0);
});

test('usage survives across days: bytes carry on, the daily count resets', async () => {
  await env.SHARES.put(USAGE_KEY, JSON.stringify({ bytes: 1234, day: '2000-01-01', uploadsToday: 300 }));
  const response = await post('/ratings', ratingsCSV());
  assert.equal(response.status, 201);
  const usage = await env.SHARES.get(USAGE_KEY, 'json');
  assert.equal(usage.uploadsToday, 1);
  assert.ok(usage.bytes > 1234);
});

test('status reports open or paused', async () => {
  const open = await worker.fetch(new Request('https://share.example/status'), env);
  assert.deepEqual(await open.json(), { open: true, reason: null });

  env.MAX_TOTAL_BYTES = '0';
  const paused = await worker.fetch(new Request('https://share.example/status'), env);
  assert.equal((await paused.json()).open, false);
});

test('a valid festival is accepted and stored for review', async () => {
  const festival = {
    festival: 'Some Fest',
    films: [{ title: 'A Film' }],
    screenings: [{ film: 'A Film', date: '2027-03-04', time: '7:30 PM' }],
  };
  const response = await post('/festival', JSON.stringify(festival), { type: 'application/json' });
  assert.equal(response.status, 201);
  assert.equal(env.SHARES.keys('festival/').length, 1);
});

test('there is no way to read anything back', async () => {
  await post('/ratings', ratingsCSV());
  const key = env.SHARES.keys('ratings/')[0];
  for (const path of [`/${key}`, '/ratings', '/festival', '/usage', '/list']) {
    const response = await worker.fetch(new Request(`https://share.example${path}`), env);
    assert.notEqual(response.status, 200, `GET ${path} returned data`);
  }
});

test('internal errors are not echoed to the caller', async () => {
  env.SHARES.get = async () => {
    throw new Error('secret internal detail');
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await post('/ratings', ratingsCSV());
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /secret internal detail/);
  } finally {
    console.error = originalError;
  }
});
