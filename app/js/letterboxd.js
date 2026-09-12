/**
 * Reading a Letterboxd (or IMDb) export.
 *
 * Letterboxd's export is a zip containing ratings.csv with Date, Name, Year,
 * Letterboxd URI, Rating (0.5-5 in half stars). IMDb's export is a single CSV
 * with Title, Year, "Your Rating" out of 10.
 *
 * Everything happens in the page. Nothing is uploaded.
 */

/** Minimal RFC 4180 CSV parser: handles quoted fields, commas, newlines. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

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

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }

  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

function toObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const record = {};
    headers.forEach((header, i) => {
      record[header] = (row[i] ?? '').trim();
    });
    return record;
  });
}

/**
 * Normalise either export into {title, year, rating} on the 0.5-5 scale.
 * IMDb's 1-10 is halved so both sources land on the same scale the model
 * was trained on.
 */
export function readRatings(text) {
  const records = toObjects(parseCSV(text));
  if (records.length === 0) return { ratings: [], source: 'unknown' };

  const first = records[0];
  const isIMDb = 'your rating' in first || 'const' in first;
  const ratings = [];

  for (const record of records) {
    const title = record.name || record.title || record['original title'];
    const year = parseInt(record.year || record['release year'], 10);
    const raw = parseFloat(record.rating ?? record['your rating']);
    if (!title || !Number.isFinite(raw)) continue;

    const rating = isIMDb ? raw / 2 : raw;
    if (rating <= 0 || rating > 5) continue;

    ratings.push({
      title,
      year: Number.isFinite(year) ? year : null,
      rating,
      uri: record['letterboxd uri'] || '',
    });
  }

  return { ratings, source: isIMDb ? 'IMDb' : 'Letterboxd' };
}

/**
 * Pull ratings.csv out of a Letterboxd export zip, using the browser's own
 * decompression so no library is needed.
 */
export async function readExportZip(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buffer.buffer);
  const text = new TextDecoder();

  // Walk the central directory from the end-of-central-directory record.
  let eocd = buffer.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('That does not look like a zip file.');

  const count = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);

  for (let i = 0; i < count; i++) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break;

    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = text.decode(
      buffer.subarray(pointer + 46, pointer + 46 + nameLength)
    );

    if (/(^|\/)ratings\.csv$/i.test(name)) {
      // The local header repeats the name and extra fields at its own lengths.
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const bytes = buffer.subarray(start, start + compressedSize);

      if (method === 0) return text.decode(bytes);
      if (method === 8) {
        const stream = new Blob([bytes])
          .stream()
          .pipeThrough(new DecompressionStream('deflate-raw'));
        return await new Response(stream).text();
      }
      throw new Error(`Unsupported compression in the zip (method ${method}).`);
    }

    pointer += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error('No ratings.csv inside that zip.');
}

/** Accepts either the zip or a bare CSV. */
export async function readExport(file) {
  const isZip = /\.zip$/i.test(file.name);
  const text = isZip ? await readExportZip(file) : await file.text();
  return readRatings(text);
}
