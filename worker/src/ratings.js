/**
 * Validating a shared ratings file.
 *
 * Everything about the upload is treated as hostile until proven otherwise,
 * and the original bytes are never stored: a new file is rebuilt from values
 * that passed every check. So nothing an uploader controls survives except
 * titles, years and star ratings that have been checked one by one.
 *
 * The app sends only three columns - Name, Year, Rating - so the date a film
 * was watched and the Letterboxd link never leave the person's device.
 */

export const RATINGS_HEADER = ['Name', 'Year', 'Rating'];
export const MIN_ROWS = 30; // Below this a history can't answer the test's question.
export const MAX_ROWS = 10_000;
export const MAX_TITLE = 300;
export const MIN_YEAR = 1870;

// Control characters other than tab, CR and LF. Their presence means binary
// data or something trying to be clever, never a film title.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const RATING = /^(0\.5|[1-4](\.0|\.5)?|5(\.0)?)$/;
const YEAR = /^\d{4}$/;
// A spreadsheet treats a cell starting with these as a formula.
const FORMULA_START = /^[=+\-@\t\r]/;

export class RejectedUpload extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Strict UTF-8, no control characters. Binary files fail here. */
export function decodeText(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RejectedUpload('That is not a text file.');
  }
  if (CONTROL.test(text)) {
    throw new RejectedUpload('That file contains data a ratings file never has.');
  }
  return text.replace(/^\uFEFF/, '');
}

/**
 * RFC 4180 CSV. Deliberately strict: an unterminated quote is an error rather
 * than something to guess around.
 */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === '"') {
      throw new RejectedUpload('Malformed CSV: a quote in the middle of a field.');
    } else if (char === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (quoted) throw new RejectedUpload('Malformed CSV: a quote is never closed.');
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

/** Check every row; any failure rejects the whole file. */
export function validateRatings(text, now = new Date()) {
  const rows = parseCSV(text);
  if (rows.length === 0) throw new RejectedUpload('The file is empty.');

  const header = rows[0].map((cell) => cell.trim());
  if (
    header.length !== RATINGS_HEADER.length ||
    header.some((cell, i) => cell !== RATINGS_HEADER[i])
  ) {
    throw new RejectedUpload(
      `Unexpected columns. Expected exactly: ${RATINGS_HEADER.join(',')}.`
    );
  }

  const body = rows.slice(1);
  if (body.length < MIN_ROWS) {
    throw new RejectedUpload(
      `Only ${body.length} ratings. At least ${MIN_ROWS} are needed for the ` +
        `test to learn anything, so smaller histories aren't collected.`
    );
  }
  if (body.length > MAX_ROWS) {
    throw new RejectedUpload(`More than ${MAX_ROWS} ratings - that isn't a real export.`);
  }

  const maxYear = now.getUTCFullYear() + 1;
  const ratings = [];

  body.forEach((cells, index) => {
    const line = index + 2;
    if (cells.length !== RATINGS_HEADER.length) {
      throw new RejectedUpload(`Row ${line} has ${cells.length} fields, not 3.`);
    }
    const [rawName, rawYear, rawRating] = cells;

    const name = rawName.trim();
    if (name.length < 1 || name.length > MAX_TITLE) {
      throw new RejectedUpload(`Row ${line}: a title must be 1-${MAX_TITLE} characters.`);
    }

    const yearText = rawYear.trim();
    let year = null;
    if (yearText !== '') {
      if (!YEAR.test(yearText)) {
        throw new RejectedUpload(`Row ${line}: "${yearText.slice(0, 20)}" is not a year.`);
      }
      year = Number(yearText);
      if (year < MIN_YEAR || year > maxYear) {
        throw new RejectedUpload(`Row ${line}: ${year} is outside ${MIN_YEAR}-${maxYear}.`);
      }
    }

    const ratingText = rawRating.trim();
    if (!RATING.test(ratingText)) {
      throw new RejectedUpload(
        `Row ${line}: ratings are 0.5 to 5 in half stars, not "${ratingText.slice(0, 20)}".`
      );
    }

    ratings.push({ name, year, rating: Number(ratingText) });
  });

  return ratings;
}

function csvCell(value) {
  let text = String(value ?? '');
  // Neutralise spreadsheet formulas: a "title" like =HYPERLINK(...) would
  // otherwise run when the file is opened in Excel.
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A brand-new file from validated values. The upload itself is discarded. */
export function rebuildRatings(ratings) {
  const lines = [RATINGS_HEADER.join(',')];
  for (const { name, year, rating } of ratings) {
    lines.push([csvCell(name), year ?? '', rating].join(','));
  }
  return `${lines.join('\n')}\n`;
}
