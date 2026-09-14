/**
 * Reading a festival schedule from a spreadsheet.
 *
 * JSON is exact but fiddly to write by hand. Most people who can get a
 * schedule out of a festival's site will have it in a spreadsheet, so this
 * accepts one row per screening, with the film's details repeated on each of
 * its screenings (or given once, on any one of them). The result is the same
 * festival object a JSON file produces, and goes through the same checks.
 */

import { parseCSV } from './letterboxd.js';

/** Spreadsheet headings people actually use, mapped to the festival format. */
const HEADERS = {
  festival: ['festival', 'festival name', 'event'],
  title: ['title', 'film', 'film title', 'name'],
  date: ['date', 'day'],
  time: ['time', 'start', 'start time', 'starts'],
  runtime: ['runtime', 'length', 'duration', 'minutes', 'runtime (min)'],
  year: ['year', 'release year'],
  director: ['director', 'directors', 'directed by'],
  writer: ['writer', 'writers', 'written by'],
  cast: ['cast', 'actors', 'starring'],
  genre: ['genre', 'genres'],
  keyword: ['keywords', 'keyword', 'tags', 'themes'],
  section: ['section', 'programme', 'program', 'strand'],
  country: ['country', 'countries'],
  venue: ['venue', 'cinema', 'theatre', 'theater', 'screen'],
  kind: ['kind', 'type'],
  synopsis: ['synopsis', 'description', 'summary', 'logline'],
  poster: ['poster', 'poster url', 'poster link', 'image', 'image url', 'artwork'],
};

/** Only plain https links are used as posters; anything else is left out. */
export function isPosterURL(value) {
  if (!value || value.length > 500 || /[\s"'<>`\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.');
  } catch {
    return false;
  }
}

// Lists inside one cell are separated by semicolons or vertical bars, so a
// name with a comma in it ("Lee, Spike") survives.
const LIST_SPLIT = /\s*[;|]\s*/;
const LIST_FIELDS = ['director', 'writer', 'cast', 'genre', 'keyword'];

export const TEMPLATE_URL = 'data/festival-template.csv';

export function looksLikeCSV(text) {
  const firstLine = String(text).trimStart().split(/\r?\n/, 1)[0] || '';
  return !firstLine.startsWith('{') && firstLine.includes(',');
}

/**
 * Accepts "2026-09-18", "2026/09/18", and the day-first or month-first forms
 * spreadsheets like to reformat dates into. Ambiguous numeric dates are read
 * month-first only when the day-first reading is impossible.
 */
export function normaliseDate(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return iso(match[1], match[2], match[3]);

  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const [, a, b, year] = match;
    // 18/09/2026 can only be day-first; 09/18/2026 only month-first.
    if (Number(a) > 12) return iso(year, b, a);
    if (Number(b) > 12) return iso(year, a, b);
    return null;
  }

  // Written out: "Thursday, September 17, 2026", "Sep 17 2026", "17 Sept 2026".
  const words = text.replace(/^[a-z]+day,?\s+/i, '').replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  match = words.match(/^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (match && monthNumber(match[1])) return iso(match[3], monthNumber(match[1]), match[2]);
  match = words.match(/^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})$/i);
  if (match && monthNumber(match[2])) return iso(match[3], monthNumber(match[2]), match[1]);
  return null;
}

const MONTHS = 'january february march april may june july august september october november december'.split(' ');

/** "September", "Sept" or "Sep" -> 9; anything else -> 0. */
function monthNumber(word) {
  const name = word.toLowerCase();
  return name.length < 3 ? 0 : MONTHS.findIndex((month) => month.startsWith(name)) + 1;
}

function iso(year, month, day) {
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "19:30" and "7.30pm" both become "7:30 PM", the form the scheduler reads. */
export function normaliseTime(value) {
  const text = String(value || '').trim().toLowerCase().replace(/\./g, ':');
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3]?.[0];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
  } else {
    if (hours > 23) return null;
    if (hours === 0) return `12:${pad(minutes)} AM`;
    if (hours === 12) return `12:${pad(minutes)} PM`;
    if (hours > 12) return `${hours - 12}:${pad(minutes)} PM`;
    return `${hours}:${pad(minutes)} AM`;
  }
  return `${hours}:${pad(minutes)} ${meridiem === 'p' ? 'PM' : 'AM'}`;
}

const pad = (n) => String(n).padStart(2, '0');

function columnMap(headers) {
  const map = {};
  const unknown = [];
  headers.forEach((raw, index) => {
    const header = raw.trim().toLowerCase();
    const field = Object.keys(HEADERS).find((key) => HEADERS[key].includes(header));
    if (field && !(field in map)) map[field] = index;
    else if (header) unknown.push(raw.trim());
  });
  return { map, unknown };
}

