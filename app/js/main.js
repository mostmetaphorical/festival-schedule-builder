/**
 * The app.
 *
 * Order of events: read a ratings export, resolve credits for those films,
 * score the festival's slate, fit it around the person's commitments, and let
 * them overrule any of it before they take it away.
 *
 * No server, no account, no telemetry.
 */

import { readExport } from './letterboxd.js';
import {
  BundleProvider,
  MetadataCache,
  TMDBProvider,
  resolveLibrary,
} from './metadata.js';
import { Recommender, profileStrength } from './recommend.js';
import { buildSchedule, formatTime, onlyChances, screeningId } from './schedule.js';
import { downloadHTML, downloadICS, restoreFromHTML } from './export.js';
import {
  downloadFestival,
  mailtoURL,
  validateFestival,
} from './festival-io.js';
import {
  MIN_RATINGS_TO_SHARE,
  botCheck,
  shareFestival,
  shareRatings,
  shareStatus,
} from './share.js';
import { storage } from './storage.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  ratings: [],
  library: [],
  missing: [],
  profile: null,
  festival: null,
  scored: [],
  commitments: [],
  pinned: new Set(),
  excluded: new Set(),
  schedule: null,
  tmdbKey: '',
  // The demo profile is invented; sharing it would only pollute the test data.
  isDemo: false,
  // Set once a share succeeds, so the same history isn't sent twice.
  sharedRatings: false,
};

let recommender = null;
let bundle = null;
const cache = new MetadataCache();

/* ---------- setup ---------- */

async function boot() {
  const [model, idf, stopwords, festivals] = await Promise.all([
    fetch('data/model.json').then((r) => r.json()),
    fetch('data/idf.json').then((r) => r.json()),
    fetch('data/stopwords.json').then((r) => r.json()),
    fetch('data/festivals.json').then((r) => r.json()),
  ]);

  recommender = new Recommender(model, idf, stopwords);
  renderFestivals(festivals);
  wireUp();
  restoreSession();
}

function wireUp() {
  $('#drop').addEventListener('click', () => $('#ratings-file').click());
  $('#ratings-file').addEventListener('change', (event) => {
    if (event.target.files[0]) loadRatings(event.target.files[0]);
  });

  const drop = $('#drop');
  ['dragover', 'dragleave', 'drop'].forEach((type) => {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.toggle('over', type === 'dragover');
      if (type === 'drop' && event.dataTransfer.files[0]) {
        loadRatings(event.dataTransfer.files[0]);
      }
    });
  });

  $$('.step').forEach((button) =>
    button.addEventListener('click', () => showStep(Number(button.dataset.step)))
  );

  $('#try-demo').addEventListener('click', async () => {
    setStatus('Loading a demo profile…');
    const text = await fetch('fixtures/demo-ratings.csv').then((r) => r.text());
    await loadRatings(new File([text], 'demo-ratings.csv', { type: 'text/csv' }), {
      demo: true,
    });
  });

  $('#save-key').addEventListener('click', useTMDBKey);
  $('#add-commitment').addEventListener('click', () => addCommitmentRow());
  $('#commitments-file').addEventListener('change', (event) => {
    if (event.target.files[0]) importCommitments(event.target.files[0]);
  });

  $('#max-per-day').addEventListener('change', rebuild);
  $('#buffer').addEventListener('change', rebuild);
  $('#to-plan').addEventListener('click', () => {
    rebuild();
    showStep(4);
  });

  $('#festival-drop').addEventListener('click', () => $('#festival-file').click());
  $('#festival-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      useFestival(JSON.parse(await file.text()), { external: true });
    } catch (error) {
      reportFestival(null, `That file isn't valid JSON: ${error.message}`);
    }
  });

  $('#load-url').addEventListener('click', async () => {
    const url = $('#festival-url').value.trim();
    if (!url) return;
    try {
      useFestival(await (await fetch(url)).json(), { external: true });
    } catch (error) {
      reportFestival(null, `Could not load that: ${error.message}`);
    }
  });
  $('#load-paste').addEventListener('click', () => {
    try {
      useFestival(JSON.parse($('#festival-paste').value), { external: true });
    } catch (error) {
      reportFestival(null, `That isn't valid festival data: ${error.message}`);
    }
  });

  wireSharing();

  // The email route hands the file to the person and opens a pre-filled
  // message. Nothing is transmitted from the page itself.
  $('#submit-email').addEventListener('click', () => {
    const file = downloadFestival(state.festival);
    window.location.href = mailtoURL(state.festival, state.festivalCheck.stats);
    reportFestival(state.festivalCheck,
      `Downloaded ${file} — attach it to the email that just opened.`);
  });

  $('#export-ics').addEventListener('click', () =>
    downloadICS(state.schedule, state.festival.festival)
  );
  $('#export-html').addEventListener('click', () =>
    downloadHTML(state.schedule, state.festival.festival, {
      includeProfile: $('#include-profile').checked,
      profileData: $('#include-profile').checked ? sessionData() : null,
      strength: profileStrength(state.library.length),
    })
  );
  $('#export-pdf').addEventListener('click', () => window.print());
  $('#include-profile').addEventListener('change', (event) => {
    $('#share-warning').classList.toggle('sharing', event.target.checked);
  });

  const remember = $('#remember');
  remember.checked = storage.enabled();
  $('#forget').hidden = !storage.enabled();
  if (!storage.available()) {
    remember.disabled = true;
    $('#remember-detail').textContent =
      'This browser is blocking local storage (private windows usually do), ' +
      'so nothing can be remembered here. Use the saved page instead.';
  }
  remember.addEventListener('change', (event) => {
    storage.enable(event.target.checked);
    $('#forget').hidden = !event.target.checked;
    if (event.target.checked) saveSession();
  });
  $('#forget').addEventListener('click', () => {
    storage.clear();
    $('#remember').checked = false;
    $('#forget').hidden = true;
    setStatus('Erased everything this app had stored in this browser.');
  });
}

