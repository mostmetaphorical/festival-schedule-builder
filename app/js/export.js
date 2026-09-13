/**
 * Taking the plan with you.
 *
 * Three ways out, because they answer different needs:
 *   .ics  - the plan lands in the phone's calendar, which is what you actually
 *           use at a festival.
 *   .html - a single file that opens offline, can be hosted, and can be loaded
 *           back into the app to restore everything. This is the real backup.
 *   print - the browser's own print-to-PDF, which beats any library for
 *           typography and works on iOS and Android.
 */

import { formatTime } from './schedule.js';

const pad = (n) => String(n).padStart(2, '0');

// Directors live in entities for festivals shared through the app, and at the
// top level for older festival files. Read whichever is there.
const directorsOf = (film) => film.entities?.director || film.director || [];

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick; Safari needs the URL alive during the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Local time, no timezone: a 7pm screening is 7pm where the festival is. */
function icsTime(date, minutes) {
  const [year, month, day] = date.split('-').map(Number);
  const stamp = new Date(year, month - 1, day, 0, minutes || 0);
  return (
    `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
    `T${pad(stamp.getHours())}${pad(stamp.getMinutes())}00`
  );
}

/**
 * RFC 5545 wants CRLF, escaped separators, and lines folded at 75 *octets*.
 * Counting characters would overflow the limit on any accented title, so this
 * measures encoded bytes and never splits a character in half.
 */
function icsLine(line) {
  const encoder = new TextEncoder();
  const folded = [];
  let current = '';
  let bytes = 0;

  for (const character of line) {
    const size = encoder.encode(character).length;
    // 73 leaves room for the leading space a continuation line carries.
    if (bytes + size > 73) {
      folded.push(current);
      current = ' ';
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  folded.push(current);
  return folded.join('\r\n');
}

/** DTSTAMP is when the file was written, and is genuinely UTC. */
function stamp() {
  const now = new Date();
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

const escapeText = (value) =>
  String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

export function toICS(schedule, festivalName) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Festival Schedule Recommender//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(festivalName)}`,
  ];

  for (const day of schedule.days) {
    for (const pick of day.picks) {
      const film = pick.film || {};
      const runtime = film.runtime || pick.runtime || 120;
      const description = [
        film.synopsis,
        directorsOf(film).length ? `Director: ${directorsOf(film).join(', ')}` : '',
        film.scoreable === false
          ? 'Not rated by the recommender - your pick.'
          : film.prediction
            ? `Predicted: ${film.prediction.toFixed(1)} stars`
            : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      lines.push(
        'BEGIN:VEVENT',
        icsLine(
          `UID:${escapeText(`${pick.film?.title}-${pick.date}-${pick.time}`)}@festrec`
        ),
        `DTSTAMP:${stamp()}`,
        `DTSTART:${icsTime(pick.date, pick.start)}`,
        `DTEND:${icsTime(pick.date, pick.start + runtime)}`,
        icsLine(`SUMMARY:${escapeText(film.title || pick.film)}`),
        icsLine(`DESCRIPTION:${escapeText(description)}`),
        film.venue ? icsLine(`LOCATION:${escapeText(film.venue)}`) : '',
        'END:VEVENT'
      );
    }
  }

  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n');
}

export function downloadICS(schedule, festivalName) {
  download(
    `${slug(festivalName)}.ics`,
    toICS(schedule, festivalName),
    'text/calendar;charset=utf-8'
  );
}

const slug = (value) =>
  String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

/**
 * A standalone page of the plan.
 *
 * `includeProfile` decides whether the file can be loaded back into the app.
 * With it, the file contains the person's ratings - which is their taste
 * history, and not something to host publicly without meaning to. Without it,
 * the file is just the schedule and safe to share.
 */
export function toStandaloneHTML(schedule, festivalName, options = {}) {
  const { includeProfile = false, profileData = null, strength = null } = options;

  const days = schedule.days
    .filter((day) => day.picks.length)
    .map((day) => {
      const rows = day.picks
        .map((pick) => {
          const film = pick.film || {};
          const stars =
            film.scoreable === false
              ? '<span class="unrated">your pick</span>'
              : `${'★'.repeat(Math.round(film.prediction || 0))}<span class="dim">${
                  '★'.repeat(5 - Math.round(film.prediction || 0))
                }</span>`;
          return `<tr>
  <td class="time">${escapeHTML(formatTime(pick.start))}</td>
  <td class="film"><b>${escapeHTML(film.title || '')}</b>${
    directorsOf(film).length
      ? `<small>${escapeHTML(directorsOf(film).join(', '))}</small>`
      : ''
  }${film.synopsis ? `<small>${escapeHTML(film.synopsis)}</small>` : ''}</td>
  <td class="meta">${stars}<br>${escapeHTML(
    film.runtime ? `${film.runtime} min` : ''
  )}</td>
</tr>`;
        })
        .join('\n');

      return `<section>
<h2>${escapeHTML(
        new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })
      )}</h2>
<table>${rows}</table>
</section>`;
    })
    .join('\n');

  const payload = includeProfile
    ? `\n<script type="application/json" id="festrec-restore">${JSON.stringify(
        profileData
      ).replace(/</g, '\\u003c')}</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(festivalName)} - my schedule</title>
<style>
  :root { color-scheme: light dark; --ink:#1B1418; --bone:#EDE4D8; --dim:#A5988D;
          --line:#3D2E36; --gold:#D2A63C; }
  body { margin:0; padding:24px; background:var(--ink); color:var(--bone);
         font:15px/1.5 "IBM Plex Sans Condensed", system-ui, sans-serif; }
  .wrap { max-width:800px; margin:0 auto; }
  h1 { font-size:28px; margin:0 0 4px; font-weight:400; }
  h1 em { color:var(--gold); font-style:italic; }
  h2 { font-size:20px; font-weight:400; margin:28px 0 8px;
       border-top:1px solid var(--line); padding-top:16px; }
  p.sub { color:var(--dim); margin:0 0 8px; }
  table { width:100%; border-collapse:collapse; }
  td { padding:8px; vertical-align:top; border-bottom:1px solid var(--line); }
  td.time { font-family:ui-monospace, monospace; font-size:13px; color:var(--dim);
            white-space:nowrap; width:84px; }
  td.film small { display:block; color:var(--dim); font-size:12px; margin-top:3px; }
  td.meta { text-align:right; white-space:nowrap; color:var(--gold);
            font-size:13px; width:110px; }
  td.meta .dim { color:var(--line); }
  .unrated { color:var(--dim); font-style:italic; }
  footer { margin-top:32px; color:var(--dim); font-size:12px;
           border-top:1px solid var(--line); padding-top:12px; }
  @media print {
    body { background:#fff; color:#000; padding:0; }
    h2 { border-color:#ccc; } td { border-color:#eee; }
    td.time, td.film small, footer { color:#555; }
    td.meta { color:#000; } .unrated { color:#555; }
    section { break-inside:avoid; }
  }
</style>
</head>
<body>
<div class="wrap">
<h1>${escapeHTML(festivalName)} — <em>my schedule</em></h1>
<p class="sub">${escapeHTML(
    strength ? strength.detail : ''
  )}</p>
${days || '<p class="sub">No screenings selected.</p>'}
<footer>
  Built with a recommender that ran entirely in my browser; my ratings were
  never uploaded.${
    includeProfile
      ? ' This file contains my rating history so it can be loaded back into the app — it is a personal file, not one to publish.'
      : ' This file contains the schedule only.'
  }
</footer>
</div>${payload}
</body>
</html>`;
}

export function downloadHTML(schedule, festivalName, options) {
  download(
    `${slug(festivalName)}-schedule.html`,
    toStandaloneHTML(schedule, festivalName, options),
    'text/html;charset=utf-8'
  );
}

/** Read a previously exported file back in. */
export function restoreFromHTML(text) {
  const match = text.match(
    /<script type="application\/json" id="festrec-restore">([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/\\u003c/g, '<'));
  } catch {
    return null;
  }
}
