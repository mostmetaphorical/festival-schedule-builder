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
import { BundleProvider, MetadataCache, resolveLibrary } from './metadata.js';
import { WikidataProvider } from './wikidata.js';
import { profileStrength } from './recommend.js';
import { BlendRecommender } from './blend.js';
import {
  buildSchedule,
  formatTime,
  onlyChances,
  parseCommitment,
  parseTime,
  QA_MINUTES,
  screeningId,
  tailFor,
} from './schedule.js';
import { downloadHTML, downloadICS, restoreFromHTML } from './export.js';
import {
  downloadFestival,
  mailtoURL,
  validateFestival,
} from './festival-io.js';
import { festivalFromCSV, isPosterURL, looksLikeCSV } from './festival-csv.js';
import { commitmentsFromText } from './commitments-io.js';
import { mailto, revealContact } from './contact.js';
import {
  MIN_RATINGS_TO_SHARE,
  botCheck,
  countVisit,
  sendReport,
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
  // Screenings a swap elsewhere left in place. Swapping one film shouldn't
  // rearrange the rest of the plan, so everything else is held where it was.
  kept: new Set(),
  excluded: new Set(),
  // Time slots emptied by dropping a film, kept free until the person fills
  // them: [{title, date, start, end}].
  held: [],
  // Film cards the person has opened, kept open across re-renders so a swap
  // or a preference change doesn't snap everything shut.
  openCards: new Set(),
  // Free-time boxes the person opened; closed by default, so a long break can
  // simply be a break.
  openGaps: new Set(),
  schedule: null,
  step: 1,
  // Live lookups send film titles to Wikidata, so they only happen once the
  // person asks for them.
  lookUpMissing: false,
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
  const json = (path) => fetch(path).then((r) => r.json());
  const [model, idf, stopwords, festivals, genreModel, blend, track] = await Promise.all([
    json('data/model.json'),
    json('data/idf.json'),
    json('data/stopwords.json'),
    json('data/festivals.json'),
    json('data/model-genre.json'),
    json('data/blend.json'),
    json('data/track.json'),
  ]);

  recommender = new BlendRecommender(model, idf, stopwords, { genreModel, blend, track });
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

  $('#look-up-missing').addEventListener('click', lookUpMissing);
  $('#add-commitment').addEventListener('click', () => addCommitmentRow());
  fileZone($('#commitments-drop'), $('#commitments-file'), importCommitments);

  $$('.step-btn').forEach((button) =>
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.for);
      const next = Number(input.value || 0) + Number(button.dataset.delta);
      input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
      input.dispatchEvent(new Event('change'));
    })
  );
  $('#max-per-day').addEventListener('change', replan);
  $('#buffer').addEventListener('change', replan);
  $('#to-plan').addEventListener('click', () => {
    rebuild();
    showStep(4);
  });

  fileZone($('#festival-drop'), $('#festival-file'), async (file) => {
    loadFestivalText(await file.text(), { name: file.name });
  });
  $('#festival-update').addEventListener('click', (event) => {
    const picker = $('#update-picker');
    picker.hidden = !picker.hidden;
    event.currentTarget.setAttribute('aria-expanded', String(!picker.hidden));
    if (!picker.hidden) $('#update-festival').focus();
  });
  $('#update-choose').addEventListener('click', () => $('#festival-update-file').click());
  $('#festival-update-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const target = $('#update-festival').value;
    // Updating a festival that isn't the one in use switches to it first, so
    // the update is compared with what was published.
    if (target && target !== state.festival?.festival) {
      const listed = state.festivalIndex?.festivals?.find((festival) => festival.name === target);
      if (listed?.data) {
        try {
          await chooseListed(listed);
        } catch (error) {
          reportFestival(null, `Couldn't load ${target} to update it.`, $('#festival-update-report'));
          return;
        }
      }
    }
    loadFestivalText(await file.text(), { name: file.name, update: true, target });
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
  wireReport();

  // The contact address is only assembled once someone opens the emailing
  // instructions, so it isn't sitting in the page for harvesters.
  $$('details').forEach((fold) =>
    fold.addEventListener('toggle', () => {
      if (fold.open && fold.querySelector('[data-contact]')) revealContact(fold);
    })
  );

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
  // The bundle first; only what it doesn't cover goes to Wikidata, and only
  // once the person has asked for that.
  let result = await resolveLibrary(state.ratings, bundle);
  if (state.lookUpMissing && result.missing.length) {
    const live = new WikidataProvider(cache);
    const rest = await resolveLibrary(result.missing, live, (done, total) =>
      setStatus(`Looking up ${done} of ${total} films on Wikidata…`)
    );
    result = {
      resolved: [...result.resolved, ...rest.resolved],
      missing: rest.missing,
    };
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
  // No automatic move to the next step: the films that couldn't be matched,
  // and the option to look them up, are on this one. Next moves on.
}

function renderMissing() {
  const box = $('#missing-list');
  const count = state.missing.length;
  // Once looked up, whatever is still missing isn't on Wikidata either.
  $('#look-up-missing').disabled = !count || state.lookUpMissing;
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

function lookUpMissing() {
  if (!state.missing.length) return;
  state.lookUpMissing = true;
  $('#look-up-missing').disabled = true;
  setStatus('Looking up the films that weren\'t in the bundled list…');
  resolve().finally(() => {
    $('#look-up-missing').disabled = !state.missing.length;
  });
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
  // The disclaimer and update button sit below the festivals you can choose.
  const currency = $('#festival-currency');
  list.innerHTML = '';
  const festivals = state.festivalIndex?.festivals || [];
  // Over is over by the person's own calendar: a festival that ended before
  // today moves to Past festivals, and a placeholder whose dates have passed
  // has nothing left to say.
  const today = new Date().toLocaleDateString('en-CA');
  const over = (f) => Boolean(f.ends) && f.ends < today;
  const ready = festivals.filter((f) => f.status === 'ready' && !over(f));
  const past = festivals.filter((f) => f.status === 'ready' && over(f));
  const planned = festivals.filter((f) => f.status !== 'ready' && !over(f));
  // A festival loaded from a file gets a card too, so it can be seen and updated.
  const loaded =
    state.festival && ![...ready, ...past].some((festival) => festival.name === state.festival.festival)
      ? {
          name: state.festival.festival,
          source: 'Loaded from your file, on this device only',
        }
      : null;
  const cards = [...(loaded ? [loaded] : []), ...ready, ...past];

  const card = (festival) => {
    const selected = state.festival?.festival === festival.name;
    const stats = selected ? state.festivalCheck?.stats : null;
    const age = selected && state.festivalAge ? state.festivalAge : {};
    const uploaded = age.captured || age.uploaded || festival.captured || '';
    const starts = festival.starts || stats?.from || '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'festival';
    button.setAttribute('aria-pressed', String(selected));
    button.innerHTML =
      `<span class="when">${starts ? dateRange(starts, festival.ends || stats?.to) : ''}` +
      `<small>${escapeHTML(starts.slice(0, 4))}</small></span>` +
      `<span><span class="name">${escapeHTML(festival.name)}</span>` +
      `<span class="meta">${escapeHTML(festival.city || '')}${
        stats
          ? `${festival.city ? ' · ' : ''}${stats.films === 1 ? '1 film' : `${stats.films} films and events`} ·${plural(stats.screenings, 'screening')}`
          : ''
      }</span>` +
      `<span class="source">${
        /^\d{4}-\d{2}-\d{2}/.test(uploaded)
          ? `Listings uploaded ${escapeHTML(longDate(uploaded.slice(0, 10)))}`
          : 'Upload date unknown'
      }${festival.source ? ` · ${escapeHTML(festival.source)}` : ''}</span>` +
      `</span>` +
      `<span class="pick">${selected ? 'Selected' : 'Choose'}</span>`;
    button.addEventListener('click', async () => {
      if (selected) return showStep(3);
      button.querySelector('.pick').textContent = 'Loading…';
      try {
        await chooseListed(festival);
        if (!state.festivalCheck.errors.length) showStep(3);
      } catch (error) {
        button.querySelector('.pick').textContent = 'Try again';
      }
    });
    return button;
  };
  for (const festival of [...(loaded ? [loaded] : []), ...ready]) list.appendChild(card(festival));
  list.appendChild(currency);

  // Everything that has a schedule can be updated.
  const select = $('#update-festival');
  const previous = select.value;
  select.innerHTML = cards
    .map((festival) => `<option>${escapeHTML(festival.name)}</option>`)
    .join('');
  const preferred = state.festival?.festival || previous;
  if (cards.some((festival) => festival.name === preferred)) select.value = preferred;

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

  // Festivals that have ended stay usable - their films are still worth
  // knowing about - but out of the way, most recent first.
  if (past.length) {
    const fold = document.createElement('details');
    fold.className = 'fold past-festivals';
    fold.open = past.some((festival) => festival.name === state.festival?.festival);
    fold.innerHTML = `<summary>Past festivals <span class="summary-note">· ${past.length}</span></summary>`;
    const body = document.createElement('div');
    body.className = 'past-list';
    [...past].sort((a, b) => b.ends.localeCompare(a.ends)).forEach((festival) => body.appendChild(card(festival)));
    fold.appendChild(body);
    list.appendChild(fold);
  }
}

/** Load one of the listed festivals. */
async function chooseListed(festival) {
  const data = await fetch(festival.data).then((r) => r.json());
  useFestival(data, { captured: data.captured || festival.captured || '' });
}

/** Read a festival from spreadsheet or JSON text, whichever it is. */
function loadFestivalText(text, { name = '', update = false, target = '' } = {}) {
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
    reportFestival(null, message, update ? $('#festival-update-report') : undefined);
    return;
  }
  // The person said which festival the update is for; a file that spells the
  // name differently ("Fantastic Fest" for "Fantastic Fest 2026") still is.
  const renamed =
    update && target && parsed.data && typeof parsed.data === 'object' && parsed.data.festival !== target
      ? parsed.data.festival || '(no name)'
      : '';
  if (renamed) {
    parsed.data.festival = target;
    parsed.notes.push(`The file calls it "${renamed}"; it was treated as ${target}, as chosen.`);
  }
  useFestival(parsed.data, {
    external: true,
    notes: parsed.notes,
    problems: parsed.problems,
    update,
    // A JSON file can say when its listings were captured; otherwise the
    // day it was uploaded here is the best available answer.
    captured: parsed.data?.captured || '',
    uploaded: new Date().toLocaleDateString('en-CA'),
  });
}

const longDate = (date) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

/**
 * What changed between two versions of a festival's schedule. Screenings are
 * matched on title, date and the time it means, so "7:30 PM" and "19:30" are
 * the same showing.
 */
function screeningKey(screening) {
  return `${screening.film}@${screening.date}@${parseTime(screening.time)}`;
}

function compareSchedules(before, after) {
  const oldKeys = new Map(before.screenings.map((s) => [screeningKey(s), s]));
  const newKeys = new Map(after.screenings.map((s) => [screeningKey(s), s]));
  let removed = [...oldKeys].filter(([key]) => !newKeys.has(key)).map(([, s]) => s);
  let added = [...newKeys].filter(([key]) => !oldKeys.has(key)).map(([, s]) => s);
  // One showing gone and one new for the same film reads as a move.
  const moved = [];
  for (const title of new Set(removed.map((s) => s.film))) {
    const gone = removed.filter((s) => s.film === title);
    const fresh = added.filter((s) => s.film === title);
    if (gone.length === 1 && fresh.length === 1) moved.push({ from: gone[0], to: fresh[0] });
  }
  removed = removed.filter((s) => !moved.some((move) => move.from === s));
  added = added.filter((s) => !moved.some((move) => move.to === s));
  const oldTitles = new Set(before.films.map((film) => film.title));
  const newTitles = new Set(after.films.map((film) => film.title));
  return {
    removed,
    added,
    moved,
    newFilms: [...newTitles].filter((title) => !oldTitles.has(title)),
    goneFilms: [...oldTitles].filter((title) => !newTitles.has(title)),
  };
}

const showing = (s) => `${weekdayName(s.date).slice(0, 3)} ${formatTime(parseTime(s.time))}`;

/**
 * Carry the person's decisions over to the new schedule: a pick follows its
 * screening if it still exists, a drop follows its film.
 */
function carryOver(before, after, changes) {
  // The plan as it stands is held, so an update only touches what changed.
  keepPlan();
  const idsNow = new Map(after.screenings.map((s) => [screeningKey(s), screeningId(s)]));
  const keyOf = new Map(before.screenings.map((s) => [screeningId(s), screeningKey(s)]));
  const titles = new Set(after.films.map((film) => film.title));
  const lostPicks = [];
  const remap = (set, { report }) =>
    new Set(
      [...set].flatMap((id) => {
        const now = idsNow.get(keyOf.get(id));
        if (now) return [now];
        if (titles.has(id)) return [id];
        if (report) lostPicks.push(before.screenings.find((s) => screeningId(s) === id));
        return [];
      })
    );
  const planned = new Set(
    (state.schedule?.days || []).flatMap((day) => day.picks.map((pick) => screeningId(pick)))
  );
  const lostPlanned = [...changes.removed, ...changes.moved.map((move) => move.from)].filter(
    (s) => planned.has(screeningId(s)) && !state.pinned.has(screeningId(s))
  );  state.pinned = remap(state.pinned, { report: true });
  state.kept = remap(state.kept, { report: false });
  state.excluded = new Set([...state.excluded].filter((title) => titles.has(title)));
  state.held = state.held.filter((window) => titles.has(window.title));
  return [...lostPicks.filter(Boolean), ...lostPlanned];
}

function reportUpdate(changes, lost) {
  const box = $('#festival-update-report');
  const list = (items) => `<ul>${items.map((text) => `<li>${escapeHTML(text)}</li>`).join('')}</ul>`;
  const lines = [...(state.festivalNotes || [])];
  for (const s of lost) {
    const move = changes.moved.find((each) => each.from === s);
    lines.push(
      move
        ? `${s.film} was in your plan at ${showing(s)} and has moved to ${showing(move.to)}. ` +
            'Its old slot is empty; add it at the new time if it still fits.'
        : `${s.film} (${showing(s)}) was in your plan and is no longer listed at that time.`
    );
  }
  const parts = [
    changes.moved.length ? `${plural(changes.moved.length, 'screening')} moved` : '',
    changes.removed.length ? `${plural(changes.removed.length, 'screening')} removed` : '',
    changes.added.length ? `${plural(changes.added.length, 'screening')} added` : '',
    changes.newFilms.length ? plural(changes.newFilms.length, 'new film') : '',
    changes.goneFilms.length ? `${plural(changes.goneFilms.length, 'film')} gone` : '',
  ].filter(Boolean);
  const summary = parts.length ? `${capitalise(parts.join(', '))}.` : 'No screenings changed.';
  const LISTED = 8;
  lines.push(
    ...changes.moved.slice(0, LISTED).map(
      ({ from, to }) => `Moved: ${from.film}, ${showing(from)} → ${showing(to)}`
    ),
    ...changes.removed.slice(0, LISTED).map((s) => `Removed: ${s.film}, ${showing(s)}`),
    ...changes.added.slice(0, LISTED).map((s) => `Added: ${s.film}, ${showing(s)}`)
  );
  if ([changes.moved, changes.removed, changes.added].some((list) => list.length > LISTED)) {
    lines.push('…and more.');
  }

  box.hidden = false;
  box.className = `report${lost.length ? ' error' : ''}`;
  box.innerHTML =
    `<p class="report-title">Schedule updated</p>` +
    `<p>${escapeHTML(summary)}${
      lost.length ? ' Your plan kept everything else; the gaps show what fits now.' : ''
    }</p>` +
    (lines.length ? list(lines) : '');
}

/* ---------- sharing ---------- */

// The bot check loads Cloudflare's script, so it only loads once someone
// ticks a consent box - a visitor who never shares never contacts Cloudflare.
const bots = { ratings: null, festival: null, report: null };
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

/* ---------- bug reports ---------- */

const STEP_NAMES = { 1: 'ratings', 2: 'festival', 3: 'your-time', 4: 'plan' };

/**
 * What a report says about the device, if the box is ticked - and exactly
 * this is shown to the person before they send it. Never ratings, never
 * commitments: only what helps reproduce a bug.
 */
function reportDetails() {
  const planned = state.schedule?.days.reduce((sum, day) => sum + day.picks.length, 0) || 0;
  return {
    browser: navigator.userAgent.slice(0, 300),
    screen: `${window.innerWidth}×${window.innerHeight}`,
    festival: state.festival?.festival || 'none chosen',
    films: `${state.ratings.length} ratings imported, ${planned} films planned`,
    page: STEP_NAMES[state.step] || 'other',
    version: document.querySelector('meta[name="app-version"]')?.content || 'alpha',
  };
}

function wireReport() {
  const dialog = $('#report-dialog');
  const message = $('#report-message');
  const includeDetails = $('#report-details');
  const send = $('#report-send');

  const refresh = () => {
    const details = reportDetails();
    $('#report-preview').hidden = !includeDetails.checked;
    $('#report-preview').textContent = Object.entries(details)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');
    send.disabled = !(message.value.trim().length >= 10 && bots.report?.ready());
    // The email fallback carries the same text, so nothing typed is lost.
    const body = [
      message.value.trim(),
      includeDetails.checked ? `\n---\n${$('#report-preview').textContent}` : '',
    ].join('');
    $('#report-email').href = mailto({ subject: 'Bug report', body });
  };

  $$('[data-report]').forEach((button) =>
    button.addEventListener('click', async () => {
      $('#report-step').value = STEP_NAMES[state.step] || 'other';
      $('#report-note').textContent = '';
      refresh();
      dialog.showModal();
      message.focus();
      if (!bots.report) {
        try {
          bots.report = await botCheck($('#report-bot'), refresh);
        } catch (error) {
          $('#report-note').textContent =
            `${error.message} Sending isn't available right now — the email link still works.`;
        }
      }
    })
  );
  message.addEventListener('input', refresh);
  includeDetails.addEventListener('change', refresh);
  // A click on the backdrop closes the form, like pressing Escape.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  send.addEventListener('click', async () => {
    if (!bots.report?.ready()) return;
    const report = {
      message: message.value.trim(),
      step: $('#report-step').value,
      contact: $('#report-contact').value.trim() || undefined,
      details: includeDetails.checked ? reportDetails() : undefined,
    };
    send.disabled = true;
    send.textContent = 'Sending…';
    const result = await sendReport(report, bots.report.take());
    send.textContent = 'Send report';
    const note = $('#report-note');
    if (result.ok) {
      message.value = '';
      $('#report-contact').value = '';
      note.classList.remove('error-text');
      note.textContent = report.contact
        ? 'Sent — thank you. Any reply will go to the address you gave.'
        : 'Sent — thank you. It helps a lot.';
    } else {
      note.classList.add('error-text');
      // "Not found" means the share service doesn't have the report route -
      // an older Worker - which says nothing useful to the person sending.
      const reason = result.error === 'Not found.'
        ? "Reports can't be received right now."
        : result.error || 'Sending failed.';
      note.textContent = `${reason} Your message is still here — the email link below will send it.`;
    }
    refresh();
  });
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
function reportFestival(check, note = '', box = $('#festival-report')) {
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

function useFestival(
  data,
  { external = false, notes = [], problems = [], update = false, captured = '', uploaded = '' } = {}
) {
  // Check before use: a missing date or a mismatched title produces a plan
  // with silent holes in it, which is worse than a refusal.
  const check = validateFestival(data);
  check.errors.push(...problems);
  // An update to a different festival is just a new festival.
  const previous =
    update && state.festival && state.festival.festival === data?.festival ? state.festival : null;
  if (update && check.errors.length) {
    // Leave the festival in use alone; say what's wrong where the button is.
    state.festivalNotes = notes;
    state.festivalLoadedName = data?.festival;
    reportFestival(check, '', $('#festival-update-report'));
    return;
  }
  state.festivalCheck = check;
  state.festivalNotes = notes;
  state.festivalLoadedName = data?.festival;
  // A festival already listed in the app has nothing to share.
  state.festivalExternal = external;
  if (external && !update) reportFestival(check);
  if (update && !previous) {
    $('#festival-update-report').hidden = false;
    $('#festival-update-report').className = 'report';
    $('#festival-update-report').innerHTML =
      `<p class="report-title">Loaded as a new festival</p><p>That file is for ` +
      `${escapeHTML(data.festival)}, not ${escapeHTML(state.festival?.festival || 'the one in use')}, ` +
      'so your picks and drops were cleared.</p>';
  }

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

  if (previous) {
    const changes = compareSchedules(previous, data);
    const lost = carryOver(previous, data, changes);
    reportUpdate(changes, lost);
  } else {
    state.pinned = new Set();
    state.kept = new Set();
    state.excluded = new Set();
    state.held = [];
    state.openCards = new Set();
    if (!update) $('#festival-update-report').hidden = true;
  }
  state.festival = data;
  state.festivalAge = { captured, uploaded };

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
  state.commitments.push(commitment || { date: nextCommitmentDay(), window: '', label: '' });
  renderCommitments();
  // Focus the new row's start time, the field people most often need to set.
  $('#commitments').lastElementChild?.querySelector('[data-part=start]')?.focus();
}

/**
 * The day after the last commitment entered - people tend to list them in
 * order - or that same day if it was the festival's last. The first defaults
 * to the festival's first day.
 */
function nextCommitmentDay() {
  const days = state.festival?.days || [];
  const previous = [...state.commitments].reverse().find((c) => c.date)?.date;
  if (!previous) return days[0] || '';
  const at = days.indexOf(previous);
  if (at === -1) return previous;
  return days[Math.min(at + 1, days.length - 1)];
}

/**
 * Commitment times run from 7:00 AM to 2:00 AM, every 15 minutes - a festival
 * day, with late nights after the evening rather than at the top of the list.
 * Times are counted on from the morning, so 1:00 AM is 25 hours (1500).
 */
const DAY_START = 7 * 60;
const DAY_END = 26 * 60;
const onFromMorning = (minutes) => (minutes % 1440 < DAY_START ? (minutes % 1440) + 1440 : minutes % 1440);

/**
 * A dropdown's options between two times. A time outside them (from an
 * imported calendar) is kept, so loading a plan never changes a commitment.
 */
function timeOptions({ from, to, selected, placeholder }) {
  const minutes = [];
  for (let m = from; m <= to; m += 15) minutes.push(m);
  if (selected != null && !minutes.includes(selected)) {
    minutes.push(selected);
    minutes.sort((a, b) => a - b);
  }
  return (
    `<option value="">${placeholder}</option>` +
    minutes
      .map((m) => `<option value="${m}"${m === selected ? ' selected' : ''}>${formatTime(m)}</option>`)
      .join('')
  );
}

const startOptions = (selected) =>
  timeOptions({ from: DAY_START, to: DAY_END - 15, selected, placeholder: 'Start' });

// Only times after the start are offered as the end.
const endOptions = (start, selected) =>
  timeOptions({ from: start == null ? DAY_START + 15 : start + 15, to: DAY_END, selected, placeholder: 'End' });

function renderCommitments() {
  const box = $('#commitments');
  box.innerHTML = '';
  const days = state.festival?.days || [];

  state.commitments.forEach((commitment, index) => {
    const parsed = commitment.window ? parseCommitment(commitment) : null;
    const startAt = parsed ? onFromMorning(parsed.start) : null;
    const endAt = parsed ? onFromMorning(parsed.end) : null;
    const row = document.createElement('div');
    row.className = 'commitment';
    row.innerHTML =
      `<input type="date" value="${escapeAttribute(commitment.date || '')}" data-field="date"` +
      (days.length ? ` min="${days[0]}" max="${days[days.length - 1]}"` : '') +
      ' aria-label="Day">' +
      // Two dropdowns rather than free text or the browser's time input,
      // which behaves differently in every browser.
      `<span class="time-range" data-field="window">` +
      `<select data-part="start" aria-label="Starts"${startAt == null ? ' class="empty"' : ''}>${startOptions(startAt)}</select>` +
      '<span class="to" aria-hidden="true">to</span>' +
      `<select data-part="end" aria-label="Ends"${endAt == null ? ' class="empty"' : ''}>${endOptions(startAt, endAt)}</select>` +
      `<span class="overnight"${startAt < 1440 && endAt > 1440 ? '' : ' hidden'}>+1 day</span>` +
      '</span>' +
      `<input type="text" value="${escapeAttribute(commitment.label || '')}" data-field="label"` +
      ' placeholder="e.g. Dentist" aria-label="What">' +
      '<button class="remove" data-remove aria-label="Remove this commitment">×</button>';

    row.querySelectorAll('input[data-field]').forEach((input) =>
      input.addEventListener('change', () => {
        commitment[input.dataset.field] = input.value;
        replan();
      })
    );
    const start = row.querySelector('[data-part=start]');
    const end = row.querySelector('[data-part=end]');
    const overnight = row.querySelector('.overnight');
    const syncTime = () => {
      const complete = Boolean(start.value && end.value);
      const s = Number(start.value);
      const e = Number(end.value);
      start.classList.toggle('empty', !start.value);
      end.classList.toggle('empty', !end.value);
      // Only a range that starts before midnight and ends after it spills
      // into the next day. One that starts after midnight is the early
      // morning of the day chosen, so its date stays as picked.
      overnight.hidden = !complete || s >= 1440 || e <= 1440;
      // Half a range is kept out of the plan until both ends are set.
      commitment.window = complete && e > s ? `${formatTime(s)} - ${formatTime(e)}` : '';
      replan();
    };
    start.addEventListener('change', () => {
      const s = start.value ? Number(start.value) : null;
      let e = end.value ? Number(end.value) : null;
      // A start with no end yet, or one at or past the end, gets a one-hour
      // window to adjust from.
      if (s != null && (e == null || e <= s)) e = Math.min(s + 60, DAY_END);
      end.innerHTML = endOptions(s, e);
      syncTime();
    });
    end.addEventListener('change', syncTime);
    row.querySelector('[data-remove]').addEventListener('click', () => {
      state.commitments.splice(index, 1);
      renderCommitments();
      replan();
    });
    box.appendChild(row);
  });
}

/** Accepts a calendar export or a simple CSV. */
async function importCommitments(file) {
  const { found, unreadable } = commitmentsFromText(await file.text());

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
    (unreadable.length
      ? `<p class="muted small">Couldn't read the date or times on ${
          unreadable.length === 1 ? `row ${unreadable[0]}` : `rows ${unreadable.slice(0, 8).join(', ')}${unreadable.length > 8 ? '…' : ''}`
        }.</p>`
      : '') +
    (!found.length && !unreadable.length
      ? '<p class="muted small">No events with a date and time were found in it.</p>'
      : '');

  renderCommitments();
  replan();
}

/* ---------- scoring and planning ---------- */

let scoring = 0;

/**
 * Stars are a recommendation, not a guess at the rating someone would give.
 *
 * Predicted ratings are calibrated, so for premieres they bunch within a few
 * tenths of a star of the person's average - accurate, and useless for
 * choosing. This stretches this person's range on this slate over the whole
 * scale: their top 5% of prospects get 5 stars, the bottom 5% get 1, and
 * everything else lands in proportion. The order and the gaps are the model's; only the scale changes.
 * The predicted rating itself stays available (`estimate`) and is shown in
 * the film's details.
 */
function recommendationScale(predictions) {
  // Anchored at the 5th and 95th percentiles rather than the extremes, so one
  // standout film can't squash everyone else into the middle of the scale.
  const sorted = [...predictions].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const low = sorted.length >= 20 ? at(0.05) : sorted[0];
  const high = sorted.length >= 20 ? at(0.95) : sorted[sorted.length - 1];
  if (!predictions.length || !(high - low > 0.01)) return () => 3;
  return (value) => Math.min(5, Math.max(0.5, 1 + (4 * (value - low)) / (high - low)));
}

function score() {
  if (!state.festival || !state.profile) return;

  // The blend compares every festival film with everything the person rated,
  // which can take a moment on a phone: say so, and let the page paint first.
  const run = ++scoring;
  state.scored = [];
  $('#plan').innerHTML =
    '<p class="thinking" role="status">Working out what you’ll like<span>.</span><span>.</span><span>.</span></p>';
  setTimeout(() => {
    if (run !== scoring) return;
    const scoreable = state.festival.films.filter((f) => f.scoreable !== false);
    const rest = state.festival.films.filter((f) => f.scoreable === false);

    // Unscoreable items keep the person's own average rather than a fake
    // prediction, and are labelled as such in the UI.
    const scored = recommender.scoreSlate(state.profile, scoreable);
    const base = recommender.base(state.profile);
    const toStars = recommendationScale(scored.map((film) => film.prediction));
    state.scored = [
      ...scored.map((film, index) => ({
        ...film,
        estimate: film.prediction,
        prediction: toStars(film.prediction),
        rank: index + 1,
        slateSize: scored.length,
      })),
      ...rest.map((film) => ({
        ...film,
        estimate: base,
        prediction: toStars(base),
        confidence: 'none',
        reasons: { people: [], keywords: [] },
      })),
    ];
    rebuild();
  }, 40);
}

/** New limits mean a new plan: only the person's own picks stay put. */
function replan() {
  state.kept.clear();
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
      kept: state.kept,
      excluded: state.excluded,
      held: state.held,
    }
  );

  renderPlan();
  saveSession();
  updateChrome();
}

