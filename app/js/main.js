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
import {
  buildSchedule,
  formatTime,
  onlyChances,
  parseCommitment,
  screeningId,
} from './schedule.js';
import { downloadHTML, downloadICS, restoreFromHTML } from './export.js';
import {
  downloadFestival,
  mailtoURL,
  validateFestival,
} from './festival-io.js';
import { festivalFromCSV, isPosterURL, looksLikeCSV } from './festival-csv.js';
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
  festivalIndex: null,
  festivalCheck: null,
  festivalNotes: [],
  scored: [],
  commitments: [],
  pinned: new Set(),
  excluded: new Set(),
  // Film cards the person has opened, kept open across re-renders so a swap
  // or a preference change doesn't snap everything shut.
  openCards: new Set(),
  schedule: null,
  step: 1,
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
  state.festivalIndex = festivals;
  renderFestivals();
  wireUp();
  updateChrome();
  restoreSession();
}

/** A file dropped onto a zone, or chosen through it, goes to `onFile`. */
function fileZone(zone, input, onFile) {
  input.addEventListener('change', (event) => {
    const file = event.target.files[0];
    // Reset so choosing the same file again still fires a change.
    event.target.value = '';
    if (file) onFile(file);
  });
  ['dragenter', 'dragover'].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((type) =>
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove('over');
      if (type === 'drop' && event.dataTransfer.files[0]) {
        onFile(event.dataTransfer.files[0]);
      }
    })
  );
}

function wireUp() {
  fileZone($('#drop'), $('#ratings-file'), (file) => loadRatings(file));

  $$('.step').forEach((button) =>
    button.addEventListener('click', () => showStep(Number(button.dataset.step)))
  );
  $('#to-festival').addEventListener('click', () => showStep(2));
  $('#to-time').addEventListener('click', () => showStep(3));

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
    const file = event.target.files[0];
    event.target.value = '';
    if (file) importCommitments(file);
  });

  $$('.step-btn').forEach((button) =>
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.for);
      const next = Number(input.value || 0) + Number(button.dataset.delta);
      input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
      input.dispatchEvent(new Event('change'));
    })
  );
  $('#max-per-day').addEventListener('change', rebuild);
  $('#buffer').addEventListener('change', rebuild);
  $('#to-plan').addEventListener('click', () => {
    rebuild();
    showStep(4);
  });

  fileZone($('#festival-drop'), $('#festival-file'), async (file) => {
    loadFestivalText(await file.text(), { name: file.name });
  });

  $('#load-url').addEventListener('click', async () => {
    const url = $('#festival-url').value.trim();
    if (!url) return;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      loadFestivalText(await response.text(), { name: url.split('/').pop() });
    } catch (error) {
      reportFestival(null, `Could not load that: ${error.message}`);
    }
  });
  $('#load-paste').addEventListener('click', () => {
    const text = $('#festival-paste').value;
    if (!text.trim()) return;
    loadFestivalText(text, { name: 'Pasted festival' });
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
      'so nothing can be remembered here. Use the saved web page instead.';
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
    $('#remember-detail').textContent =
      'Erased everything this app had stored in this browser.';
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
    setStatus(`Could not read that file: ${escapeHTML(error.message)}`, true);
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
        ? ` ${state.missing.length} weren't recognised — open the section below to look them up.`
        : '')
  );
  renderMissing();
  saveSession();
  score();
  updateChrome();

  if (state.library.length && state.step === 1) showStep(2);
}

function renderMissing() {
  const box = $('#missing-list');
  const count = state.missing.length;
  $('#missing-heading').textContent = count
    ? `${count} ${count === 1 ? 'film' : 'films'} it couldn't identify`
    : "Films it couldn't identify";

  if (!state.ratings.length) {
    box.innerHTML = '<p class="muted">Import your ratings first.</p>';
    return;
  }
  if (!count) {
    box.innerHTML = '<p class="muted">Everything matched.</p>';
    return;
  }
  const rows = state.missing
    .slice(0, 40)
    .map(
      (film) =>
        `<div class="missing-row"><span>${escapeHTML(film.title)}</span>` +
        `<span class="year">${film.year || ''}</span></div>`
    )
    .join('');
  box.innerHTML =
    '<p class="intro">They\'re still in your ratings, but add nothing to what it ' +
    "learns about your taste until they're found.</p>" +
    rows +
    (count > 40 ? `<p class="muted small">…and ${count - 40} more.</p>` : '');
}

