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
export function span(screening, buffer = DEFAULT_BUFFER, tail = 0) {
  const start = parseTime(screening.time);
  if (start === null) return null;
  const runtime = screening.runtime || UNKNOWN_RUNTIME;
  return {
    start,
    end: start + runtime + tail + buffer,
    runtimeKnown: Boolean(screening.runtime),
  };
}

// Festival screenings often end with a Q&A. Planning for one keeps the gap
// between films real: a 20-minute buffer after a Q&A, not during it. Events
// (parties, trivia) don't have one.
export const QA_MINUTES = 10;
export const tailFor = (film) => (film && film.kind !== 'event' ? QA_MINUTES : 0);

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
  // Slots the person emptied by dropping a film. The optimiser leaves them
  // empty rather than quietly moving the next-best film in: a drop is "not
  // that", not "something else, chosen for me". The person can still fill one
  // by picking a film for it, which pins it.
  const held = (options.held || []).filter(
    (window) => window && window.date && Number.isFinite(window.start) && Number.isFinite(window.end)
  );

  const byTitle = new Map(scored.map((film) => [film.title, film]));
  const blocked = commitments.map(parseCommitment).filter(Boolean);

  // Group every screening by day, noting why any of them are unavailable.
  const days = new Map();
  const rejected = [];

  for (const screening of screenings) {
    const film = byTitle.get(screening.film);
    const timing = span(screening, buffer, tailFor(film));
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
      held: held.some((window) => window.date === screening.date && clashes(timing, window)),
    };

    if (!days.has(screening.date)) days.set(screening.date, []);
    days.get(screening.date).push(entry);
  }

  // Screenings the person chose, plus the ones a swap elsewhere kept in place,
  // are fixed: taken as they are, even when two of them clash, because
  // choosing between them is the person's call. The plan reports the clash
  // instead. A pin wins over a commitment - someone insisting on a screening
  // during their shift is their call too - but a kept film does not, since
  // nobody chose it against the commitment. Each film is fixed at most once,
  // at its earliest fixed screening, and isn't offered at its other showings.
  const kept = new Set(options.kept || []);
  const fixedTitles = new Set();
  const dates = [...days.keys()].sort();
  for (const date of dates) {
    for (const entry of days.get(date).sort((a, b) => a.start - b.start)) {
      const wanted =
        entry.pinned || (kept.has(screeningId(entry)) && !entry.blockedBy);
      entry.fixed = Boolean(
        wanted && entry.film && !entry.excluded && !fixedTitles.has(entry.film.title)
      );
      if (entry.fixed) {
        fixedTitles.add(entry.film.title);
        entry.value = Math.max(entry.value, 1000);
      }
    }
  }

  // A film with several screenings should only be counted once, so solve,
  // then drop repeats and re-solve without them until nothing repeats.
  const plan = [];
  const seen = new Set(fixedTitles);

  for (const date of dates) {
    const fixed = days.get(date).filter((entry) => entry.fixed);
    // Once the person has started editing, the rest of the plan is theirs:
    // the optimiser adds nothing, and free time shows what could fill it.
    let available = kept.size ? [] : days
      .get(date)
      .filter(
        (entry) =>
          entry.film &&
          !entry.fixed &&
          !entry.excluded &&
          entry.value > 0 &&
          !entry.blockedBy &&
          // A slot the person emptied stays empty until they fill it.
          !entry.held &&
          !fixed.some((pick) => clashes(pick, entry))
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

    // The daily limit caps what the planner chooses, never what the person
    // chose: their own picks always stay, and the planner fills what's left
    // of the limit with its best-rated suggestions.
    const room = Math.max(0, maxPerDay - fixed.length);
    const suggested = [...chosen.picks]
      .sort((a, b) => (b.film.prediction || 0) - (a.film.prediction || 0))
      .slice(0, room);
    const picks = [...fixed, ...suggested].sort((a, b) => a.start - b.start);
    for (const pick of picks) seen.add(pick.film.title);

    plan.push({
      date,
      picks,
      clashes: findClashes(picks),
      all: days.get(date).sort((a, b) => a.start - b.start),
    });
  }

  return { days: plan, rejected };
}

/**
 * Picks that run into each other, earlier one first. Only fixed picks can
 * clash - the optimiser never chooses overlapping screenings itself.
 */
function findClashes(picks) {
  const found = [];
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      if (clashes(picks[i], picks[j])) found.push({ first: picks[i], second: picks[j] });
    }
  }
  return found;
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