/* ---------- step 1: ratings ---------- */

async function loadRatings(file, { demo = false } = {}) {
  setStatus('Reading…');
  try {
    // A previously exported page can be dropped straight back in.
    if (/\.html?$/i.test(file.name)) return restoreFromFile(file);

    const { ratings, source } = await readExport(file);
    if (ratings.length === 0) {
      return setStatus('No ratings found in that file.', true);
    }

    state.ratings = ratings;
    state.isDemo = demo;
    state.sharedRatings = false;
    setStatus(`Read <b>${ratings.length}</b> ratings from your ${source} export. Looking up who made them…`);
    await resolve();
  } catch (error) {
    setStatus(`Could not read that file: ${error.message}`, true);
  }
}

async function resolve() {
  if (!bundle) {
    bundle = new BundleProvider(await fetch('data/library.json').then((r) => r.json()));
  }
  const provider = state.tmdbKey
    ? new TMDBProvider(state.tmdbKey, cache)
    : bundle;

  // With a key, look up only what the bundle doesn't already cover.
  let result;
  if (state.tmdbKey) {
    const first = await resolveLibrary(state.ratings, bundle);
    const rest = await resolveLibrary(first.missing, provider, (done, total) =>
      setStatus(`Looking up ${done} of ${total} films TMDB might know…`)
    );
    result = {
      resolved: [...first.resolved, ...rest.resolved],
      missing: rest.missing,
    };
  } else {
    result = await resolveLibrary(state.ratings, provider);
  }

  state.library = result.resolved;
  state.missing = result.missing;
  state.profile = recommender.buildProfile(state.library);

  const strength = profileStrength(state.library.length);
  setStatus(
    `Matched <b>${state.library.length}</b> of ${state.ratings.length} films. ` +
      `<b>${strength.headline}.</b> ${strength.detail}` +
      (state.missing.length
        ? ` ${state.missing.length} weren't recognised — a TMDB key would find most of them.`
        : '')
  );
  renderMissing();
  saveSession();

  $('.step[data-step="2"]').removeAttribute('disabled');
  if (state.library.length) showStep(2);
}

function renderMissing() {
  const box = $('#missing-list');
  if (!state.missing.length) {
    box.innerHTML = '<p class="muted">Everything matched.</p>';
    return;
  }
  const names = state.missing
    .slice(0, 40)
    .map((film) => `${escapeHTML(film.title)}${film.year ? ` (${film.year})` : ''}`)
    .join(' · ');
  box.innerHTML = `<p class="muted">${state.missing.length} unmatched: ${names}${
    state.missing.length > 40 ? ' …' : ''
  }</p>`;
}

function useTMDBKey() {
  const key = $('#tmdb-key').value.trim();
  if (!key) return;
  state.tmdbKey = key;
  setStatus('Looking up the films that weren\'t in the bundled list…');
  resolve();
}

/* ---------- step 2: festival ---------- */

function renderFestivals(index) {
  const list = $('#festival-list');
  list.innerHTML = '';

  for (const festival of index.festivals) {
    const ready = festival.status === 'ready';
    const button = document.createElement('button');
    button.className = 'festival';
    button.type = 'button';
    if (!ready) button.disabled = true;
    button.innerHTML =
      `<span>${escapeHTML(festival.name)}<br>` +
      `<span class="where">${escapeHTML(festival.city)}</span></span>` +
      `<span class="tag ${ready ? 'ready' : ''}">${
        ready ? 'schedule ready' : 'not published yet'
      }</span>` +
      `<span class="when">${festival.starts}</span>`;
    if (ready) {
      button.addEventListener('click', async () => {
        setStatus(`Loading ${festival.name}…`);
        useFestival(await fetch(festival.data).then((r) => r.json()));
      });
    }
    list.appendChild(button);
  }
}

