/**
 * The share endpoint for Meta's Nifty Film Fest Planner.
 *
 *   GET  /status     is sharing open?
 *   POST /ratings    a Name,Year,Rating CSV, stored privately for evaluation
 *   POST /festival   a festival schedule, stored for review before publishing
 *   POST /report     a bug report: a description and optional details
 *   POST /hit        a page load, added to that day's count (see visits.js)
 *
 * Write-only by design: there is no route that reads anything back out. Shared
 * files are retrieved by the maintainer with wrangler, never over the web.
 *
 * Nothing about the sender is kept - no IP address, filename or browser
 * details. Each upload is stored under a random id with the day it arrived.
 */

import { decodeText, RejectedUpload, rebuildRatings, validateRatings } from './ratings.js';
import { validateFestival } from './festival.js';
import { validateReport } from './report.js';
import { checkRoom, limitsFrom, readUsage, reserve, status, today } from './usage.js';
import { countVisit } from './visits.js';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, CF-Turnstile-Response',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function reply(request, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

/** Read at most `limit` bytes, whatever size the request claims to be. */
async function readCapped(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > limit) {
    throw new RejectedUpload(`Too large - the limit is ${Math.round(limit / 1000)} KB.`, 413);
  }
  if (!request.body) throw new RejectedUpload('Nothing was sent.');

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new RejectedUpload(`Too large - the limit is ${Math.round(limit / 1000)} KB.`, 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Bot check, before the body is even read. */
async function verifyHuman(request, env) {
  const token = request.headers.get('CF-Turnstile-Response');
  if (!token || token.length > 2048) {
    throw new RejectedUpload('Missing the bot check. Reload the page and try again.', 403);
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);

  const result = await fetch(SITEVERIFY, { method: 'POST', body: form })
    .then((response) => response.json())
    .catch(() => ({ success: false }));
  if (!result.success) {
    throw new RejectedUpload('The bot check failed. Reload the page and try again.', 403);
  }
}

async function acceptRatings(request, env, limits) {
  await verifyHuman(request, env);
  const text = decodeText(await readCapped(request, limits.maxUploadBytes));
  const ratings = validateRatings(text);
  const stored = rebuildRatings(ratings);
  const size = new TextEncoder().encode(stored).byteLength;

  const usage = await readUsage(env.SHARES);
  checkRoom(usage, size, limits);
  await reserve(env.SHARES, usage, size);

  const id = crypto.randomUUID();
  await env.SHARES.put(`ratings/${today()}/${id}.csv`, stored, {
    metadata: { rows: ratings.length, bytes: size },
  });
  return { ok: true, id, rows: ratings.length };
}

async function acceptFestival(request, env, limits) {
  await verifyHuman(request, env);
  const text = decodeText(await readCapped(request, limits.maxUploadBytes * 2));
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RejectedUpload('That is not valid JSON.');
  }
  const festival = validateFestival(data);
  const stored = JSON.stringify(festival);
  const size = new TextEncoder().encode(stored).byteLength;

  const usage = await readUsage(env.SHARES);
  checkRoom(usage, size, limits);
  await reserve(env.SHARES, usage, size);

  const id = crypto.randomUUID();
  await env.SHARES.put(`festival/${today()}/${id}.json`, stored, {
    metadata: {
      festival: festival.festival.slice(0, 80),
      films: festival.summary.films,
      screenings: festival.summary.screenings,
      bytes: size,
    },
  });
  return { ok: true, id, ...festival.summary };
}

// A report is a few paragraphs; anything near this size isn't one.
const MAX_REPORT_BYTES = 16_000;

async function acceptReport(request, env, limits) {
  await verifyHuman(request, env);
  const text = decodeText(await readCapped(request, MAX_REPORT_BYTES));
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RejectedUpload('That is not valid JSON.');
  }
  const report = validateReport(data);
  const stored = JSON.stringify({ ...report, received: today() }, null, 2);
  const size = new TextEncoder().encode(stored).byteLength;

  const usage = await readUsage(env.SHARES);
  checkRoom(usage, size, limits);
  await reserve(env.SHARES, usage, size);

  const id = crypto.randomUUID();
  await env.SHARES.put(`report/${today()}/${id}.json`, stored, {
    metadata: { step: report.step, bytes: size, reply: Boolean(report.contact) },
  });
  return { ok: true, id };
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const limits = limitsFrom(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    // Only the app itself may use this from a browser.
    const origin = request.headers.get('Origin');
    if (request.method === 'POST' && !allowedOrigins(env).includes(origin)) {
      return reply(request, env, 403, { ok: false, error: 'Not allowed from this site.' });
    }

    try {
      if (request.method === 'GET' && pathname === '/status') {
        return reply(request, env, 200, await status(env.SHARES, limits));
      }
      if (request.method === 'POST' && pathname === '/ratings') {
        return reply(request, env, 201, await acceptRatings(request, env, limits));
      }
      if (request.method === 'POST' && pathname === '/festival') {
        return reply(request, env, 201, await acceptFestival(request, env, limits));
      }
      if (request.method === 'POST' && pathname === '/report') {
        return reply(request, env, 201, await acceptReport(request, env, limits));
      }
      if (request.method === 'POST' && pathname === '/hit') {
        await countVisit(env.VISITS, today());
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      return reply(request, env, 404, { ok: false, error: 'Not found.' });
    } catch (error) {
      if (error instanceof RejectedUpload) {
        return reply(request, env, error.status, { ok: false, error: error.message });
      }
      // Never echo internal errors back to a stranger.
      console.error(error);
      return reply(request, env, 500, { ok: false, error: 'Something went wrong.' });
    }
  },
};