/** Five diamonds, filled to the rounded recommendation. */
function diamonds(value) {
  // In half steps: 3.5 shows three full diamonds and a half-filled fourth.
  const halves = Math.max(0, Math.min(10, Math.round(value * 2)));
  const full = Math.floor(halves / 2);
  const half = halves % 2;
  return (
    `<span class="diamonds" role="img" aria-label="Recommended ${value.toFixed(1)} out of 5">` +
    '<i></i>'.repeat(full) +
    '<i class="half"></i>'.repeat(half) +
    '<i class="off"></i>'.repeat(5 - full - half) +
    '</span>'
  );
}

const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`;

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Thriller · Drama · 89 min", the facts that decide a glance. */
function filmFacts(film) {
  const genres = (film.entities?.genre?.length
    ? film.entities.genre.slice(0, 2)
    : String(film.genre || '').split(/\s*[\/·,]\s*/).filter(Boolean).slice(0, 2)
  ).map(capitalise);
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

/** What each label on a film means - shown on hover, and in the key above the plan. */
const BADGE_HELP = {
  'Only chance': "Its only showing you can make: every other one clashes with something you've said you're busy for, or there isn't another.",
  'Little to go on': 'Your ratings share few credits, themes or similar films with this one, so its stars rest on thin evidence.',
  'Not rated': "An event or a film with nothing to score it on. It's in the plan at your average - your call.",
  'Your pick': 'You chose this screening, so the planner keeps it.',
  Event: 'A talk, party or live show rather than a film.',
  Clash: 'Runs into a film already in your plan or one of your commitments.',
  Dropped: "You dropped this film. It won't be planned unless you add it back.",
  'During a commitment': "Showing while you've said you're busy.",
};

function explainBadges(root) {
  root.querySelectorAll('.badge').forEach((badge) => {
    const help = BADGE_HELP[badge.textContent.trim()];
    if (help) badge.title = help;
  });
}

function renderPlanKey() {
  const key = $('#plan-key');
  if (!key) return;
  key.querySelector('dl').innerHTML = Object.entries(BADGE_HELP)
    .map(([label, help]) => `<div><dt><span class="badge${label === 'Only chance' ? ' hot' : label === 'Clash' ? ' warn-badge' : ''}">${escapeHTML(label)}</span></dt><dd>${escapeHTML(help)}</dd></div>`)
    .join('');
}

function renderPlan() {
  const strength = profileStrength(state.library.length);
  $('#strength').className = `strength ${strength.level}`;
  $('#strength').innerHTML = `<b>${escapeHTML(strength.headline)}.</b>${escapeHTML(strength.detail)}`;

  const single = onlyChances(state.schedule);
  const plan = $('#plan');
  plan.innerHTML = '';

  // Every day is shown, even one with nothing planned: every film has to be
  // reachable from the plan, so the person decides what they miss.
  for (const day of state.schedule.days) {
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
      // Just before the later film, so the warning sits between the two.
      ...(day.clashes || []).map((clash) => ({
        start: clash.second.start - 0.5,
        row: () => clashRow(day, clash),
      })),
    ].sort((a, b) => a.start - b.start);
    for (const entry of entries) {
      const row = entry.row();
      if (row) section.appendChild(row);
    }
    plan.appendChild(section);
  }

  renderDropped(plan);
  renderPlanKey();
  explainBadges(plan);
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
    `<div class="rail"><button type="button" class="marker card-toggle" aria-controls="${bodyId}" ` +
    `aria-expanded="false"><span class="sr-only">Details for ${escapeHTML(film.title)}</span></button></div>` +
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
  // A long synopsis shows a few lines until asked for the rest. The button
  // only appears when the text is actually cut off, which can only be
  // measured once the card is open.
  const synopsis = row.querySelector('.synopsis.clamped');
  const readMore = row.querySelector('[data-read-more]');
  const checkClamp = () => {
    if (!synopsis || !synopsis.classList.contains('clamped')) return;
    readMore.hidden = synopsis.scrollHeight <= synopsis.clientHeight + 2;
  };
  readMore?.addEventListener('click', () => {
    const expanded = synopsis.classList.toggle('clamped') === false;
    readMore.setAttribute('aria-expanded', String(expanded));
    readMore.textContent = expanded ? 'Read less' : 'Read more';
  });
  const toggle = row.querySelector('.card-toggle');
  const setOpen = (open) => {
    card.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-expanded', String(open));
    // Closed detail stays out of the tab order and away from screen readers.
    clip.inert = !open;
    if (open) state.openCards.add(id);
    else state.openCards.delete(id);
    if (open) requestAnimationFrame(checkClamp);
  };
  setOpen(state.openCards.has(id));
  head.addEventListener('click', () => setOpen(!card.classList.contains('open')));
  toggle.addEventListener('click', () => setOpen(!card.classList.contains('open')));

  row.querySelector('[data-drop]').addEventListener('click', () => dropPick(day, pick));
  row.querySelector('[data-swap]').addEventListener('click', () => {
    const existing = clip.querySelector('.alternatives');
    if (existing) return existing.remove();
    const panel = alternativesPanel(day, pick);
    explainBadges(panel);
    clip.appendChild(panel);
  });
  return row;
}

/** Hold every current pick where it is, so an edit changes only what it touches. */
function keepPlan() {
  for (const planned of state.schedule?.days || []) {
    for (const pick of planned.picks) state.kept.add(screeningId(pick));
  }
}

function dropPick(day, pick) {
  const id = screeningId(pick);
  keepPlan();
  state.excluded.add(pick.film.title);
  state.pinned.delete(id);
  state.kept.delete(id);
  state.openCards.delete(id);
  // Leave the slot empty, showing what else fits, rather than letting the
  // planner slide the next-best film into it.
  state.held.push({ title: pick.film.title, date: day.date, start: pick.start, end: pick.end });
  rebuild();
}

/**
 * Make `chosen` a pick.
 *
 * With `replacing`, this is a swap: that one pick gives way and everything
 * else in the plan stays exactly where it is - even a film the new choice now
 * runs into. The clash is shown as a warning for the person to settle; the
 * planner doesn't quietly settle it for them by changing a film they didn't
 * touch. The displaced film isn't marked as dropped - a swap is "this instead
 * of that", not "never show me that again" - so it can be swapped straight back.
 *
 * Without `replacing` (adding a film to free time), nothing gives way either:
 * a film that runs into a neighbour is kept alongside it, flagged as a clash.
 */
function pinInstead(day, chosen, replacing = null) {
  const chosenId = screeningId(chosen);
  // Slots this leaves empty stay empty, showing what fits, rather than being
  // refilled behind the person's back - the same as after a drop.
  const emptied = [];
  if (replacing) {
    emptied.push({ title: replacing.film.title, date: day.date, start: replacing.start, end: replacing.end });
  }
  for (const planned of state.schedule?.days || []) {
    for (const pick of planned.picks) {
      if (pick.film.title === chosen.film.title && screeningId(pick) !== chosenId) {
        emptied.push({ title: pick.film.title, date: planned.date, start: pick.start, end: pick.end });
      }
    }
  }
  keepPlan();
  if (replacing) {
    const replacedId = screeningId(replacing);
    state.pinned.delete(replacedId);
    state.kept.delete(replacedId);
    state.openCards.delete(replacedId);
  }
  // A film is only planned once: choosing it here moves it from any other
  // screening it had.
  for (const set of [state.pinned, state.kept]) {
    for (const id of [...set]) {
      if (id !== chosenId && id.startsWith(`${chosen.film.title}@`)) set.delete(id);
    }
  }
  state.kept.delete(chosenId);
  state.excluded.delete(chosen.film.title);
  // Choosing something for a slot that was being kept free fills it; the hold
  // has done its job. A film put back no longer holds its old slot either.
  state.held = state.held.filter(
    (window) =>
      window.title !== chosen.film.title &&
      !(window.date === day.date && window.start < chosen.end && chosen.start < window.end)
  );
  state.held.push(...emptied);
  state.pinned.add(chosenId);
}

function altRow(entry, { label, action, primary = false, extraBadge = '', note = '', near = false }) {
  const film = entry.film;
  return (
    `<div class="alt${near ? ' near' : ''}"><div>` +
    `<div class="alt-title">${escapeHTML(film.title)}` +
    (film.kind === 'event' ? '<span class="badge">Event</span>' : '') +
    (entry.blockedBy ? '<span class="badge">During a commitment</span>' : '') +
    extraBadge +
    `</div>` +
    `<p class="detail"><span class="when">${formatTime(entry.start)}</span>` +
    `${film.runtime ? ` · ${film.runtime} min` : ''}` +
    (film.scoreable === false
      ? ' · Not rated — your call'
      : ` · ${film.prediction.toFixed(1)}★ for you`) +
    (note ? `<span class="clash-note">${note}</span>` : '') +
    (film.synopsis ? `<span class="syn">${escapeHTML(film.synopsis)}</span>` : '') +
    `</p></div>` +
    `<button class="btn${primary ? ' primary' : ''}" data-${action}>${label}</button></div>`
  );
}

// How far either side of a pick the swap list looks for films that don't
// quite overlap it, but could still be taken in its place.
const NEAR_MARGIN = 60;

function alternativesPanel(day, pick) {
  const pickId = screeningId(pick);
  const others = day.picks.filter((other) => screeningId(other) !== pickId);

  // Dropped films stay in the list, marked, so a drop can be undone from the
  // slot where the film was. They sort below the rest.
  const byPreference = (a, b) =>
    Number(state.excluded.has(a.film.title)) - Number(state.excluded.has(b.film.title)) ||
    (b.film.prediction || 0) - (a.film.prediction || 0);
  const candidates = day.all.filter(
    (entry) =>
      entry.film &&
      entry.film.title !== pick.film.title &&
      !others.some((other) => other.film.title === entry.film.title)
  );
  const overlapping = candidates
    .filter((entry) => entry.start < pick.end && pick.start < entry.end)
    .sort(byPreference);
  const near = candidates
    .filter(
      (entry) =>
        !overlapping.includes(entry) &&
        entry.start < pick.end + NEAR_MARGIN &&
        pick.start - NEAR_MARGIN < entry.end
    )
    .sort((a, b) => a.start - b.start || byPreference(a, b));

  // Choosing a film that runs into another pick keeps both, flagged.
  const row = (entry, isNear) => {
    const warnings = optionWarnings(day, entry, others);
    return altRow(entry, {
      label: 'Use this instead',
      action: 'pick',
      near: isNear,
      note: warnings.note,
      extraBadge: warnings.badge,
    });
  };

  const panel = document.createElement('div');
  panel.className = 'alternatives';
  if (!overlapping.length && !near.length) {
    panel.innerHTML = '<p class="intro">Nothing else is showing around that time.</p>';
    return panel;
  }
  panel.innerHTML =
    (overlapping.length
      ? `<p class="intro">Also showing against ${escapeHTML(pick.film.title)}</p>` +
        overlapping.map((entry) => row(entry, false)).join('')
      : `<p class="intro">Nothing else overlaps ${escapeHTML(pick.film.title)}</p>`) +
    (near.length
      ? `<p class="intro">Within an hour either side</p>` +
        near.map((entry) => row(entry, true)).join('')
      : '');

  const options = [...overlapping, ...near];
  panel.querySelectorAll('[data-pick]').forEach((button, index) =>
    button.addEventListener('click', () => {
      pinInstead(day, options[index], pick);
      state.openCards.add(screeningId(options[index]));
      rebuild();
    })
  );
  return panel;
}

const weekdayName = (date) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });

/**
 * Two picks that run into each other. The plan keeps both until the person
 * chooses, so the warning sits between them with the choice right there.
 */
function clashRow(day, { first, second }) {
  const buffer = Number($('#buffer').value) || 0;
  const qa = tailFor(first.film);
  const filmEnds = first.end - buffer;
  const withQA = qa ? ' with its Q&amp;A' : '';
  const detail =
    filmEnds > second.start
      ? `${escapeHTML(first.film.title)} runs until ${formatTime(filmEnds)}${withQA}, ` +
        `${filmEnds - second.start} min into ${escapeHTML(second.film.title)}.`
      : `${escapeHTML(first.film.title)} ends at ${formatTime(filmEnds)}${withQA}, leaving ` +
        `${second.start - filmEnds} min to reach ${escapeHTML(second.film.title)} — ` +
        `less than the ${buffer} min you allowed between films.`;

  const row = document.createElement('div');
  row.className = 'row clash';
  row.innerHTML =
    '<div class="time"></div>' +
    '<div class="rail"><i class="marker alert"></i></div>' +
    `<div class="clash-box" role="alert">` +
    `<p class="name">Clash</p><p class="meta">${detail}</p>` +
    `<div class="card-actions">` +
    `<button class="btn quiet" data-drop-first>Drop ${escapeHTML(first.film.title)}</button>` +
    `<button class="btn quiet" data-drop-second>Drop ${escapeHTML(second.film.title)}</button>` +
    `</div></div>`;
  row.querySelector('[data-drop-first]').addEventListener('click', () => dropPick(day, first));
  row.querySelector('[data-drop-second]').addEventListener('click', () => dropPick(day, second));
  return row;
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
  // Letters only: "CRE[AI]TE" or "#1" must not put a bracket or a hash in the
  // poster slot. Each word gives its first letter, wherever in the word it is.
  return String(film.title || '')
    .replace(/^(the|a|an)\s+/i, '')
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0] || '')
    .filter(Boolean)
    .slice(0, 2)
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
  // Someone who both wrote and directed appears once per role; say it once.
  const seenPeople = new Set();
  const people = film.reasons?.people
    ?.filter((person) => !seenPeople.has(person.name) && seenPeople.add(person.name))
    .map(
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
  rows.push([
    'Showing',
    `${formatTime(pick.start)}${film.runtime ? `–${formatTime(ends)}` : ''}` +
      (tailFor(film) ? `<br><span class="caveat">Planned with ${QA_MINUTES} min for a Q&amp;A</span>` : ''),
  ]);
  // Where this showing is - a film can start in several theatres at once.
  if (pick.venue) {
    rows.push(['Where', escapeHTML(pick.venue)]);
  }
  // The film's other showings, so a clash or a better day is easy to spot.
  const others = (state.festival?.screenings || [])
    .filter((s) => s.film === film.title && !(s.date === pick.date && s.time === pick.time))
    .sort((a, b) => a.date.localeCompare(b.date) || parseTime(a.time) - parseTime(b.time));
  if (others.length) {
    rows.push([
      others.length === 1 ? 'Also showing' : 'Other showings',
      others
        .map((s) => {
          const day = new Date(`${s.date}T12:00:00`).toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          });
          return (
            `<span class="other-showing">${escapeHTML(day)}, ${formatTime(parseTime(s.time))}` +
            (s.venue ? `<span class="caveat"> · ${escapeHTML(s.venue)}</span>` : '') +
            `</span>`
          );
        })
        .join(''),
    ]);
  }

  const unrated = film.scoreable === false;
  const hasLinks = people.director?.length || people.cast?.length;
  // Names, themes and genres come from film data, so everything is escaped.
  return (
    `<div class="stack">` +
    `<p class="meta mobile-meta">${escapeHTML(filmFacts(film))}${badges}</p>` +
    (unrated
      ? ''
      // Both pieces: how strongly it's recommended at this festival, and the
      // rating the model expects the person would actually give it.
      : `<p class="predicted"><span class="num">${film.prediction.toFixed(1)}★</span>` +
        `<span class="label">Recommendation${
          film.rank ? ` · #${film.rank} of ${film.slateSize} for you here` : ''
        }</span></p>` +
        (Number.isFinite(film.estimate)
          ? `<p class="estimate">You'd probably rate it about <b>${film.estimate.toFixed(1)}★</b>. ` +
            'The stars above rank it against the rest of this festival, so the differences are easier to see.</p>'
          : '')) +
    `<p class="why"><b>Why it's here:</b>${
      unrated ? 'No ratings history can predict this one — your call.' : `${escapeHTML(capitalise(reasonText(film)))}.`
    }</p>` +
    (film.synopsis
      ? `<p class="synopsis clamped">${escapeHTML(film.synopsis)}</p>` +
        '<button type="button" class="linkish read-more" data-read-more aria-expanded="false" hidden>Read more</button>'
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
    // A synopsis taken from Wikipedia is CC BY-SA: it must say where it came from.
    (film.wikipedia && film.synopsis
      ? `<p class="caveat">Synopsis from <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(
          String(film.wikipedia).replace(/ /g, '_')
        )}" target="_blank" rel="noopener noreferrer">Wikipedia</a>, ` +
        '<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" ' +
        'rel="noopener noreferrer">CC BY-SA 4.0</a>.</p>'
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
  const candidates = day.all.filter((entry) => entry.film);
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

  // Everything showing during the gap is offered, not only what fits inside
  // it: a film that runs into a neighbouring pick is still the person's call,
  // so it's listed after the ones that fit, with the clash spelled out.
  const byPrediction = (a, b) => (b.film.prediction || 0) - (a.film.prediction || 0);
  return gaps
    .map((gap) => {
      const showing = day.all.filter(
        (entry) =>
          entry.film &&
          entry.start < gap.end &&
          gap.start < entry.end &&
          !picks.some((pick) => pick.film.title === entry.film.title)
      );
      const inside = (entry) =>
        entry.start >= gap.start && entry.end <= gap.end && !entry.blockedBy;
      return {
        ...gap,
        fitting: showing.filter(inside).length,
        fits: [
          ...showing.filter(inside).sort(byPrediction),
          ...showing.filter((entry) => !inside(entry)).sort(byPrediction),
        ],
      };
    })
    .filter((gap) => gap.fits.length);
}

/**
 * What choosing `entry` would run into on its day, and whether it's already
 * planned elsewhere - said before choosing, so nothing surprises afterwards.
 */
function optionWarnings(day, entry, others) {
  const runsInto = others.filter((other) => other.start < entry.end && entry.start < other.end);
  let elsewhere = null;
  for (const planned of state.schedule.days) {
    if (planned.date !== day.date && planned.picks.some((pick) => pick.film.title === entry.film.title)) {
      elsewhere = planned.date;
    }
  }
  const notes = [
    ...runsInto.map(
      (other) =>
        `Runs into ${escapeHTML(other.film.title)} at ${formatTime(other.start)}, ` +
        'which stays in your plan and is flagged as a clash.'
    ),
    elsewhere
      ? `Already planned on ${escapeHTML(weekdayName(elsewhere))}; choosing it moves it here.`
      : '',
  ].filter(Boolean);
  return {
    clashes: runsInto.length > 0,
    note: notes.join(' '),
    badge:
      (state.excluded.has(entry.film.title) ? '<span class="badge">Dropped</span>' : '') +
      (runsInto.length ? '<span class="badge warn-badge">Clash</span>' : ''),
  };
}

const FITS_SHOWN = 3;

function gapRow(day, gap) {
  const { fits } = gap;
  const key = `${day.date}@${gap.start}`;
  const listId = `gap-${day.date}-${Math.round(gap.start)}`;
  const row = document.createElement('div');
  row.className = 'row free';
  // The diamond on the timeline opens the list of what could fill the time.
  row.innerHTML =
    `<div class="time">${clock(gap.start)}</div>` +
    `<div class="rail"><button type="button" class="marker hollow gap-toggle" aria-controls="${listId}" ` +
    `aria-expanded="false"><span class="sign" aria-hidden="true"></span>` +
    `<span class="sr-only">Films for this free time</span></button></div>` +
    `<div class="free-box">` +
    `<div class="free-head"><div><p class="name">Nothing planned</p>` +
    `<p class="meta">Free until ${formatTime(gap.end)} (${hoursText(gap.end - gap.start)}) · ` +
    (() => {
      const overlapping = fits.length - gap.fitting;
      const fitText = gap.fitting
        ? `${plural(gap.fitting, 'film')} ${gap.fitting === 1 ? 'fits' : 'fit'} in this time`
        : 'no film fits in this time';
      const overlapText = overlapping
        ? `${overlapping} ${gap.fitting ? 'more' : ''} would overlap a planned film or a commitment`.replace('  ', ' ')
        : '';
      return [fitText, overlapText].filter(Boolean).join(' · ');
    })() +
    `</p>` +
    `</div></div>` +
    `<div class="alternatives" id="${listId}">${fits
      .map((entry, index) => {
        const warnings = optionWarnings(day, entry, day.picks);
        return altRow(entry, {
          label: 'Add',
          action: 'add',
          primary: !warnings.clashes && !entry.blockedBy,
          near: warnings.clashes || Boolean(entry.blockedBy),
          note: warnings.note,
          extraBadge: warnings.badge,
        }).replace('<div class="alt', `<div${index >= FITS_SHOWN ? ' hidden' : ''} class="alt`);
      })
      .join('')}` +
    (fits.length > FITS_SHOWN
      ? `<p><button class="linkish" data-more>Show ${fits.length - FITS_SHOWN} more</button></p>`
      : '') +
    `</div></div>`;

  const toggle = row.querySelector('.gap-toggle');
  const list = row.querySelector('.alternatives');
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    row.classList.toggle('open', open);
    list.hidden = !open;
    if (open) state.openGaps.add(key);
    else state.openGaps.delete(key);
  };
  setOpen(state.openGaps.has(key));
  toggle.addEventListener('click', () => setOpen(list.hidden));
  // The heading opens it too: a bigger target than the diamond.
  row.querySelector('.free-head').addEventListener('click', (event) => {
    if (!event.target.closest('button, a')) setOpen(list.hidden);
  });

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
      // Put back means back in its own slot, so release that slot's hold.
      state.held = state.held.filter((window) => window.title !== button.dataset.undrop);
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
  kept: [...state.kept],
  excluded: [...state.excluded],
  held: state.held,
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
  state.kept = new Set(saved.kept || []);
  state.excluded = new Set(saved.excluded || []);
  state.held = Array.isArray(saved.held) ? saved.held : [];
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
  state.kept = new Set(data.kept || []);
  state.excluded = new Set(data.excluded || []);
  state.held = Array.isArray(data.held) ? data.held : [];
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
  const banner = $('#fest-banner');
  if (name !== banner.dataset.festival) {
    banner.dataset.festival = name || '';
    banner.hidden = !name;
    if (name) {
      const days = state.festival.days?.length
        ? [...state.festival.days].sort()
        : [...new Set(state.festival.screenings.map((s) => s.date))].sort();
      $('#fest-banner-name').textContent = name;
      $('#fest-banner-when').textContent = days.length ? dateRange(days[0], days[days.length - 1]) : '';
      // Restart the unfurl for each newly chosen festival.
      banner.classList.remove('unfurl');
      void banner.offsetWidth;
      banner.classList.add('unfurl');
    }
  }

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

countVisit();
boot();