function useTMDBKey() {
  const key = $('#tmdb-key').value.trim();
  if (!key) return;
  state.tmdbKey = key;
  setStatus('Looking up the films that weren\'t in the bundled list…');
  resolve();
}

/* ---------- step 2: festival ---------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 17–24", or "Oct 30–Nov 2" across a month end. */
function dateRange(from, to) {
  const [, m1, d1] = String(from).split('-').map(Number);
  const [, m2, d2] = String(to || from).split('-').map(Number);
  if (!m1) return '';
  const start = `${MONTHS[m1 - 1]} ${d1}`;
  if (!m2 || (m1 === m2 && d1 === d2)) return start;
  return m1 === m2 ? `${start}–${d2}` : `${start}–${MONTHS[m2 - 1]} ${d2}`;
}

function renderFestivals() {
  const list = $('#festival-list');
  list.innerHTML = '';
  const festivals = state.festivalIndex?.festivals || [];
  const ready = festivals.filter((f) => f.status === 'ready');
  const planned = festivals.filter((f) => f.status !== 'ready');

  for (const festival of ready) {
    const selected = state.festival?.festival === festival.name;
    const stats = selected ? state.festivalCheck?.stats : null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'festival';
    button.setAttribute('aria-pressed', String(selected));
    button.innerHTML =
      `<span class="when">${dateRange(festival.starts, festival.ends)}` +
      `<small>${escapeHTML(festival.starts.slice(0, 4))}</small></span>` +
      `<span><span class="name">${escapeHTML(festival.name)}</span>` +
      `<span class="meta">${escapeHTML(festival.city)}${
        stats ? ` · ${stats.films} films and events · ${stats.screenings} screenings` : ''
      }</span>` +
      (festival.source
        ? `<span class="source">${escapeHTML(festival.source)}${
            festival.captured ? ` on ${dateRange(festival.captured)}` : ''
          }</span>`
        : '') +
      `</span>` +
      `<span class="pick">${selected ? 'Selected' : 'Choose'}</span>`;
    button.addEventListener('click', async () => {
      if (selected) return showStep(3);
      button.querySelector('.pick').textContent = 'Loading…';
      try {
        const data = await fetch(festival.data).then((r) => r.json());
        useFestival(data);
        if (!state.festivalCheck.errors.length) showStep(3);
      } catch (error) {
        button.querySelector('.pick').textContent = 'Try again';
      }
    });
    list.appendChild(button);
  }

  if (planned.length) {
    const coming = document.createElement('div');
    coming.className = 'coming';
    coming.innerHTML =
      '<p class="eyebrow">Coming up · schedule not published yet</p>' +
      planned
        .map(
          (festival) =>
            `<div class="coming-row"><span class="when">${dateRange(festival.starts, festival.ends)}</span>` +
            `<span><span class="name">${escapeHTML(festival.name)}</span>` +
            `<span class="city">${escapeHTML(festival.city)}</span></span>` +
            '<span class="tag">Usual dates</span></div>'
        )
        .join('');
    list.appendChild(coming);
  }
}

