/**
 * Looking up films the bundled library doesn't know, on Wikidata.
 *
 * No key and no account: Wikidata and Wikipedia allow browser requests from
 * anywhere. Only a film's title and year are sent - never a rating, and
 * nothing about the person. Results are cached in the browser, so each film is
 * only ever looked up once.
 *
 * Mirrors festrec_eval/wikidata.py and festrec_eval/genres.py: a film looked up
 * here must come out in the same shape, with genres in the same vocabulary, as
 * the ones the model was trained on. Change one, change both.
 */

const WIKIDATA = 'https://www.wikidata.org/w/api.php';
const WIKIPEDIA = 'https://en.wikipedia.org/w/api.php';
const CAST_DEPTH = 6;
const OVERVIEW_CHARS = 700;

const FILM_TYPES = new Set([
  'Q11424', 'Q24869', 'Q29168811', 'Q202866', 'Q93204', 'Q226730', 'Q506240',
]);
const TYPE_GENRES = {
  Q29168811: 'animation', Q202866: 'animation', Q17517379: 'animation',
  Q93204: 'documentary', Q24865: 'documentary',
};

export const GENRES = [
  'action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama',
  'family', 'fantasy', 'history', 'horror', 'music', 'mystery', 'romance',
  'science fiction', 'thriller', 'war', 'western',
];

const WORDS = {
  action: 'action', adventure: 'adventure', animation: 'animation', animated: 'animation',
  'stop-motion': 'animation', anime: 'animation', comedy: 'comedy', 'dark comedy': 'comedy',
  'black comedy': 'comedy', comedic: 'comedy', crime: 'crime', documentary: 'documentary',
  doc: 'documentary', drama: 'drama', family: 'family', fantasy: 'fantasy',
  'dark fantasy': 'fantasy', history: 'history', historical: 'history', horror: 'horror',
  'creature horror': 'horror', 'body horror': 'horror', 'folk horror': 'horror',
  slasher: 'horror', supernatural: 'horror', music: 'music', musical: 'music',
  mystery: 'mystery', romance: 'romance', romantic: 'romance', 'rom-com': 'romance',
  'science fiction': 'science fiction', 'sci-fi': 'science fiction',
  scifi: 'science fiction', thriller: 'thriller', war: 'war', western: 'western',
  'neo-western': 'western', satire: 'comedy', parody: 'comedy', splatter: 'horror',
  gory: 'horror', ghost: 'horror', giallo: 'horror', creature: 'horror', zombie: 'horror',
  vampire: 'horror', psychodrama: 'drama', melodrama: 'drama', noir: 'thriller',
  'neo-noir': 'thriller', heist: 'crime', gangster: 'crime', spy: 'thriller',
  espionage: 'thriller', survival: 'thriller', kaiju: 'science fiction',
  cyberpunk: 'science fiction', dystopian: 'science fiction', space: 'science fiction',
  swordplay: 'action', martial: 'action', wuxia: 'action', revenge: 'thriller',
  erotic: 'romance', concert: 'music', biographical: 'history', biopic: 'history',
  docudrama: 'documentary', superhero: 'action', disaster: 'action', detective: 'mystery',
  whodunit: 'mystery', 'coming-of-age': 'drama', sports: 'drama', legal: 'drama',
  teen: 'drama', christmas: 'family', "children's": 'family', 'fairy tale': 'fantasy',
  'sword and sorcery': 'fantasy',
};

const COMPOUNDS = {
  'romantic comedy': ['romance', 'comedy'], 'rom-com': ['romance', 'comedy'],
  'comedy-drama': ['comedy', 'drama'], 'comedy drama': ['comedy', 'drama'],
  dramedy: ['comedy', 'drama'], 'horror comedy': ['horror', 'comedy'],
  'comedy horror': ['horror', 'comedy'], 'musical comedy': ['music', 'comedy'],
  'science fiction comedy': ['science fiction', 'comedy'],
  'action comedy': ['action', 'comedy'],
};

const MEDIUM = /\b(feature |short |television |tv )?(film|movie|cinema)s?\b/g;

export function cleanGenre(phrase) {
  return String(phrase).toLowerCase().replace(MEDIUM, '').replace(/\s+/g, ' ')
    .replace(/^[\s,-]+|[\s,-]+$/g, '');
}

/** Same rules as festrec_eval/genres.py map_genres: whole phrase, then head word. */
export function mapGenres(phrases) {
  const found = new Set();
  for (const phrase of phrases) {
    for (let part of cleanGenre(phrase).split(/\s*[/,·|]\s*/)) {
      part = part.trim();
      if (!part) continue;
      if (COMPOUNDS[part]) { COMPOUNDS[part].forEach((g) => found.add(g)); continue; }
      if (WORDS[part]) { found.add(WORDS[part]); continue; }
      const words = part.split(/\s+/);
      const head = words[words.length - 1];
      if (WORDS[head]) { found.add(WORDS[head]); continue; }
      const pieces = head.split('-').filter((p) => WORDS[p]);
      if (pieces.length) { pieces.forEach((p) => found.add(WORDS[p])); continue; }
      words.filter((w) => WORDS[w]).forEach((w) => found.add(WORDS[w]));
    }
  }
  return found;
}

