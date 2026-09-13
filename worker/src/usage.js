/**
 * Staying inside the free plan.
 *
 * Workers KV on the free plan refuses operations past its limits rather than
 * billing for them, and no payment method is on file, so there is nothing to
 * charge. These limits sit well below Cloudflare's anyway, so that sharing
 * pauses with a clear message instead of failing with a platform error.
 *
 *   Cloudflare free KV: 1 GB stored, 1,000 writes/day
 *   Ours:               900 MB stored, 300 uploads/day (2 writes each)
 *
 * Usage lives in one KV key. KV is eventually consistent, so two uploads
 * landing in the same second could both read the old total - which is why the
 * margins below Cloudflare's limits are wide rather than tight.
 */

import { RejectedUpload } from './ratings.js';

export const USAGE_KEY = 'usage';

export function limitsFrom(env) {
  return {
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES ?? 1_000_000),
    maxTotalBytes: Number(env.MAX_TOTAL_BYTES ?? 900_000_000),
    maxUploadsPerDay: Number(env.MAX_UPLOADS_PER_DAY ?? 300),
  };
}

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

export async function readUsage(kv, now = new Date()) {
  const stored = (await kv.get(USAGE_KEY, 'json')) || {};
  const day = today(now);
  return {
    bytes: Number(stored.bytes) || 0,
    day,
    // A new day starts the daily count again; stored bytes carry on.
    uploadsToday: stored.day === day ? Number(stored.uploadsToday) || 0 : 0,
  };
}

/** Is there room for this upload? Throws with a readable reason if not. */
export function checkRoom(usage, size, limits) {
  if (usage.bytes + size > limits.maxTotalBytes) {
    throw new RejectedUpload(
      'Sharing is paused: the storage set aside for shared data is full.',
      503
    );
  }
  if (usage.uploadsToday >= limits.maxUploadsPerDay) {
    throw new RejectedUpload(
      "Sharing is paused for today - the daily limit was reached. Try tomorrow.",
      429
    );
  }
}

/**
 * Record the upload before storing it. If the store then fails, usage is
 * slightly overcounted, which errs on the side of stopping early - the safe
 * direction when the point is to never exceed the free plan.
 */
export async function reserve(kv, usage, size) {
  const next = {
    bytes: usage.bytes + size,
    day: usage.day,
    uploadsToday: usage.uploadsToday + 1,
  };
  try {
    await kv.put(USAGE_KEY, JSON.stringify(next));
  } catch {
    // KV allows one write per second to a key. Rather than guess, refuse.
    throw new RejectedUpload('Busy right now - please try again in a moment.', 503);
  }
  return next;
}

export async function status(kv, limits, now = new Date()) {
  const usage = await readUsage(kv, now);
  let reason = null;
  if (usage.bytes >= limits.maxTotalBytes) reason = 'storage full';
  else if (usage.uploadsToday >= limits.maxUploadsPerDay) reason = 'daily limit reached';
  return { open: reason === null, reason };
}