/** Read a festival from spreadsheet or JSON text, whichever it is. */
function loadFestivalText(text, { name = '' } = {}) {
  const fallbackName = String(name)
    .replace(/\.(csv|json|txt)$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  let parsed;
  try {
    parsed = looksLikeCSV(text)
      ? festivalFromCSV(text, { fallbackName })
      : { data: JSON.parse(text), notes: [], problems: [] };
  } catch (error) {
    state.festivalNotes = [];
    const message = error instanceof SyntaxError
      ? "It isn't a spreadsheet with title, date and time columns, or a JSON festival file."
      : error.message;
    reportFestival(null, message);
    return;
  }
  useFestival(parsed.data, { external: true, notes: parsed.notes, problems: parsed.problems });
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
    `I agree to share these ${count} ratings`;
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
  // Messages quote titles and dates from the file itself, so they are text,
  // never markup - a festival file must not be able to inject into the page.
  const item = (text, bad = false) =>
    `<li${bad ? ' class="bad"' : ''}>${escapeHTML(text)}</li>`;

  if (!check) {
    box.className = 'report error';
    box.innerHTML =
      '<p class="report-title">Couldn\'t load that</p>' + `<p>${escapeHTML(note)}</p>`;
    return;
  }

  const { errors, warnings, stats } = check;
  const notes = state.festivalNotes || [];
  const name = state.festivalLoadedName || 'the festival';
  const title = errors.length
    ? `Not usable yet — ${plural(errors.length, 'problem')} to fix`
    : `Loaded ${name} · ${plural(stats.films, 'film')}, ${plural(stats.screenings, 'screening')}`;
  const lead = errors.length
    ? 'Fix these in the file and load it again:'
    : `It works on this device now${
        stats.days ? `: ${plural(stats.days, 'day')}, ${dateRange(stats.from, stats.to)}` : ''
      }.${warnings.length || notes.length ? ' Worth checking:' : ''}`;
  const list = [
    ...errors.slice(0, 6).map((text) => item(text, true)),
    ...notes.map((text) => item(text)),
    ...warnings.slice(0, 5).map((text) => item(text)),
  ].join('');

  box.className = `report${errors.length ? ' error' : ''}`;
  box.innerHTML =
    `<p class="report-title">${escapeHTML(title)}</p>` +
    `<p>${escapeHTML(lead)}</p>` +
    (list ? `<ul>${list}</ul>` : '') +
    (note ? `<p>${escapeHTML(note)}</p>` : '');
}

function useFestival(data, { external = false, notes = [], problems = [] } = {}) {
  // Check before use: a missing date or a mismatched title produces a plan
  // with silent holes in it, which is worse than a refusal.
  const check = validateFestival(data);
  check.errors.push(...problems);
  state.festivalCheck = check;
  state.festivalNotes = notes;
  state.festivalLoadedName = data?.festival;
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
  state.openCards = new Set();

  // Commitments already on the festival file are a starting point, not a
  // decision - the person can delete them.
  if (data.sample_commitments?.length && state.commitments.length === 0) {
    state.commitments = data.sample_commitments.map((c) => ({ ...c }));
  }
  renderCommitments();
  renderFestivals();
  score();
  updateChrome();
}

/* ---------- step 3: commitments ---------- */

function addCommitmentRow(commitment = null) {
  state.commitments.push(
    commitment || { date: state.festival?.days?.[0] || '', window: '', label: '' }
  );
  renderCommitments();
  // Focus the new row's time, the field people most often need to type.
  $('#commitments').lastElementChild?.querySelector('[data-field=window]')?.focus();
}

function renderCommitments() {
  const box = $('#commitments');
  box.innerHTML = '';
  const days = state.festival?.days || [];

  state.commitments.forEach((commitment, index) => {
    const row = document.createElement('div');
    row.className = 'commitment';
    row.innerHTML =
      `<input type="date" value="${escapeAttribute(commitment.date || '')}" data-field="date"` +
      (days.length ? ` min="${days[0]}" max="${days[days.length - 1]}"` : '') +
      ' aria-label="Day">' +
      `<input type="text" value="${escapeAttribute(commitment.window || '')}" data-field="window"` +
      ' placeholder="e.g. 6:00 PM - 8:00 PM" aria-label="Time">' +
      `<input type="text" value="${escapeAttribute(commitment.label || '')}" data-field="label"` +
      ' placeholder="e.g. Dentist" aria-label="What">' +
      '<button class="remove" data-remove aria-label="Remove this commitment">×</button>';

    row.querySelectorAll('input').forEach((input) =>
      input.addEventListener('change', () => {
        commitment[input.dataset.field] = input.value;
        const unreadable =
          input.dataset.field === 'window' && input.value && !parseCommitment(commitment);
        input.setCustomValidity(unreadable ? 'Use a range like 6:00 PM - 8:00 PM' : '');
        input.classList.toggle('invalid', Boolean(unreadable));
        if (unreadable) input.reportValidity();
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
  const found = [];

  if (/BEGIN:VCALENDAR/i.test(text)) {
    const events = text.split(/BEGIN:VEVENT/i).slice(1);
    for (const event of events) {
      const start = event.match(/DTSTART[^:]*:(\d{8})T?(\d{2})?(\d{2})?/i);
      const end = event.match(/DTEND[^:]*:(\d{8})T?(\d{2})?(\d{2})?/i);
      const summary = event.match(/SUMMARY:(.*)/i);
      if (!start) continue;
      const date = `${start[1].slice(0, 4)}-${start[1].slice(4, 6)}-${start[1].slice(6, 8)}`;
      found.push({
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
        found.push({ date, window: `${start} - ${end}`, label: label || 'busy' });
      }
    }
  }

  // A whole work calendar is mostly irrelevant; only festival days matter.
  const days = new Set(state.festival?.days || []);
  const kept = days.size ? found.filter((c) => days.has(c.date)) : found;
  state.commitments.push(...kept);

  const report = $('#commitments-report');
  report.hidden = false;
  report.className = `report${kept.length ? '' : ' error'}`;
  const skipped = found.length - kept.length;
  report.innerHTML =
    `<p class="report-title">${
      kept.length
        ? `Added ${kept.length} ${kept.length === 1 ? 'commitment' : 'commitments'} from ${escapeHTML(file.name)}`
        : `Nothing added from ${escapeHTML(file.name)}`
    }</p>` +
    (skipped
      ? `<p class="muted small">${skipped} ${skipped === 1 ? 'event' : 'events'} outside the festival's dates ${
          skipped === 1 ? 'was' : 'were'
        } left out.</p>`
      : '') +
    (!found.length ? '<p class="muted small">No events with a date and time were found in it.</p>' : '');

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
  updateChrome();
}

/** Five diamonds, filled to the rounded prediction. */
function diamonds(value) {
  const filled = Math.max(0, Math.min(5, Math.round(value)));
  return (
    `<span class="diamonds" role="img" aria-label="Predicted ${value.toFixed(1)} out of 5">` +
    '<i></i>'.repeat(filled) +
    '<i class="off"></i>'.repeat(5 - filled) +
    '</span>'
  );
}

const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Thriller · Drama · 89 min", the facts that decide a glance. */
function filmFacts(film) {
  const genres = film.entities?.genre?.length
    ? film.entities.genre.slice(0, 2).map(capitalise)
    : film.genre
      ? [film.genre]
      : [];
  return [...genres, film.runtime ? `${film.runtime} min` : ''].filter(Boolean).join(' · ');
}

function clock(minutes) {
  const [time, ampm] = formatTime(minutes).split(' ');
  return `<span class="clock">${time}</span><span class="ampm">${ampm}</span>`;
}

function hoursText(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (!hours) return `${rest} min`;
  return rest ? `${hours}h ${rest}m` : `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function renderPlan() {
  const strength = profileStrength(state.library.length);
  $('#strength').className = `strength ${strength.level}`;
  $('#strength').innerHTML = `<b>${escapeHTML(strength.headline)}.</b>${escapeHTML(strength.detail)}`;

  const single = onlyChances(state.schedule);
  const plan = $('#plan');
  plan.innerHTML = '';

  for (const day of state.schedule.days) {
    if (!day.picks.length) continue;

    const section = document.createElement('section');
    section.className = 'day';
    const when = new Date(`${day.date}T12:00:00`);
    const weekday = when.toLocaleDateString(undefined, { weekday: 'long' });
    const date = when.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
    const gaps = findGaps(day);
    const free = gaps.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
    section.innerHTML =
      `<div class="day-head"><h3 class="weekday">${escapeHTML(weekday)}</h3>` +
      `<span class="date">${escapeHTML(date)}</span>` +
      `<span class="summary">${day.picks.length} ${day.picks.length === 1 ? 'film' : 'films'}` +
      `${free ? ` · ${hoursText(free)} free` : ''}</span></div>`;

    // Picks and gaps interleave by start time, so the day reads top to bottom.
    const entries = [
      ...day.picks.map((pick) => ({ start: pick.start, row: () => pickRow(day, pick, single) })),
      ...gaps.map((gap) => ({ start: gap.start, row: () => gapRow(day, gap) })),
    ].sort((a, b) => a.start - b.start);
    for (const entry of entries) {
      const row = entry.row();
      if (row) section.appendChild(row);
    }
    plan.appendChild(section);
  }

  renderMissed(plan);
  renderDropped(plan);
  renderRatingsShare();
}

function pickRow(day, pick, single) {
  const film = pick.film;
  const id = screeningId(pick);
  const unrated = film.scoreable === false;
  const bodyId = `card-${id.replace(/[^a-z0-9]/gi, '-')}`;

  const badges =
    (film.kind === 'event' ? '<span class="badge">Event</span>' : '') +
    (unrated ? '<span class="badge">Not rated</span>' : '') +
    (film.confidence === 'low' && !unrated ? '<span class="badge">Little to go on</span>' : '') +
    (single.has(film.title) ? '<span class="badge hot">Only chance</span>' : '') +
    (pick.pinned ? '<span class="badge">Your pick</span>' : '');

  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML =
    `<div class="time">${clock(pick.start)}</div>` +
    '<div class="rail"><i class="marker"></i></div>' +
    `<article class="card">` +
    `<button class="card-head" aria-expanded="false" aria-controls="${bodyId}">` +
    poster(film) +
    `<span class="card-title"><span class="name">${escapeHTML(film.title)}</span>` +
    `<span class="meta">${escapeHTML(filmFacts(film))}${badges}</span></span>` +
    `<span class="card-side">${unrated ? '' : diamonds(film.prediction)}<span class="chev" aria-hidden="true"></span></span>` +
    `</button>` +
    `<div class="card-body" id="${bodyId}"><div class="clip">` +
    `<div class="card-detail">${filmDetails(film, pick, badges)}</div>` +
    `</div></div></article>`;

  const card = row.querySelector('.card');
  const head = row.querySelector('.card-head');
  const clip = row.querySelector('.clip');
  const setOpen = (open) => {
    card.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    // Closed detail stays out of the tab order and away from screen readers.
    clip.inert = !open;
    if (open) state.openCards.add(id);
    else state.openCards.delete(id);
  };
  setOpen(state.openCards.has(id));
  head.addEventListener('click', () => setOpen(!card.classList.contains('open')));

  row.querySelector('[data-drop]').addEventListener('click', () => {
    state.excluded.add(film.title);
    state.pinned.delete(id);
    state.openCards.delete(id);
    rebuild();
  });
  row.querySelector('[data-swap]').addEventListener('click', () => {
    const existing = clip.querySelector('.alternatives');
    if (existing) return existing.remove();
    clip.appendChild(alternativesPanel(day, pick));
  });
  return row;
}

/**
 * What else was showing at that time, so a pick can be overruled knowingly.
 * Shown inline rather than in a dialog: choosing between films means reading
 * what they are, and a one-line prompt can't show that.
 *
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
      state.openCards.delete(screeningId(entry));
    }
  }
  state.excluded.delete(chosen.film.title);
  state.pinned.add(screeningId(chosen));
}

function altRow(entry, { label, action, primary = false, extraBadge = '' }) {
  const film = entry.film;
  return (
    `<div class="alt"><div>` +
    `<div class="alt-title">${escapeHTML(film.title)}` +
    (film.kind === 'event' ? '<span class="badge">Event</span>' : '') +
    (entry.blockedBy ? '<span class="badge">During a commitment</span>' : '') +
    extraBadge +
    `</div>` +
    `<p class="detail"><span class="when">${formatTime(entry.start)}</span>` +
    `${film.runtime ? ` · ${film.runtime} min` : ''}` +
    (film.scoreable === false
      ? ' · Not rated — your call'
      : ` · Predicted ${film.prediction.toFixed(1)}★`) +
    (film.synopsis ? `<span class="syn">${escapeHTML(film.synopsis)}</span>` : '') +
    `</p></div>` +
    `<button class="btn${primary ? ' primary' : ''}" data-${action}>${label}</button></div>`
  );
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

  const panel = document.createElement('div');
  panel.className = 'alternatives';
  if (!options.length) {
    panel.innerHTML = '<p class="intro">Nothing else is showing in that slot.</p>';
    return panel;
  }
  panel.innerHTML =
    `<p class="intro">Also showing against ${escapeHTML(pick.film.title)}</p>` +
    options.map((entry) => altRow(entry, { label: 'Use this instead', action: 'pick' })).join('');

  panel.querySelectorAll('[data-pick]').forEach((button, index) =>
    button.addEventListener('click', () => {
      pinInstead(day, options[index]);
      state.openCards.add(screeningId(options[index]));
      rebuild();
    })
  );
  return panel;
}

const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const escapeAttribute = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Poster, or a labelled placeholder. Posters come from the festival file, and
 * a premiere often has no artwork anywhere yet - initials explain themselves
 * better than a broken-image icon. The image host is told nothing about which
 * page asked for it, and a link that fails to load falls back to initials.
 */
function poster(film) {
  if (isPosterURL(film.poster)) {
    return `<img class="poster" src="${escapeAttribute(film.poster)}" alt=""
      loading="lazy" decoding="async" referrerpolicy="no-referrer" width="56" height="84"
      data-initials="${escapeAttribute(initials(film))}">`;
  }
  return `<span class="poster empty" aria-hidden="true">${escapeHTML(initials(film))}</span>`;
}

function initials(film) {
  return String(film.title || '?')
    .replace(/^(the|a|an) /i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] || '')
    .join('')
    .toUpperCase();
}

// A poster link that has moved or expired shows initials instead of a hole.
document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('poster')) return;
    const fallback = document.createElement('span');
    fallback.className = 'poster empty';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = img.dataset.initials || '';
    img.replaceWith(fallback);
  },
  true
);

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
    .replace(/[̀-ͯ]/g, '')
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

/** Say what the score was actually built on. */
function reasonText(film) {
  const people = film.reasons?.people
    ?.map(
      (person) =>
        `you rated ${person.films} ${person.films === 1 ? 'film' : 'films'} with ` +
        `${person.name} ${person.average.toFixed(1)}★`
    )
    .join('; ');
  const themes = film.reasons?.keywords?.length
    ? `themes you've rated before: ${film.reasons.keywords.join(', ')}`
    : '';
  const genres = film.reasons?.genres
    ?.map(
      (genre) =>
        `you rate ${genre.name} ${genre.average.toFixed(1)}★ on average across ${genre.films} films`
    )
    .join('; ');
  return (
    [people, themes, genres].filter(Boolean).join('; ') ||
    'nothing in your history connects to this one, so it was scored on its description alone'
  );
}

/** What's worth knowing before deciding: why, the synopsis, then the credits. */
function filmDetails(film, pick, badges) {
  const rows = [];
  const people = film.entities || {};
  if (people.director?.length) rows.push(['Director', peopleLinks(people.director, 'director')]);
  if (people.writer?.length) rows.push(['Writer', peopleLinks(people.writer.slice(0, 3), 'writer')]);
  if (people.cast?.length) rows.push(['Cast', peopleLinks(people.cast.slice(0, 5), 'actor')]);
  if (film.country) rows.push(['Country', escapeHTML(film.country)]);
  if (film.section) rows.push(['Section', escapeHTML(film.section)]);
  const ends = pick.start + (film.runtime || 0);
  rows.push(['Showing', `${formatTime(pick.start)}${film.runtime ? `–${formatTime(ends)}` : ''}`]);

  const unrated = film.scoreable === false;
  const hasLinks = people.director?.length || people.cast?.length;
  // Names, themes and genres come from film data, so everything is escaped.
  return (
    `<div class="stack">` +
    `<p class="meta mobile-meta">${escapeHTML(filmFacts(film))}${badges}</p>` +
    `<p class="why"><b>Why it's here:</b>${
      unrated ? 'No ratings history can predict this one — your call.' : `${escapeHTML(capitalise(reasonText(film)))}.`
    }</p>` +
    (film.synopsis
      ? `<p class="synopsis">${escapeHTML(film.synopsis)}</p>`
      : '<p class="synopsis none">No synopsis published.</p>') +
    `<div class="card-actions"><button class="btn" data-swap>Swap for another film</button>` +
    `<button class="btn quiet" data-drop>Drop</button></div>` +
    `</div>` +
    `<div class="stack"><dl class="credits">${rows
      .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
      .join('')}</dl>` +
    (hasLinks
      ? '<p class="caveat">Name links go to Letterboxd. A first-time director may not have a page yet.</p>'
      : '') +
    `</div>`
  );
}

// A gap shorter than this can't hold a film, so it isn't worth offering.
const SHORTEST_USEFUL_GAP = 45;

/**
 * Free stretches of a day that something could fill.
 *
 * This is also how a film comes back after being dropped by accident: the
 * gap it left is visible, and everything that fits it - including the thing
 * just dropped - is one click away.
 */
function findGaps(day) {
  const picks = [...day.picks].sort((a, b) => a.start - b.start);
  const candidates = day.all.filter((entry) => entry.film && !entry.blockedBy);
  if (!candidates.length) return [];

  const dayStart = Math.min(...candidates.map((entry) => entry.start));
  const dayEnd = Math.max(...candidates.map((entry) => entry.end));

  const gaps = [];
  let cursor = dayStart;
  for (const pick of picks) {
    if (pick.start - cursor >= SHORTEST_USEFUL_GAP) gaps.push({ start: cursor, end: pick.start });
    cursor = Math.max(cursor, pick.end);
  }
  if (dayEnd - cursor >= SHORTEST_USEFUL_GAP) gaps.push({ start: cursor, end: dayEnd });

  return gaps
    .map((gap) => ({
      ...gap,
      fits: day.all
        .filter(
          (entry) =>
            entry.film &&
            !entry.blockedBy &&
            entry.start >= gap.start &&
            entry.end <= gap.end &&
            !picks.some((pick) => pick.film.title === entry.film.title)
        )
        .sort((a, b) => (b.film.prediction || 0) - (a.film.prediction || 0)),
    }))
    .filter((gap) => gap.fits.length);
}

const FITS_SHOWN = 3;

function gapRow(day, gap) {
  const { fits } = gap;
  // At the daily limit, adding a film pushes the weakest pick out. Say so
  // before it happens rather than letting a film silently vanish.
  const limit = Number($('#max-per-day').value) || Infinity;
  const full = day.picks.length >= limit;
  const row = document.createElement('div');
  row.className = 'row free';
  row.innerHTML =
    `<div class="time">${clock(gap.start)}</div>` +
    '<div class="rail"><i class="marker hollow"></i></div>' +
    `<div class="free-box">` +
    `<div class="free-head"><div><p class="name">Nothing planned</p>` +
    `<p class="meta">${hoursText(gap.end - gap.start)} free, until ${formatTime(gap.end)} · ` +
    `${fits.length} ${fits.length === 1 ? 'film fits' : 'films fit'}</p>` +
    (full
      ? `<p class="meta full-note">This day already has ${limit} films, your limit — adding one ` +
        'replaces your lowest-rated pick. Raise the limit on Your time to keep both.</p>'
      : '') +
    `</div></div>` +
    `<div class="alternatives">${fits
      .map((entry, index) =>
        altRow(entry, {
          label: 'Add',
          action: 'add',
          primary: true,
          extraBadge: state.excluded.has(entry.film.title)
            ? '<span class="badge">You dropped this</span>'
            : '',
        }).replace('<div class="alt"', `<div class="alt"${index >= FITS_SHOWN ? ' hidden' : ''}`)
      )
      .join('')}` +
    (fits.length > FITS_SHOWN
      ? `<p><button class="linkish" data-more>Show ${fits.length - FITS_SHOWN} more</button></p>`
      : '') +
    `</div></div>`;

  row.querySelectorAll('[data-add]').forEach((button, index) =>
    button.addEventListener('click', () => {
      // Adding something back is also how a drop is undone.
      pinInstead(day, fits[index]);
      rebuild();
    })
  );
  row.querySelector('[data-more]')?.addEventListener('click', (event) => {
    row.querySelectorAll('.alt[hidden]').forEach((alt) => (alt.hidden = false));
    event.target.closest('p').remove();
  });
  return row;
}

function renderMissed(plan) {
  const missed = state.schedule.missed.slice(0, 12);
  if (!missed.length) return;

  const details = document.createElement('details');
  details.className = 'fold plan-extra';
  details.innerHTML =
    `<summary>${state.schedule.missed.length} films you're missing, and why</summary>` +
    `<div class="fold-body"><ul>${missed
      .map(
        (item) =>
          `<li><span><b>${escapeHTML(item.film.title)}</b> <span class="why">— ${escapeHTML(item.reason)}${
            item.film.scoreable === false
              ? ''
              : ` (predicted ${item.film.prediction.toFixed(1)}★)`
          }</span></span></li>`
      )
      .join('')}</ul></div>`;
  plan.appendChild(details);
}

function renderDropped(plan) {
  if (!state.excluded.size) return;

  const details = document.createElement('details');
  details.className = 'fold plan-extra';
  details.innerHTML =
    `<summary>${state.excluded.size} you dropped</summary>` +
    `<div class="fold-body"><ul>${[...state.excluded]
      .map(
        (title) =>
          `<li><b>${escapeHTML(title)}</b><button class="btn" ` +
          `data-undrop="${escapeAttribute(title)}">Put back</button></li>`
      )
      .join('')}</ul></div>`;
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

/** The title shows the festival once there is one; the steps show progress. */
function updateChrome() {
  const name = state.festival?.festival;
  const match = name?.match(/^(.*\S)\s+(\d{4})$/);
  $('#masthead-kicker').textContent = name ? "Meta's Nifty Film Fest Scheduler" : "Meta's Nifty";
  $('#masthead-name').textContent = name ? (match ? match[1] : name) : 'Film Fest';
  $('#masthead-year').textContent = name ? (match ? match[2] : '') : 'Scheduler';
  $('#masthead-year').hidden = Boolean(name && !match);
  document.title = name ? `${name} · Meta's Nifty Film Fest Scheduler` : "Meta's Nifty Film Fest Scheduler";

  const done = {
    1: state.library.length > 0,
    2: Boolean(state.festival),
    3: Boolean(state.schedule),
    4: false,
  };
  $$('.step').forEach((button) => {
    const step = Number(button.dataset.step);
    const current = step === state.step;
    if (current) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.classList.toggle('done', done[step] && !current);
    button.classList.toggle('lit', step > 1 && done[step - 1]);
  });
  $('#to-festival').disabled = !done[1];
  $('#to-time').disabled = !done[2];
}

function showStep(step) {
  state.step = step;
  $$('.panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${step}`;
  });
  updateChrome();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

boot();
