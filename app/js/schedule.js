/**
 * Building the plan.
 *
 * Given predicted ratings and a list of screenings, choose the set that is
 * worth the most and actually fits: no overlaps, nothing during a commitment,
 * time to get between venues, and each film seen at most once.
 *
 * This is weighted interval scheduling, solved exactly per day by dynamic
 * programming. No heuristics, no AI - the answer is provably the best set
 * available under the constraints given.
 */

const DEFAULT_BUFFER = 20;   // minutes between screenings, for queueing and walking
const UNKNOWN_RUNTIME = 120; // shorts blocks and live events rarely publish one

/** "5:00 PM" or "17:00" on a date, to minutes since midnight. */
export function parseTime(value) {
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const suffix = (match[3] || '').toLowerCase().replace(/\./g, '');
  if (suffix === 'pm' && hours < 12) hours += 12;
  if (suffix === 'am' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

export function formatTime(minutes) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(wrapped / 60);
  const mins = wrapped % 60;
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(mins).padStart(2, '0')} ${suffix}`;
}

/**
 * A screening's span in minutes from midnight on its date. Late-night shows
 * that run past midnight keep counting upward rather than wrapping, so
 * overlap comparisons stay correct.
 */
export function span(screening, buffer = DEFAULT_BUFFER) {
  const start = parseTime(screening.time);
  if (start === null) return null;
  const runtime = screening.runtime || UNKNOWN_RUNTIME;
  return {
    start,
    end: start + runtime + buffer,
    runtimeKnown: Boolean(screening.runtime),
  };
}

/** Commitments: {date, window: "2:00 PM - 12:30 AM"} or {date, start, end}. */
export function parseCommitment(commitment) {
  if (commitment.start !== undefined && commitment.end !== undefined) {
    return { ...commitment };
  }
  const parts = String(commitment.window || '').split(/[-–—]|to/);
  if (parts.length < 2) return null;

  const start = parseTime(parts[0]);
  let end = parseTime(parts[1]);
  if (start === null || end === null) return null;
  // "2:00 PM - 12:30 AM" ends after midnight, so it belongs to the next day.
  if (end <= start) end += 1440;
  return { ...commitment, start, end };
}

function clashes(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Stable id for one showing, so a pin can mean "this screening", not "this
 * film".
 *
 * Accepts a raw screening, where `film` is a title, or a scheduled entry,
 * where `film` has been replaced by the scored film object. Reading the title
 * out of whichever shape arrives is what keeps ids comparable: without it a
 * pin from the UI stringified to "[object Object]" and silently matched
 * nothing, so Swap and Add appeared to do nothing.
 */
export const screeningId = (screening) => {
  const title =
    typeof screening.film === 'string' ? screening.film : screening.film?.title;
  return `${title}@${screening.date}T${screening.time}`;
};

/**
 * What a slot is worth.
 *
 * A pinned item is worth more than anything the model can score, so the
 * optimiser keeps it. An unscoreable event (a party, a secret screening, a
 * live show) has no predicted rating - it sits at the person's average, which
 * is honest: we don't know, and pretending otherwise would quietly bury it
 * beneath films we do know about.
 */
function value(film, screening, { minimum, pinned }) {
  if (pinned) return 1000;
  if (!film) return 0;
  if (film.scoreable === false) {
    return film.userRating ?? Math.max((film.prediction ?? 0) - minimum, 0.01);
  }
  return Math.max(film.prediction - minimum, 0);
}

/**
 * Choose the best set for one day.
 * Classic weighted interval scheduling: sort by end time, and for each
 * screening either take it (plus the best set that ends before it starts) or
 * skip it. Exact, and linear after the sort.
 */
function bestForDay(candidates) {
  const sorted = [...candidates].sort((a, b) => a.end - b.end || a.start - b.start);
  const best = new Array(sorted.length + 1).fill(null).map(() => ({
    value: 0,
    picks: [],
  }));

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    // The most recent screening that finishes before this one starts.
    let previous = i;
    while (previous > 0 && sorted[previous - 1].end > current.start) previous--;

    const taking = {
      value: best[previous].value + current.value,
      picks: [...best[previous].picks, current],
    };
    const skipping = best[i];
    best[i + 1] = taking.value > skipping.value ? taking : skipping;
  }
  return best[sorted.length];
}

/**
 * Build the schedule.
 *
 * `scored` is the output of Recommender.scoreSlate, `screenings` the festival's
 * showtimes, `commitments` the user's blocked time.
 */
export function buildSchedule(scored, screenings, commitments = [], options = {}) {
  const buffer = options.buffer ?? DEFAULT_BUFFER;
  const maxPerDay = options.maxPerDay ?? Infinity;
  const minimum = options.minimumRating ?? 0;
  // The person's own decisions outrank the model's. A pinned item is kept even
  // if it costs two better-rated films; an excluded one is never offered.
  const pinned = new Set(options.pinned || []);
  const excluded = new Set(options.excluded || []);

  const byTitle = new Map(scored.map((film) => [film.title, film]));
  const blocked = commitments.map(parseCommitment).filter(Boolean);

  // Group every screening by day, noting why any of them are unavailable.
  const days = new Map();
  const rejected = [];

  for (const screening of screenings) {
    const timing = span(screening, buffer);
    const film = byTitle.get(screening.film);
    if (!timing) {
      rejected.push({ screening, reason: 'unreadable showtime' });
      continue;
    }

    const conflict = blocked.find(
      (commitment) =>
        commitment.date === screening.date && clashes(timing, commitment)
    );

    const isPinned = pinned.has(screeningId(screening)) || pinned.has(screening.film);
    const entry = {
      ...screening,
      ...timing,
      film,
      pinned: isPinned,
      value: value(film, screening, { minimum, pinned: isPinned }),
      blockedBy: conflict || null,
      excluded: excluded.has(screening.film),
    };

    if (!days.has(screening.date)) days.set(screening.date, []);
    days.get(screening.date).push(entry);
  }

  // A film with several screenings should only be counted once, so solve,
  // then drop repeats and re-solve without them until nothing repeats.
  const plan = [];
  const seen = new Set();

  for (const date of [...days.keys()].sort()) {
    let available = days
      .get(date)
      .filter(
        (entry) =>
          entry.film &&
          !entry.excluded &&
          entry.value > 0 &&
          // A pin wins over a commitment: if someone insists on a screening
          // during their shift, that is their call to make, not ours.
          (!entry.blockedBy || entry.pinned)
      );

    let chosen;
    for (;;) {
      chosen = bestForDay(available.filter((e) => !seen.has(e.film.title)));
      const duplicates = new Set();
      const titles = new Set();
      for (const pick of chosen.picks) {
        if (titles.has(pick.film.title)) duplicates.add(pick.film.title);
        titles.add(pick.film.title);
      }
      if (duplicates.size === 0) break;
      // Keep the earliest screening of each repeated title, drop the rest.
      available = available.filter(
        (entry) =>
          !duplicates.has(entry.film.title) ||
          entry === chosen.picks.find((p) => p.film.title === entry.film.title)
      );
    }

    let picks = chosen.picks;
    if (picks.length > maxPerDay) {
      // Keep the best-rated ones, then restore chronological order.
      picks = [...picks]
        .sort((a, b) => b.value - a.value)
        .slice(0, maxPerDay)
        .sort((a, b) => a.start - b.start);
    }
    for (const pick of picks) seen.add(pick.film.title);

    plan.push({
      date,
      picks,
      all: days.get(date).sort((a, b) => a.start - b.start),
    });
  }

  return { days: plan, rejected, missed: findMissed(days, seen, byTitle) };
}

/**
 * Films the plan never gets to, and why - the part a festival-goer most needs
 * to see, because "unreachable" and "you chose something better" are very
 * different problems.
 */
function findMissed(days, seen, byTitle) {
  const status = new Map();

  for (const entries of days.values()) {
    for (const entry of entries) {
      if (!entry.film || seen.has(entry.film.title)) continue;
      const current = status.get(entry.film.title) || {
        film: entry.film,
        screenings: 0,
        blocked: 0,
      };
      current.screenings += 1;
      if (entry.blockedBy) current.blocked += 1;
      status.set(entry.film.title, current);
    }
  }

  return [...status.values()]
    .map((item) => ({
      ...item,
      reason:
        item.blocked === item.screenings
          ? 'every screening falls inside a commitment'
          : 'lost a clash with something rated higher',
    }))
    .sort((a, b) => b.film.prediction - a.film.prediction);
}

/** Films whose only reachable screening is a single slot - book these first. */
export function onlyChances(schedule) {
  const counts = new Map();
  for (const day of schedule.days) {
    for (const entry of day.all) {
      if (!entry.film || entry.blockedBy) continue;
      counts.set(entry.film.title, (counts.get(entry.film.title) || 0) + 1);
    }
  }
  const single = new Set(
    [...counts.entries()].filter(([, n]) => n === 1).map(([title]) => title)
  );
  return single;
}
