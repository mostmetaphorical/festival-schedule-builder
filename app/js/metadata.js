/**
 * Finding out who made the films someone rated.
 *
 * The recommender works on directors, writers, cast and keywords, so a list of
 * titles has to become a list of credits. Two ways to do that:
 *
 *   bundle   - a file shipped with the app, built from Wikidata. No network,
 *              instant, but it only covers the films in it.
 *   wikidata - looks up anything else live (wikidata.js), on request, cached in
 *              the browser so each film is only asked about once.
 *
 * Either way the lookups describe films, never the person doing the looking:
 * no ratings are ever sent anywhere.
 */

// Wikimedia asks callers to keep parallel requests modest.
const CONCURRENCY = 4;

/**
 * One canonical spelling of a title. Mirrors festrec_eval/titles.py - the
 * bundle is keyed with those rules, so these must agree exactly.
 *
 * The same film is written differently everywhere: "Big Lebowski, The" in
 * MovieLens, "The Big Lebowski" on Letterboxd, "Oldboy (Oldeuboi)" with the
 * original title in brackets. An unmatched film contributes nothing to the
 * profile, so this is worth getting right.
 */
export function normalise(title) {
  let text = String(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '') // strip accents
    .toLowerCase()
    .trim();

  text = text.replace(/,\s+(the|a|an|le|la|les|el|il|der|die|das)\s*$/i, '');
  text = text.replace(/\s*[([][^)\]]*[)\]]/g, '');
  text = text.replace(/&/g, ' and ');
  text = text.replace(/[^\w\s]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text.replace(/^(the|a|an) /, '');
}

export const key = (title, year) => {
  const yearText = year === null || year === undefined ? '' : String(year).trim();
  return `${normalise(title)}|${yearText}`;
};

/** Films shipped with the app, keyed by title and year. */
export class BundleProvider {
  constructor(bundle) {
    this.name = 'bundle';
    // Films are stored once; every spelling of a title points at one of them.
    this.films = bundle.films;
    this.keys = new Map(Object.entries(bundle.keys));
  }

  at(lookupKey) {
    const index = this.keys.get(lookupKey);
    return index === undefined ? null : this.films[index];
  }

  async lookup(title, year) {
    // Exact year first; then either side of it, since sources disagree about
    // festival year versus release year; then the film whatever its year.
    const exact = this.at(key(title, year));
    if (exact) return exact;

    if (year) {
      for (const offset of [-1, 1]) {
        const near = this.at(key(title, Number(year) + offset));
        if (near) return near;
      }
    }
    return this.at(key(title, ''));
  }
}

/** A tiny IndexedDB key-value store, so a lookup is only ever paid for once. */
export class MetadataCache {
  constructor(name = 'festrec-metadata') {
    this.ready = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('films');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(() => null); // Private browsing can refuse; degrade to no cache.
  }

  async get(id) {
    const db = await this.ready;
    if (!db) return undefined;
    return new Promise((resolve) => {
      const request = db.transaction('films').objectStore('films').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  }

  async set(id, value) {
    const db = await this.ready;
    if (!db) return;
    await new Promise((resolve) => {
      const transaction = db.transaction('films', 'readwrite');
      transaction.objectStore('films').put(value, id);
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
    });
  }
}

/**
 * Resolve a whole rating history to credits.
 * Reports progress so a slow first run can show something honest.
 */
export async function resolveLibrary(ratings, provider, onProgress = () => {}) {
  const resolved = [];
  const missing = [];
  let done = 0;

  const queue = [...ratings];
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, queue.length || 1) },
    async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          const meta = await provider.lookup(entry.title, entry.year);
          if (meta) {
            resolved.push({
              rating: entry.rating,
              title: entry.title,
              // The export's year is what the person's own library says; the
              // bundle's is a fallback for sources that omit it.
              year: entry.year ?? Number(meta.year) ?? null,
              entities: {
                director: meta.director || [],
                writer: meta.writer || [],
                cast: meta.cast || [],
                keyword: meta.keyword || [],
                genre: (meta.genre || []).map((g) => g.toLowerCase()),
              },
              // The bundled library carries a synopsis's key terms rather than
              // the text, which is all the recommender reads of it.
              synopsis: meta.overview || meta.terms || '',
              // Content-predicted crowd factors, for fitting the person's taste vector.
              ...(Array.isArray(meta.cf) ? { cf: meta.cf } : {}),
            });
          } else missing.push(entry);
        } catch (error) {
          missing.push({ ...entry, error: String(error.message || error) });
        }
        onProgress(++done, ratings.length);
      }
    }
  );

  await Promise.all(workers);
  return { resolved, missing };
}
