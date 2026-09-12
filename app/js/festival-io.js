/**
 * Loading a festival someone else assembled, and offering it back.
 *
 * Festival schedules are published late, change often, and live in whatever
 * shape the festival's ticketing platform uses. So the app takes a plain JSON
 * file and anyone can produce one.
 *
 * Anything submitted is checked here first. That isn't security - a browser
 * check protects nobody from a determined sender - it is there so honest
 * mistakes (a missing date, a 3am runtime, a screening in the wrong year) get
 * caught by the person who can still fix them, instead of by whoever reviews
 * the pull request.
 */

const REQUIRED_FILM_FIELDS = ['title'];
const MAX_SENSIBLE_RUNTIME = 600;
const MIN_SENSIBLE_RUNTIME = 3;

/** Human-readable problems, split by whether they block submission. */
export function validateFestival(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object') {
    return { errors: ['That file is not JSON, or is empty.'], warnings: [], stats: {} };
  }
  if (!data.festival) errors.push('No "festival" name.');
  if (!Array.isArray(data.films) || data.films.length === 0) {
    errors.push('No "films" array, or it is empty.');
  }
  if (!Array.isArray(data.screenings) || data.screenings.length === 0) {
    errors.push('No "screenings" array, or it is empty.');
  }
  if (errors.length) return { errors, warnings, stats: {} };

  const titles = new Set();
  for (const [index, film] of data.films.entries()) {
    for (const field of REQUIRED_FILM_FIELDS) {
      if (!film[field]) errors.push(`Film ${index + 1} has no ${field}.`);
    }
    if (titles.has(film.title)) {
      warnings.push(`"${film.title}" appears twice in the lineup.`);
    }
    titles.add(film.title);

    if (film.runtime && (film.runtime < MIN_SENSIBLE_RUNTIME ||
        film.runtime > MAX_SENSIBLE_RUNTIME)) {
      warnings.push(`"${film.title}" has a runtime of ${film.runtime} minutes.`);
    }
  }

  const dates = new Set();
  let missingRuntime = 0;
  let orphans = 0;

  for (const [index, screening] of data.screenings.entries()) {
    const where = screening.film || `screening ${index + 1}`;
    if (!screening.film) {
      errors.push(`Screening ${index + 1} names no film.`);
    } else if (!titles.has(screening.film)) {
      orphans += 1;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(screening.date || '')) {
      errors.push(`${where} has date "${screening.date}" (expected YYYY-MM-DD).`);
    } else {
      dates.add(screening.date);
    }
    if (!screening.time) errors.push(`${where} has no time.`);
    if (!screening.runtime) missingRuntime += 1;
  }

  if (orphans) {
    errors.push(
      `${orphans} screenings name a film that isn't in the lineup. ` +
      `Titles have to match exactly.`
    );
  }
  if (missingRuntime) {
    warnings.push(
      `${missingRuntime} screenings have no runtime, so the scheduler will ` +
      `assume two hours and may overlap them.`
    );
  }

  const sorted = [...dates].sort();
  if (sorted.length > 31) {
    warnings.push(`Spans ${sorted.length} days - is that right for one festival?`);
  }
  const withPeople = data.films.filter(
    (film) => film.entities?.director?.length || film.entities?.cast?.length
  ).length;
  if (withPeople / data.films.length < 0.3) {
    warnings.push(
      `Only ${withPeople} of ${data.films.length} films list a director or ` +
      `cast. Recommendations will be weak - run enrich_festival.py if you can.`
    );
  }

  return {
    errors,
    warnings,
    stats: {
      films: data.films.length,
      screenings: data.screenings.length,
      days: sorted.length,
      from: sorted[0],
      to: sorted[sorted.length - 1],
      withPeople,
    },
  };
}

/** A short, readable summary to put in an issue or an email. */
export function describeFestival(data, stats) {
  return [
    `Festival: ${data.festival}`,
    `Films: ${stats.films} (${stats.withPeople} with credits)`,
    `Screenings: ${stats.screenings}`,
    `Dates: ${stats.from} to ${stats.to} (${stats.days} days)`,
    data.source ? `Source: ${data.source}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Offer the file to the person's own device. They then attach it wherever
 * they choose - nothing is transmitted from here.
 */
export function downloadFestival(data) {
  const name = String(data.festival || 'festival')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `${name}.json`;
}

/** Where to send a festival so it can be reviewed and added to the app. */
export const SUBMIT = {
  repo: 'mostmetaphorical/festival-schedule-builder',
  email: 'festrecommender.crucial122@passmail.net',
};

export function issueURL(data, stats) {
  const title = `Festival data: ${data.festival}`;
  const body = [
    describeFestival(data, stats),
    '',
    '**Attach the .json file to this issue** (drag it into the comment box).',
    '',
    'Where did this schedule come from?',
    '',
    '- [ ] I built it from the festival\'s published schedule',
    '- [ ] I checked the dates and times against the official listing',
    '',
    'Anything unusual about it?',
  ].join('\n');

  return (
    `https://github.com/${SUBMIT.repo}/issues/new` +
    `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  );
}

export function mailtoURL(data, stats) {
  const subject = `Festival data: ${data.festival}`;
  const body = [
    describeFestival(data, stats),
    '',
    'The .json file is attached.',
    '',
    '(Attach the file your browser just downloaded - email can\'t do it for you.)',
  ].join('\n');
  return (
    `mailto:${SUBMIT.email}?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  );
}
