/**
 * The visit counter: one more for the day, nothing about the visitor, and a
 * failure never reaches the page.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker from '../src/index.js';

const ORIGIN = 'https://mostmetaphorical.github.io';

class FakeD1 {
  constructor() {
    this.counts = new Map();
    this.bound = [];
  }
  prepare(sql) {
    assert.match(sql, /INSERT INTO visits/);
    return {
      bind: (...values) => {
        this.bound.push(values);
        return {
          run: async () => {
            const [day] = values;
            this.counts.set(day, (this.counts.get(day) || 0) + 1);
          },
        };
      },
    };
  }
}

const makeEnv = (db = new FakeD1()) => ({
  VISITS: db,
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8124`,
});

const hit = (env, origin = ORIGIN, headers = {}) =>
  worker.fetch(
    new Request('https://share.example/hit', {
      method: 'POST',
      headers: { ...(origin ? { Origin: origin } : {}), ...headers },
    }),
    env
  );

test('each page load adds one to the day, and nothing else is kept', async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) {
    const response = await hit(env, ORIGIN, { 'User-Agent': 'Browser', 'CF-Connecting-IP': '203.0.113.9' });
    assert.equal(response.status, 204);
  }
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual([...env.VISITS.counts], [[today, 3]]);
  // The day is the only value ever written.
  assert.ok(env.VISITS.bound.every((values) => values.length === 1 && values[0] === today));
});

test('page loads from other websites are not counted', async () => {
  const env = makeEnv();
  const response = await hit(env, 'https://elsewhere.example');
  assert.equal(response.status, 403);
  assert.equal(env.VISITS.counts.size, 0);
});

test('a failed count still answers quietly', async () => {
  const env = makeEnv({
    prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1 over its limit'); } }) }),
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await hit(env);
    assert.equal(response.status, 204);
  } finally {
    console.error = originalError;
  }
});

test('the count cannot be read over the web', async () => {
  const env = makeEnv();
  await hit(env);
  for (const path of ['/hit', '/visits', '/count']) {
    const response = await worker.fetch(new Request(`https://share.example${path}`), env);
    assert.notEqual(response.status, 200, `GET ${path} returned data`);
  }
});