/**
 * Parse spreadsheet text into a festival object.
 *
 * Returns { data, notes, problems }. `notes` are worth knowing but harmless;
 * `problems` are values it couldn't read, which must be fixed before use.
 * A file it can't make sense of at all throws.
 */
export function festivalFromCSV(text, { fallbackName = '' } = {}) {
  const rows = parseCSV(String(text).replace(/^﻿/, ''));
  if (rows.length < 2) {
    throw new Error('The spreadsheet needs a heading row and at least one screening.');
  }

  const { map, unknown } = columnMap(rows[0]);
  const missing = ['title', 'date', 'time'].filter((field) => !(field in map));
  if (missing.length) {
    throw new Error(
      `No ${missing.join(', ')} column. The headings need to include title, date and time — ` +
        'the template shows every heading it understands.'
    );
  }

  const cell = (row, field) => (field in map ? (row[map[field]] ?? '').trim() : '');
  const notes = [];
  if (unknown.length) {
    notes.push(`Ignored columns it doesn't use: ${unknown.slice(0, 6).join(', ')}.`);
  }

  const films = new Map();
  const screenings = [];
  let festivalName = '';
  let badDates = 0;
  let badTimes = 0;
  let badPosters = 0;

  rows.slice(1).forEach((row, index) => {
    const title = cell(row, 'title');
    if (!title) return;
    festivalName ||= cell(row, 'festival');

    const film = films.get(title) || { title, kind: 'film', entities: {} };
    films.set(title, film);

    const runtime = parseInt(cell(row, 'runtime'), 10);
    if (!film.runtime && runtime > 0) film.runtime = runtime;
    const year = parseInt(cell(row, 'year'), 10);
    if (!film.year && year > 1800) film.year = year;
    for (const field of ['section', 'country', 'synopsis']) {
      const value = cell(row, field);
      if (!film[field] && value) film[field] = value;
    }
    const poster = cell(row, 'poster');
    if (poster && !film.poster) {
      if (isPosterURL(poster)) film.poster = poster;
      else badPosters += 1;
    }
    if (/^event$/i.test(cell(row, 'kind'))) {
      film.kind = 'event';
      film.scoreable = false;
    }
    for (const field of LIST_FIELDS) {
      const values = cell(row, field).split(LIST_SPLIT).filter(Boolean);
      if (values.length && !film.entities[field]?.length) {
        film.entities[field] = field === 'genre' || field === 'keyword'
          ? values.map((value) => value.toLowerCase())
          : values;
      }
    }

    const date = normaliseDate(cell(row, 'date'));
    const time = normaliseTime(cell(row, 'time'));
    if (!date) badDates += 1;
    if (!time) badTimes += 1;

    const screening = {
      film: title,
      // Left as written when unreadable, so the checks name the bad value.
      date: date || cell(row, 'date'),
      time: time || cell(row, 'time'),
    };
    if (runtime > 0) screening.runtime = runtime;
    const venue = cell(row, 'venue');
    if (venue) screening.venue = venue;
    screening.row = index + 2;
    screenings.push(screening);
  });

  if (badPosters) {
    notes.push(
      `${badPosters} poster ${badPosters === 1 ? 'link was' : 'links were'} left out — ` +
        'posters need a full https:// address.'
    );
  }

  // Unreadable dates and times would put films at the wrong hour, so they
  // block loading rather than just being mentioned.
  const problems = [];
  if (badDates) {
    problems.push(
      `${badDates} ${badDates === 1 ? 'row has a date' : 'rows have dates'} it couldn't read. ` +
        'Use YYYY-MM-DD, like 2026-09-18.'
    );
  }
  if (badTimes) {
    problems.push(
      `${badTimes} ${badTimes === 1 ? 'row has a time' : 'rows have times'} it couldn't read ` +
        '(for example 25:00). Use 7:30 PM or 19:30.'
    );
  }

  // A screening without its own runtime borrows the film's.
  for (const screening of screenings) {
    screening.runtime ||= films.get(screening.film)?.runtime;
    if (!screening.runtime) delete screening.runtime;
    delete screening.row;
  }

  const days = [...new Set(screenings.map((s) => s.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  const data = {
    festival: festivalName || fallbackName,
    days,
    films: [...films.values()].map((film) => {
      if (!Object.keys(film.entities).length) delete film.entities;
      return film;
    }),
    screenings,
  };
  return { data, notes, problems };
}
