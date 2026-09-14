/**
 * Sharing with the developer - only ever when someone chooses to.
 *
 * Nothing leaves the device unless the person ticks the consent box and
 * presses the button. What is sent is built here, from values already parsed
 * in the browser, so the sender can be told exactly what goes and what stays:
 * titles, years and ratings go; watch dates, usernames, reviews, diary and
 * watchlist never do.
 *
 * The receiving Worker re-checks everything independently (see worker/),
 * because a browser check protects nobody from a determined sender.
 */

const PRODUCTION = {
  // The share Worker. It only accepts uploads from the app's own origin.
  endpoint: 'https://festrec-share.nifty-fest.workers.dev',
  // Turnstile site key. Public by design - the secret lives only in the Worker.
  siteKey: '0x4AAAAAAEyve8_FODIfBv66',
};

// Local testing: a `wrangler dev` Worker with Cloudflare's documented
// always-pass Turnstile test keys. Only reachable from localhost with
// ?share-test in the URL, so the published site can never use it.
const LOCAL_TEST = {
  endpoint: 'http://localhost:8787',
  siteKey: '1x00000000000000000000AA',
};

const useLocalTest =
  typeof location !== 'undefined' &&
  location.hostname === 'localhost' &&
  new URLSearchParams(location.search).has('share-test');

const config = useLocalTest ? LOCAL_TEST : PRODUCTION;
export const SHARE_ENDPOINT = config.endpoint;
export const TURNSTILE_SITE_KEY = config.siteKey;

export const MIN_RATINGS_TO_SHARE = 30;

/**
 * Add one to today's visit count. The request carries nothing - no id, no
 * cookie, no body - so the count can't tell one visitor from another. Only
 * the published site counts, and a failure is ignored.
 */
export function countVisit() {
  if (typeof location === 'undefined' || location.hostname !== 'mostmetaphorical.github.io') return;
  fetch(`${PRODUCTION.endpoint}/hit`, { method: 'POST', keepalive: true, credentials: 'omit' }).catch(() => {});
}

let turnstileReady = null;

/** Load Cloudflare's bot check the first time something needs it. */
function loadTurnstile() {
  if (!turnstileReady) {
    turnstileReady = new Promise((resolve, reject) => {
      window.onTurnstileLoad = () => resolve(window.turnstile);
      const script = document.createElement('script');
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js' +
        '?render=explicit&onload=onTurnstileLoad';
      script.async = true;
      script.onerror = () => reject(new Error('The bot check could not load.'));
      document.head.appendChild(script);
    });
  }
  return turnstileReady;
}

/**
 * Put a bot check in `container`. Returns a handle whose `token()` resolves to
 * a fresh token. Tokens are single-use, so the widget resets after each send.
 */
export async function botCheck(container, onChange = () => {}) {
  const turnstile = await loadTurnstile();
  let current = null;
  const id = turnstile.render(container, {
    sitekey: TURNSTILE_SITE_KEY,
    theme: 'dark',
    callback: (token) => {
      current = token;
      onChange(true);
    },
    'expired-callback': () => {
      current = null;
      onChange(false);
    },
    'error-callback': () => {
      current = null;
      onChange(false);
    },
  });
  return {
    ready: () => Boolean(current),
    take() {
      const token = current;
      current = null;
      turnstile.reset(id);
      onChange(false);
      return token;
    },
  };
}

/** Is sharing open, or paused because a limit was reached? */
export async function shareStatus() {
  try {
    const response = await fetch(`${SHARE_ENDPOINT}/status`, { cache: 'no-store' });
    return await response.json();
  } catch {
    return { open: false, reason: 'unreachable' };
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The file that gets sent: three columns only. Built from ratings the app has
 * already parsed, so a watch date or a Letterboxd link can't slip through.
 */
export function ratingsForSharing(ratings) {
  const lines = ['Name,Year,Rating'];
  for (const { title, year, rating } of ratings) {
    lines.push([csvCell(title), year ?? '', rating].join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function send(path, body, token, type) {
  let response;
  try {
    response = await fetch(`${SHARE_ENDPOINT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': type, 'CF-Turnstile-Response': token },
      body,
    });
  } catch {
    return { ok: false, error: "Couldn't reach the share service. Try again later." };
  }
  try {
    return await response.json();
  } catch {
    return { ok: false, error: `Unexpected response (${response.status}).` };
  }
}

export const shareRatings = (ratings, token) =>
  send('/ratings', ratingsForSharing(ratings), token, 'text/csv');

export const shareFestival = (festival, token) =>
  send('/festival', JSON.stringify(festival), token, 'application/json');

/** A bug report: {message, step, contact?, details?}. Never ratings. */
export const sendReport = (report, token) =>
  send('/report', JSON.stringify(report), token, 'application/json');
