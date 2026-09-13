/**
 * Validating a shared festival schedule.
 *
 * A festival file is going to be reviewed by a person and, if accepted,
 * published inside the app. So beyond "is this well-formed", the rebuild keeps
 * only known fields with known types and sensible sizes, and drops anything
 * that could turn into markup or a third-party request once rendered:
 * strings with angle brackets are refused, and posters are only accepted from
 * TMDB's image host.
 *
 * Also used by the pull-request check in CI, so the same rules apply whether a
 * festival arrives through the app or through a hand-made pull request.
 */

import { RejectedUpload } from './ratings.js';

export const LIMITS = {
  festivalName: 120,
  films: 1000,
  screenings: 5000,
  title: 300,
  synopsis: 2000,
  section: 200,
  country: 120,
  venue: 120,
  listItems: 50,
  listItem: 120,
  runtime: 600,
};

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MARKUP = /[<>]/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i;
const POSTER = /^https:\/\/image\.tmdb\.org\/t\/p\/w\d{2,4}\/[A-Za-z0-9_-]+\.(jpg|png)$/;
const ENTITY_FACETS = ['director', 'writer', 'cast', 'keyword', 'genre'];

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RejectedUpload(`Missing ${field}.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new RejectedUpload(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new RejectedUpload(`${field} is longer than ${max} characters.`);
  }
  if (CONTROL.test(trimmed) || MARKUP.test(trimmed)) {
    throw new RejectedUpload(`${field} contains characters that aren't allowed.`);
  }
  if (required && trimmed.length === 0) throw new RejectedUpload(`Missing ${field}.`);
  return trimmed || undefined;
}

function integer(value, field, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  // Festival listings use 0 for "no runtime published" (shorts blocks, live
  // events). That means unknown, not a zero-minute film.
  if (value === 0 && min > 0) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RejectedUpload(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function validDate(value, field) {
  const match = DATE.exec(String(value ?? ''));
  if (!match) throw new RejectedUpload(`${field} must be a date like 2027-03-04.`);
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RejectedUpload(`${field} "${value}" is not a real date.`);
  }
  return String(value);
}

function validTime(value, field) {
  const trimmed = String(value ?? '').trim();
  const match = TIME.exec(trimmed);
  if (!match) throw new RejectedUpload(`${field} must be a time like 7:30 PM.`);
  const hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const twelveHour = Boolean(match[3]);
  if (minutes > 59 || (twelveHour ? hours < 1 || hours > 12 : hours > 23)) {
    throw new RejectedUpload(`${field} "${trimmed}" is not a real time.`);
  }
  return trimmed;
}

function list(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RejectedUpload(`${field} must be a list.`);
  if (value.length > LIMITS.listItems) {
    throw new RejectedUpload(`${field} has more than ${LIMITS.listItems} entries.`);
  }
  return value.map((item, i) => text(item, `${field}[${i}]`, LIMITS.listItem, { required: true }));
}

/**
 * Check a festival and return a rebuilt copy holding only known fields.
 * Throws RejectedUpload with a readable reason on the first problem.
 */
export function validateFestival(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RejectedUpload('A festival file must be a JSON object.');
  }

  const festival = text(data.festival, 'festival name', LIMITS.festivalName, {
    required: true,
  });

  if (!Array.isArray(data.films) || data.films.length === 0) {
    throw new RejectedUpload('No films in the lineup.');
  }
  if (data.films.length > LIMITS.films) {
    throw new RejectedUpload(`More than ${LIMITS.films} films.`);
  }
  if (!Array.isArray(data.screenings) || data.screenings.length === 0) {
    throw new RejectedUpload('No screenings.');
  }
  if (data.screenings.length > LIMITS.screenings) {
    throw new RejectedUpload(`More than ${LIMITS.screenings} screenings.`);
  }

  const titles = new Set();
  const films = data.films.map((film, i) => {
    const where = `film ${i + 1}`;
    if (!film || typeof film !== 'object') throw new RejectedUpload(`${where} is not an object.`);

    const title = text(film.title, `${where} title`, LIMITS.title, { required: true });
    if (titles.has(title)) throw new RejectedUpload(`"${title}" appears twice in the lineup.`);
    titles.add(title);

    const kind = film.kind === undefined ? 'film' : film.kind;
    if (kind !== 'film' && kind !== 'event') {
      throw new RejectedUpload(`${where} kind must be "film" or "event".`);
    }

    const entities = {};
    const source = film.entities && typeof film.entities === 'object' ? film.entities : {};
    for (const facet of ENTITY_FACETS) {
      entities[facet] = list(source[facet], `${where} ${facet}`);
    }

    const rebuilt = {
      title,
      year: integer(film.year, `${where} year`, 1870, 2100),
      runtime: integer(film.runtime, `${where} runtime`, 1, LIMITS.runtime),
      synopsis: text(film.synopsis, `${where} synopsis`, LIMITS.synopsis),
      section: text(film.section, `${where} section`, LIMITS.section),
      country: text(film.country, `${where} country`, LIMITS.country),
      kind,
      entities,
      scoreable: kind === 'film',
    };
    // Posters render as images for every visitor, so only TMDB's host is
    // accepted - anything else could be a tracking pixel.
    if (typeof film.poster === 'string' && POSTER.test(film.poster)) {
      rebuilt.poster = film.poster;
    }
    return Object.fromEntries(
      Object.entries(rebuilt).filter(([, value]) => value !== undefined)
    );
  });

  const dates = new Set();
  const screenings = data.screenings.map((screening, i) => {
    const where = `screening ${i + 1}`;
    if (!screening || typeof screening !== 'object') {
      throw new RejectedUpload(`${where} is not an object.`);
    }
    const film = text(screening.film, `${where} film`, LIMITS.title, { required: true });
    if (!titles.has(film)) {
      throw new RejectedUpload(`${where} names "${film}", which isn't in the lineup.`);
    }
    const date = validDate(screening.date, `${where} date`);
    dates.add(date);

    return Object.fromEntries(
      Object.entries({
        film,
        date,
        time: validTime(screening.time, `${where} time`),
        runtime: integer(screening.runtime, `${where} runtime`, 1, LIMITS.runtime),
        venue: text(screening.venue, `${where} venue`, LIMITS.venue),
      }).filter(([, value]) => value !== undefined)
    );
  });

  const days = [...dates].sort();
  return {
    festival,
    days,
    films,
    screenings,
    summary: {
      films: films.length,
      screenings: screenings.length,
      from: days[0],
      to: days[days.length - 1],
    },
  };
}
