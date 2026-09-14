/**
 * Reading commitments from a calendar file.
 *
 * Two shapes: an .ics export from any calendar app, or a CSV with date, start
 * and end columns (and optionally what it is). CSVs come out of schedule
 * tools and spreadsheets in every date and time style, so this is forgiving
 * about those, and reports the rows it still couldn't read rather than
 * dropping them silently.
 */

import { parseCSV } from './letterboxd.js';
import { normaliseDate, normaliseTime } from './festival-csv.js';

const HEADERS = {
  date: ['date', 'day', 'start date'],
  start: ['start', 'start time', 'starts', 'from', 'begin'],
  end: ['end', 'end time', 'ends', 'to', 'until', 'finish'],
  label: ['name', 'what', 'label', 'title', 'summary', 'subject', 'event', 'description', 'shift', 'role'],
};

/** "12:30am (Next Day)" -> "12:30am"; the scheduler works out overnight itself. */
const cleanTime = (value) => normaliseTime(String(value || '').replace(/\(.*?\)/g, '').trim());

// Tool exports nest names with backslashes ("Festival\Venue - Role").
const cleanLabel = (value) =>
  String(value || '')
    .replace(/\s*\\\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

function fromCSV(text) {
  const rows = parseCSV(text);
  const found = [];
  const unreadable = [];
  if (rows.length < 2) return { found, unreadable };

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const column = {};
  for (const [field, names] of Object.entries(HEADERS)) {
    const index = headers.findIndex((header) => names.includes(header));
    if (index !== -1) column[field] = index;
  }
  // No recognisable headings: read the columns in the documented order.
  const positional = column.date == null || column.start == null || column.end == null;
  const at = (row, field, fallback) => row[positional ? fallback : column[field]] ?? '';

  rows.slice(1).forEach((row, index) => {
    const date = normaliseDate(at(row, 'date', 0));
    const start = cleanTime(at(row, 'start', 1));
    const end = cleanTime(at(row, 'end', 2));
    if (!date || !start || !end) {
      unreadable.push(index + 2);
      return;
    }
    const label = column.label != null || positional ? cleanLabel(at(row, 'label', 3)) : '';
    found.push({ date, window: `${start} - ${end}`, label: label || 'Busy' });
  });
  return { found, unreadable };
}

function unescapeICS(value) {
  return String(value || '')
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

function fromICS(text) {
  // Long lines are folded onto the next line with a leading space.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const found = [];
  const unreadable = [];
  unfolded.split(/BEGIN:VEVENT/i).slice(1).forEach((event, index) => {
    const start = event.match(/^DTSTART[^:\n]*:(\d{8})(?:T(\d{2})(\d{2}))?/im);
    const end = event.match(/^DTEND[^:\n]*:(\d{8})(?:T(\d{2})(\d{2}))?/im);
    const summary = event.match(/^SUMMARY[^:\n]*:(.*)$/im);
    if (!start) {
      unreadable.push(index + 1);
      return;
    }
    const date = `${start[1].slice(0, 4)}-${start[1].slice(4, 6)}-${start[1].slice(6, 8)}`;
    found.push({
      date,
      window: `${start[2] || '00'}:${start[3] || '00'} - ${end?.[2] || '23'}:${end?.[3] || '59'}`,
      label: cleanLabel(unescapeICS(summary?.[1])) || 'Busy',
    });
  });
  return { found, unreadable };
}

/** { found: [{date, window, label}], unreadable: [row or event numbers] } */
export function commitmentsFromText(text) {
  const clean = String(text || '').replace(/^﻿/, '');
  return /BEGIN:VCALENDAR/i.test(clean) ? fromICS(clean) : fromCSV(clean);
}