/* ---------- sharing ---------- */

// The bot check loads Cloudflare's script, so it only loads once someone
// ticks a consent box - a visitor who never shares never contacts Cloudflare.
const bots = { ratings: null, festival: null };
let statusCheck = null;

function wireSharing() {
  $('#share-ratings-consent').addEventListener('change', async (event) => {
    if (event.target.checked) {
      await startBotCheck('ratings', '#share-ratings-bot', updateRatingsShareButton);
    }
    updateRatingsShareButton();
  });
  $('#share-ratings-send').addEventListener('click', sendRatings);

  $('#share-festival-consent').addEventListener('change', async (event) => {
    if (event.target.checked) {
      await startBotCheck('festival', '#share-festival-bot', updateFestivalShareButton);
    }
    updateFestivalShareButton();
  });
  $('#share-festival-send').addEventListener('click', sendFestival);
}

async function startBotCheck(kind, selector, onChange) {
  if (bots[kind]) return;
  try {
    bots[kind] = await botCheck($(selector), onChange);
  } catch (error) {
    const message = `${error.message} Sharing isn't available right now.`;
    if (kind === 'ratings') setShareNote(message, true);
    else reportFestival(state.festivalCheck, message);
  }
}

function setShareNote(text, isError = false) {
  const note = $('#share-ratings-note');
  note.textContent = text;
  note.classList.toggle('error-text', isError);
}

function updateRatingsShareButton() {
  $('#share-ratings-send').disabled = !(
    $('#share-ratings-consent').checked && bots.ratings?.ready()
  );
}

function updateFestivalShareButton() {
  $('#share-festival-send').disabled = !(
    state.festivalExternal &&
    state.festival &&
    $('#share-festival-consent').checked &&
    bots.festival?.ready()
  );
}