async function api(url, params) {
  const query = new URLSearchParams({ ...params, format: 'json', origin: '*' });
  const response = await fetch(`${url}?${query}`);
  if (!response.ok) throw new Error(`Wikidata answered ${response.status}`);
  return response.json();
}

const label = (entity) =>
  entity?.labels?.en?.value || entity?.labels?.mul?.value ||
  Object.values(entity?.labels || {})[0]?.value || '';

function claimIds(entity, prop) {
  const statements = entity?.claims?.[prop] || [];
  const preferred = statements.filter((s) => s.rank === 'preferred');
  const ordered = preferred.length ? preferred : statements.filter((s) => s.rank !== 'deprecated');
  const ids = [];
  for (const statement of ordered) {
    const id = statement.mainsnak?.datavalue?.value?.id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function releaseYear(entity) {
  const years = (entity?.claims?.P577 || [])
    .map((s) => String(s.mainsnak?.datavalue?.value?.time || '').match(/[+-]?(\d{4})/)?.[1])
    .filter(Boolean);
  return years.length ? years.sort()[0] : '';
}

function runtimeMinutes(entity) {
  for (const statement of entity?.claims?.P2047 || []) {
    const value = statement.mainsnak?.datavalue?.value;
    const amount = Number(value?.amount);
    if (!Number.isFinite(amount)) continue;
    const unit = String(value.unit || '').split('/').pop();
    const minutes = unit === 'Q25235' ? amount * 60 : unit === 'Q11574' ? amount / 60 : amount;
    if (minutes >= 1 && minutes <= 1000) return Math.round(minutes);
  }
  return null;
}

async function entities(ids, props) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const payload = await api(WIKIDATA, {
      action: 'wbgetentities', ids: ids.slice(i, i + 50).join('|'), props,
      languages: 'en|mul', languagefallback: '1', sitefilter: 'enwiki',
    });
    Object.assign(out, payload.entities || {});
  }
  return out;
}

function trimOverview(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= OVERVIEW_CHARS) return clean;
  const cut = clean.slice(0, OVERVIEW_CHARS);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 200 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

export class WikidataProvider {
  constructor(cache) {
    this.name = 'wikidata';
    this.cache = cache;
  }

  async lookup(title, year) {
    const cacheKey = `wd:${String(title).toLowerCase()}|${year || ''}`;
    const cached = await this.cache?.get(cacheKey);
    if (cached !== undefined) return cached;
    const found = await this.fetchFilm(title, year);
    await this.cache?.set(cacheKey, found);
    return found;
  }

  /** Search by title, keep only films, and prefer the one from the right year. */
  async fetchFilm(title, year) {
    const search = await api(WIKIDATA, {
      action: 'wbsearchentities', search: title, language: 'en', type: 'item', limit: '10',
    });
    const ids = (search.search || []).map((item) => item.id);
    if (!ids.length) return null;

    const candidates = Object.values(await entities(ids, 'labels|claims|sitelinks'))
      .filter((entity) => claimIds(entity, 'P31').some((type) => FILM_TYPES.has(type)));
    if (!candidates.length) return null;

    const distance = (entity) => {
      const found = Number(releaseYear(entity));
      return year && found ? Math.abs(found - Number(year)) : 5;
    };
    candidates.sort((a, b) => distance(a) - distance(b));
    const film = candidates[0];
    // Two films can share a title; a year that's far off means it isn't this one.
    if (year && distance(film) > 1) return null;

    const props = ['P57', 'P58', 'P161', 'P725', 'P136', 'P921'];
    const wanted = [...new Set(props.flatMap((p) => {
      const found = claimIds(film, p);
      return p === 'P161' || p === 'P725' ? found.slice(0, CAST_DEPTH) : found;
    }))];
    const people = wanted.length ? await entities(wanted, 'labels') : {};
    const named = (prop, limit) =>
      claimIds(film, prop).slice(0, limit).map((id) => label(people[id])).filter(Boolean);

    const genreWords = named('P136');
    const genres = mapGenres(genreWords);
    claimIds(film, 'P31').forEach((type) => TYPE_GENRES[type] && genres.add(TYPE_GENRES[type]));
    const keywords = [
      ...named('P921').map((k) => k.toLowerCase()),
      ...genreWords.map(cleanGenre).filter((g) => g && !GENRES.includes(g)),
    ];

    const article = film.sitelinks?.enwiki?.title || '';
    let overview = '';
    if (article) {
      const page = await api(WIKIPEDIA, {
        action: 'query', prop: 'extracts', exintro: '1', explaintext: '1',
        redirects: '1', titles: article, formatversion: '2',
      });
      overview = trimOverview(page.query?.pages?.[0]?.extract);
    }

    return {
      title: label(film),
      year: releaseYear(film),
      runtime: runtimeMinutes(film),
      director: named('P57'),
      writer: named('P58'),
      cast: named('P161', CAST_DEPTH).length ? named('P161', CAST_DEPTH) : named('P725', CAST_DEPTH),
      keyword: [...new Set(keywords)],
      genre: [...genres].sort(),
      overview,
      wikipedia: article,
    };
  }
}