/** The share offer on the Plan step: shown only where it makes sense. */
function renderRatingsShare() {
  const section = $('#share-ratings');
  const form = $('#share-ratings-form');
  const count = state.ratings.length;

  // Invented demo ratings would only pollute the data being collected.
  if (state.isDemo || count === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  if (state.sharedRatings) {
    form.hidden = true;
    return;
  }
  if (count < MIN_RATINGS_TO_SHARE) {
    form.hidden = true;
    setShareNote(
      `You have ${count} ratings. Sharing opens at ${MIN_RATINGS_TO_SHARE} — ` +
        "below that a history can't tell the test anything, so it isn't " +
        'collected. Rate a few more films and come back.'
    );
    return;
  }

  form.hidden = false;
  $('#share-ratings-what').textContent =
    `Title, year and star rating for each of your ${count} rated films.`;
  $('#share-ratings-consent-label').textContent =
    `I agree to share these ${count} ratings.`;
  updateRatingsShareButton();

  statusCheck ??= shareStatus();
  statusCheck.then((status) => {
    if (status.open || state.sharedRatings) return;
    form.hidden = true;
    setShareNote(
      status.reason === 'unreachable'
        ? "The share service can't be reached right now. Try again later."
        : `Sharing is paused (${status.reason}). Thanks for wanting to help — ` +
            'please try again another day.'
    );
  });
}

async function sendRatings() {
  const bot = bots.ratings;
  if (!$('#share-ratings-consent').checked || !bot?.ready()) return;

  const button = $('#share-ratings-send');
  button.disabled = true;
  button.textContent = 'Sharing…';
  setShareNote('');

  const result = await shareRatings(state.ratings, bot.take());
  button.textContent = 'Share my ratings';

  if (result.ok) {
    state.sharedRatings = true;
    $('#share-ratings-form').hidden = true;
    setShareNote(
      `Shared ${result.rows} ratings — thank you. Only titles, years and ` +
        'star ratings were sent.'
    );
  } else {
    setShareNote(result.error || 'Sharing failed.', true);
    updateRatingsShareButton();
  }
}

async function sendFestival() {
  const bot = bots.festival;
  if (!$('#share-festival-consent').checked || !bot?.ready() || !state.festival) return;

  const button = $('#share-festival-send');
  button.disabled = true;
  button.textContent = 'Sharing…';

  const result = await shareFestival(state.festival, bot.take());
  button.textContent = 'Share festival';

  if (result.ok) {
    $('#share-festival-form').hidden = true;
    reportFestival(
      state.festivalCheck,
      `Shared "${state.festival.festival}" — thank you. It will be ` +
        'checked against the official schedule before anyone else sees it.'
    );
  } else {
    reportFestival(state.festivalCheck, result.error || 'Sharing failed.');
    updateFestivalShareButton();
  }
}

/** Say what was found, and what looks wrong, before anything is acted on. */
function reportFestival(check, note = '') {
  const box = $('#festival-report');
  box.hidden = false;

  if (!check) {
    box.className = 'status error';
    box.textContent = note;
    return;
  }

  const { errors, warnings, stats } = check;
  const parts = [];
  if (stats.films) {
    parts.push(
      `<b>${stats.films} films</b>, ${stats.screenings} screenings, ` +
      `${stats.days} days (${stats.from} to ${stats.to}).`
    );
  }
  // Messages quote titles and dates from the file itself, so they are text,
  // never markup - a festival file must not be able to inject into the page.
  if (errors.length) {
    parts.push(
      `<b>${errors.length} problem${errors.length === 1 ? '' : 's'}:</b> ` +
      escapeHTML(errors.slice(0, 5).join(' '))
    );
  }
  if (warnings.length) {
    parts.push(
      `<b>Worth checking:</b> ${escapeHTML(warnings.slice(0, 4).join(' '))}`
    );
  }
  if (note) parts.push(escapeHTML(note));

  box.className = `status${errors.length ? ' error' : ''}`;
  box.innerHTML = parts.join('<br>');
}

function useFestival(data, { external = false } = {}) {
  // Check before use: a missing date or a mismatched title produces a plan
  // with silent holes in it, which is worse than a refusal.
  const check = validateFestival(data);
  state.festivalCheck = check;
  // A festival already listed in the app has nothing to share.
  state.festivalExternal = external;
  if (external) reportFestival(check);

  const submittable = external && check.errors.length === 0;
  $('#submit-email').disabled = !submittable;
  $('#share-festival-form').hidden = !submittable;
  $('#share-festival-consent').checked = false;
  updateFestivalShareButton();
  $('#submit-help').textContent = !external
    ? 'Load a festival above first. Nothing is sent until you choose to share.'
    : submittable
      ? `Ready to share "${data.festival}". Nothing is sent until you tick the ` +
        'box and press Share.'
      : 'Fix the problems above before sharing this one.';

  if (check.errors.length) return;

  state.festival = data;
  state.pinned = new Set();
  state.excluded = new Set();

  // Commitments already on the festival file are a starting point, not a
  // decision - the person can delete them.
  if (data.sample_commitments?.length && state.commitments.length === 0) {
    state.commitments = data.sample_commitments.map((c) => ({ ...c }));
  }
  renderCommitments();
  score();
  showStep(3);
}

/* ---------- step 3: commitments ---------- */

function addCommitmentRow(commitment = null) {
  state.commitments.push(
    commitment || { date: state.festival?.days?.[0] || '', window: '', label: '' }
  );
  renderCommitments();
}

function renderCommitments() {
  const box = $('#commitments');
  box.innerHTML = '';

  state.commitments.forEach((commitment, index) => {
    const row = document.createElement('div');
    row.className = 'commitment';
    row.innerHTML =
      `<input type="date" value="${commitment.date || ''}" data-field="date">` +
      `<input type="text" value="${commitment.window || ''}" data-field="window"
              placeholder="2:00 PM - 9:00 PM">` +
      `<input type="text" value="${commitment.label || ''}" data-field="label"
              placeholder="what is it?">` +
      `<button class="ghost danger" data-remove>Remove</button>`;

    row.querySelectorAll('input').forEach((input) =>
      input.addEventListener('change', () => {
        commitment[input.dataset.field] = input.value;
        rebuild();
      })
    );
    row.querySelector('[data-remove]').addEventListener('click', () => {
      state.commitments.splice(index, 1);
      renderCommitments();
      rebuild();
    });
    box.appendChild(row);
  });
}

/** Accepts a calendar export or a simple CSV. */
async function importCommitments(file) {
  const text = await file.text();

  if (/BEGIN:VCALENDAR/i.test(text)) {
    const events = text.split(/BEGIN:VEVENT/i).slice(1);
    for (const event of events) {
      const start = event.match(/DTSTART[^:]*:(\d{8})T?(\d{2})?(\d{2})?/i);
      const end = event.match(/DTEND[^:]*:(\d{8})T?(\d{2})?(\d{2})?/i);
      const summary = event.match(/SUMMARY:(.*)/i);
      if (!start) continue;
      const date = `${start[1].slice(0, 4)}-${start[1].slice(4, 6)}-${start[1].slice(6, 8)}`;
      state.commitments.push({
        date,
        window: `${start[2] || '00'}:${start[3] || '00'} - ${end?.[2] || '23'}:${
          end?.[3] || '59'
        }`,
        label: (summary?.[1] || 'busy').trim(),
      });
    }
  } else {
    const lines = text.trim().split(/\r?\n/).slice(1);
    for (const line of lines) {
      const [date, start, end, label] = line.split(',').map((v) => v?.trim());
      if (date && start && end) {
        state.commitments.push({ date, window: `${start} - ${end}`, label: label || 'busy' });
      }
    }
  }

  renderCommitments();
  rebuild();
}

/* ---------- scoring and planning ---------- */

function score() {
  if (!state.festival || !state.profile) return;

  const scoreable = state.festival.films.filter((f) => f.scoreable !== false);
  const rest = state.festival.films.filter((f) => f.scoreable === false);

  // Unscoreable items keep the person's own average rather than a fake
  // prediction, and are labelled as such in the UI.
  state.scored = [
    ...recommender.scoreSlate(state.profile, scoreable),
    ...rest.map((film) => ({
      ...film,
      prediction: state.profile.mean,
      confidence: 'none',
      reasons: { people: [], keywords: [] },
    })),
  ];
  rebuild();
}

function rebuild() {
  if (!state.scored.length) return;

  state.schedule = buildSchedule(
    state.scored,
    state.festival.screenings,
    state.commitments,
    {
      maxPerDay: Number($('#max-per-day').value) || Infinity,
      buffer: Number($('#buffer').value),
      pinned: state.pinned,
      excluded: state.excluded,
    }
  );

  renderPlan();
  saveSession();
  $('.step[data-step="4"]').removeAttribute('disabled');
}

function stars(value) {
  const filled = Math.round(value);
  return `<span class="stars">${'★'.repeat(filled)}<span class="off">${'★'.repeat(
    Math.max(0, 5 - filled)
  )}</span></span>`;
}

function renderPlan() {
  const strength = profileStrength(state.library.length);
  $('#strength').className = `strength ${strength.level}`;
  $('#strength').innerHTML = `<b>${strength.headline}</b><span>${strength.detail}</span>`;

  const single = onlyChances(state.schedule);
  const plan = $('#plan');
  plan.innerHTML = '';

  for (const day of state.schedule.days) {
    if (!day.picks.length) continue;

    const section = document.createElement('section');
    section.className = 'day';
    const heading = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    section.innerHTML = `<h3>${heading}</h3>`;

    for (const pick of day.picks) {
      const film = pick.film;
      const id = screeningId(pick);
      const unrated = film.scoreable === false;

      // Say what the score was actually built on. "Themes" on its own tells
      // someone nothing about whether to trust it.
      const people = film.reasons?.people
        ?.map(
          (person) =>
            `you rated ${person.films} ${
              person.films === 1 ? 'film' : 'films'
            } with ${person.name} ${person.average.toFixed(1)}★`
        )
        .join(' · ');
      const themes = film.reasons?.keywords?.length
        ? `themes you've rated before: ${film.reasons.keywords.join(', ')}`
        : '';
      const genres = film.reasons?.genres
        ?.map(
          (genre) =>
            `you rate ${genre.name} ${genre.average.toFixed(1)}★ on average ` +
            `across ${genre.films} films`
        )
        .join(' · ');
      // Names, themes and genres come from film data, so they are escaped as a
      // whole before going into the page.
      const reasons = escapeHTML(
        [people, themes, genres].filter(Boolean).join(' · ') ||
          'Nothing in your history connects to this one — scored on its description alone.'
      );

      const row = document.createElement('div');
      row.className = `slot picked${pick.pinned ? ' pinned' : ''}`;
      row.innerHTML =
        `<div class="time">${formatTime(pick.start)}</div>` +
        poster(film) +
        `<div>` +
        `<div class="title"><button class="disclose" aria-expanded="false"` +
        ` aria-label="Details for ${escapeAttribute(film.title)}"></button>` +
        `${escapeHTML(film.title)}` +
        (film.kind === 'event' ? '<span class="badge event">event</span>' : '') +
        (unrated ? '<span class="badge unrated">not rated</span>' : '') +
        (film.confidence === 'low' && !unrated
          ? '<span class="badge low">little to go on</span>'
          : '') +
        (single.has(film.title) ? '<span class="badge only">only chance</span>' : '') +
        `</div>` +
        `<div class="detail">${
          unrated ? 'No ratings history can predict this one — your call.' : reasons
        }${film.runtime ? ` · ${film.runtime} min` : ''}</div>` +
        `</div>` +
        `<div>${unrated ? '' : stars(film.prediction)}` +
        `<div class="actions">` +
        `<button class="ghost" data-swap>Swap</button>` +
        `<button class="ghost" data-drop>Drop</button>` +
        `</div></div>`;

      row.querySelector('[data-drop]').addEventListener('click', () => {
        state.excluded.add(film.title);
        state.pinned.delete(id);
        rebuild();
      });
      row.querySelector('[data-swap]').addEventListener('click', () =>
        showAlternatives(row, day, pick)
      );

      // The synopsis is what decides a toss-up between two films, but it is
      // too long to sit in every row - so it opens on demand.
      const details = document.createElement('div');
      details.className = 'synopsis';
      details.hidden = true;
      details.innerHTML = filmDetails(film, pick);

      const toggle = row.querySelector('.disclose');
      const open = () => {
        const showing = details.hidden;
        details.hidden = !showing;
        toggle.setAttribute('aria-expanded', String(showing));
        row.classList.toggle('open', showing);
      };
      toggle.addEventListener('click', open);
      // The whole row is a target too, except where it would steal a click.
      row.addEventListener('click', (event) => {
        if (!event.target.closest('button')) open();
      });

      section.appendChild(row);
      section.appendChild(details);
    }
    renderGaps(section, day);
    plan.appendChild(section);
  }

  renderMissed(plan);
  renderDropped(plan);
  renderRatingsShare();
}

/**
 * What else was showing at that time, so a pick can be overruled knowingly.
 * Shown inline rather than in a dialog: choosing between films means reading
 * what they are, and a one-line prompt can't show that.
 */
/**
 * Where a panel for this row belongs: after the row's own synopsis if that is
 * showing, so a film and its description are never split by something else.
 */
function anchorFor(row) {
  const next = row.nextElementSibling;
  return next?.classList.contains('synopsis') ? next : row;
}

/** Open a panel under a row, or close it if it is already open. */
function togglePanel(row, build) {
  const anchor = anchorFor(row);
  const existing = anchor.nextElementSibling;
  if (existing?.classList.contains('alternatives')) {
    existing.remove();
    return;
  }
  anchor.after(build());
}

/**
 * Make `chosen` the pick for its time slot.
 *
 * This replaces whatever was pinned in that slot rather than marking the
 * displaced film as dropped - a swap is "this instead of that, here", not
 * "never show me that again". The displaced film stays available, so it
 * appears among the alternatives and can be swapped straight back.
 */
function pinInstead(day, chosen) {
  for (const entry of day.all) {
    if (entry.film && entry.start < chosen.end && chosen.start < entry.end) {
      state.pinned.delete(screeningId(entry));
    }
  }
  state.excluded.delete(chosen.film.title);
  state.pinned.add(screeningId(chosen));
}

function showAlternatives(row, day, pick) {
  togglePanel(row, () => alternativesPanel(day, pick));
}

function alternativesPanel(day, pick) {

  const options = day.all
    .filter(
      (entry) =>
        entry.film &&
        entry.film.title !== pick.film.title &&
        !state.excluded.has(entry.film.title) &&
        entry.start < pick.end &&
        pick.start < entry.end
    )
    .sort((a, b) => (b.film.prediction || 0) - (a.film.prediction || 0));

  if (!options.length) return emptyAlternatives();

  const panel = document.createElement('div');
  panel.className = 'alternatives';
  panel.innerHTML =
    `<p class="muted">Also showing against ${escapeHTML(pick.film.title)}:</p>` +
    options
      .map(
        (entry, index) => `
      <div class="alt">
        ${poster(entry.film, 38)}
        <div>
          <b>${escapeHTML(entry.film.title)}</b>
          ${entry.film.kind === 'event' ? '<span class="badge event">event</span>' : ''}
          ${entry.blockedBy ? '<span class="badge low">during a commitment</span>' : ''}
          <div class="detail">${formatTime(entry.start)}${
            entry.film.runtime ? ` · ${entry.film.runtime} min` : ''
          }${
            entry.film.scoreable === false
              ? ' · not rated — your call'
              : ` · predicted ${entry.film.prediction.toFixed(1)}★`
          }${entry.film.synopsis ? `<br>${escapeHTML(entry.film.synopsis)}` : ''}</div>
        </div>
        <button class="ghost" data-pick="${index}">Use this instead</button>
      </div>`
      )
      .join('');

  panel.querySelectorAll('[data-pick]').forEach((button) =>
    button.addEventListener('click', () => {
      pinInstead(day, options[Number(button.dataset.pick)]);
      rebuild();
    })
  );

  return panel;
}

function emptyAlternatives() {
  const panel = document.createElement('div');
  panel.className = 'alternatives';
  panel.innerHTML = '<p class="muted">Nothing else is showing in that slot.</p>';
  return panel;
}

const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const escapeAttribute = (value) =>
  String(value ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Poster, or a labelled placeholder. A premiere often has no artwork anywhere
 * yet, and initials explain themselves better than a broken-image icon.
 */
function poster(film, size = 46) {
  if (film.poster) {
    return `<img class="poster" src="${escapeAttribute(film.poster)}" alt=""
      loading="lazy" width="${size}" height="${Math.round(size * 1.5)}">`;
  }
  const initials = String(film.title || '?')
    .replace(/^(the|a|an) /i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] || '')
    .join('')
    .toUpperCase();
  return `<span class="poster empty" aria-hidden="true">${escapeHTML(initials)}</span>`;
}

/**
 * Letterboxd organises people by a slug of their name. Building it from the
 * name rather than looking each one up means it is right for anyone with a
 * filmography, and wrong in two cases: a first-timer with no page yet, and a
 * common name Letterboxd disambiguated with a numeric suffix. Hence the
 * caveat in the panel rather than a promise.
 */
function letterboxdLink(name, role) {
  const slug = String(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return escapeHTML(name);
  return (
    `<a href="https://letterboxd.com/${role}/${slug}/" target="_blank"` +
    ` rel="noopener noreferrer">${escapeHTML(name)}</a>`
  );
}

const peopleLinks = (names, role) =>
  names.map((name) => letterboxdLink(name, role)).join(', ');

/** What's worth knowing before deciding: the synopsis, then the credits. */
function filmDetails(film, pick) {
  const rows = [];
  const people = film.entities || {};
  if (people.director?.length) {
    rows.push(['Director', peopleLinks(people.director, 'director')]);
  }
  if (people.writer?.length) {
    rows.push(['Writer', peopleLinks(people.writer.slice(0, 3), 'writer')]);
  }
  if (people.cast?.length) {
    rows.push(['Cast', peopleLinks(people.cast.slice(0, 5), 'actor')]);
  }
  if (film.country) rows.push(['Country', escapeHTML(film.country)]);
  if (film.section) rows.push(['Programme', escapeHTML(film.section)]);
  if (film.runtime) rows.push(['Runtime', `${film.runtime} min`]);
  rows.push(['Showing', `${formatTime(pick.start)}, ${pick.date}`]);

  const facts = rows
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  const hasLinks = people.director?.length || people.cast?.length;
  return (
    (film.synopsis
      ? `<p>${escapeHTML(film.synopsis)}</p>`
      : '<p class="muted">No synopsis published.</p>') +
    `<dl>${facts}</dl>` +
    (hasLinks
      ? '<p class="caveat">Name links go to Letterboxd. They are built from' +
        ' the name, so a first-time director may not have a page yet.</p>'
      : '')
  );
}

// A gap shorter than this can't hold a film, so it isn't worth offering.
const SHORTEST_USEFUL_GAP = 45;

/**
 * Free time in a day, offered as something to fill.
 *
 * This is also how a film comes back after being dropped by accident: the
 * gap it left is visible, and everything that fits it - including the thing
 * just dropped - is one click away.
 */
function renderGaps(section, day) {
  const picks = [...day.picks].sort((a, b) => a.start - b.start);
  const candidates = day.all.filter(
    (entry) => entry.film && !entry.blockedBy
  );
  if (!candidates.length) return;

  const dayStart = Math.min(...candidates.map((entry) => entry.start));
  const dayEnd = Math.max(...candidates.map((entry) => entry.end));

  const gaps = [];
  let cursor = dayStart;
  for (const pick of picks) {
    if (pick.start - cursor >= SHORTEST_USEFUL_GAP) {
      gaps.push({ start: cursor, end: pick.start });
    }
    cursor = Math.max(cursor, pick.end);
  }
  if (dayEnd - cursor >= SHORTEST_USEFUL_GAP) {
    gaps.push({ start: cursor, end: dayEnd });
  }

  for (const gap of gaps) {
    const fits = day.all
      .filter(
        (entry) =>
          entry.film &&
          !entry.blockedBy &&
          entry.start >= gap.start &&
          entry.end <= gap.end &&
          !picks.some((pick) => pick.film.title === entry.film.title)
      )
      .sort((a, b) => (b.film.prediction || 0) - (a.film.prediction || 0));
    if (!fits.length) continue;

    const row = document.createElement('div');
    row.className = 'slot gap';
    row.innerHTML =
      `<div class="time">${formatTime(gap.start)}</div>` +
      `<span class="poster empty" aria-hidden="true">+</span>` +
      `<div><div class="title">Nothing planned` +
      `<span class="detail">${Math.round((gap.end - gap.start) / 60)} hours ` +
      `free · ${fits.length} ${fits.length === 1 ? 'film' : 'films'} ` +
      `fit here</span></div></div>` +
      `<div class="actions"><button class="ghost">Add a film</button></div>`;

    row.querySelector('button').addEventListener('click', (event) => {
      event.stopPropagation();
      togglePanel(row, () => gapPanel(day, gap, fits));
    });

    section.appendChild(row);
  }
}

/** Everything that fits a free stretch of the day, best first. */
function gapPanel(day, gap, fits) {
  const panel = document.createElement('div');
  panel.className = 'alternatives';
  panel.innerHTML =
    `<p class="muted">Fits between ${formatTime(gap.start)} and ` +
    `${formatTime(gap.end)}:</p>` +
    fits
      .map(
        (entry, index) => `
      <div class="alt">
        ${poster(entry.film, 38)}
        <div>
          <b>${escapeHTML(entry.film.title)}</b>
          ${state.excluded.has(entry.film.title)
            ? '<span class="badge low">you dropped this</span>'
            : ''}
          <div class="detail">${formatTime(entry.start)}${
            entry.film.runtime ? ` · ${entry.film.runtime} min` : ''
          }${
            entry.film.scoreable === false
              ? ' · not rated — your call'
              : ` · predicted ${entry.film.prediction.toFixed(1)}★`
          }${entry.film.synopsis
            ? `<br>${escapeHTML(entry.film.synopsis)}`
            : ''}</div>
        </div>
        <button class="ghost" data-add="${index}">Add</button>
      </div>`
      )
      .join('');

  panel.querySelectorAll('[data-add]').forEach((button) =>
    button.addEventListener('click', () => {
      // Adding something back is also how a drop is undone.
      pinInstead(day, fits[Number(button.dataset.add)]);
      rebuild();
    })
  );
  return panel;
}

function renderMissed(plan) {
  const missed = state.schedule.missed.slice(0, 12);
  if (!missed.length) return;

  const details = document.createElement('details');
  details.className = 'missed';
  details.innerHTML =
    `<summary>${state.schedule.missed.length} films you're missing, and why</summary>` +
    `<ul>${missed
      .map(
        (item) =>
          `<li><b>${escapeHTML(item.film.title)}</b> — ${item.reason}${
            item.film.scoreable === false
              ? ''
              : ` (predicted ${item.film.prediction.toFixed(1)}★)`
          }</li>`
      )
      .join('')}</ul>`;
  plan.appendChild(details);
}

function renderDropped(plan) {
  if (!state.excluded.size) return;

  const details = document.createElement('details');
  details.className = 'missed';
  details.innerHTML =
    `<summary>${state.excluded.size} you dropped</summary>` +
    `<ul>${[...state.excluded]
      .map(
        (title) =>
          `<li>${escapeHTML(title)} <button class="ghost" ` +
          `data-undrop="${escapeAttribute(title)}">put back</button></li>`
      )
      .join('')}</ul>`;
  details.querySelectorAll('[data-undrop]').forEach((button) =>
    button.addEventListener('click', () => {
      state.excluded.delete(button.dataset.undrop);
      rebuild();
    })
  );
  plan.appendChild(details);
}

/* ---------- session ---------- */

const sessionData = () => ({
  ratings: state.ratings,
  commitments: state.commitments,
  pinned: [...state.pinned],
  excluded: [...state.excluded],
  festival: state.festival?.festival || null,
});

function saveSession() {
  if (storage.enabled()) storage.save(sessionData());
}

async function restoreSession() {
  const saved = storage.load();
  if (!saved?.ratings?.length) return;

  state.ratings = saved.ratings;
  state.commitments = saved.commitments || [];
  state.pinned = new Set(saved.pinned || []);
  state.excluded = new Set(saved.excluded || []);
  setStatus(`Restored ${saved.ratings.length} ratings saved in this browser.`);
  await resolve();
}

async function restoreFromFile(file) {
  const data = restoreFromHTML(await file.text());
  if (!data) {
    return setStatus(
      "That page doesn't carry a saved profile. Re-export it with the ratings box ticked.",
      true
    );
  }
  state.ratings = data.ratings || [];
  state.commitments = data.commitments || [];
  state.pinned = new Set(data.pinned || []);
  state.excluded = new Set(data.excluded || []);
  await resolve();
}

/* ---------- chrome ---------- */

function setStatus(html, isError = false) {
  const box = $('#ratings-status');
  box.hidden = false;
  box.className = `status${isError ? ' error' : ''}`;
  box.innerHTML = html;
}

function showStep(step) {
  $$('.panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${step}`;
  });
  $$('.step').forEach((button) =>
    button.setAttribute('aria-current', String(Number(button.dataset.step) === step))
  );
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

boot();
