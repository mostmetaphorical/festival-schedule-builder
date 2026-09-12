/**
 * Remembering things, only if asked.
 *
 * Storage is off until the person turns it on. Everything written here stays
 * in this browser: it is never sent anywhere, and there is no account behind
 * it. A cookie would be the wrong tool - cookies travel to the server on every
 * request and cap out around 4KB, neither of which suits a rating history.
 *
 * Browsers can and do clear this (private windows refuse it outright, and
 * Safari clears script-written storage after about a week of not visiting),
 * so every call degrades quietly and the app treats the downloaded file as
 * the real backup.
 */

const KEY = 'festrec.v1';

export const storage = {
  available() {
    try {
      const probe = '__festrec_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  },

  enabled() {
    try {
      return localStorage.getItem(`${KEY}.consent`) === 'yes';
    } catch {
      return false;
    }
  },

  enable(on) {
    try {
      if (on) localStorage.setItem(`${KEY}.consent`, 'yes');
      else {
        localStorage.removeItem(`${KEY}.consent`);
        localStorage.removeItem(`${KEY}.state`);
      }
      return true;
    } catch {
      return false;
    }
  },

  save(state) {
    if (!this.enabled()) return false;
    try {
      localStorage.setItem(`${KEY}.state`, JSON.stringify(state));
      return true;
    } catch {
      // Quota, private mode, or a browser that simply says no.
      return false;
    }
  },

  load() {
    if (!this.enabled()) return null;
    try {
      const raw = localStorage.getItem(`${KEY}.state`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  /** Everything this app has put in this browser, gone. */
  clear() {
    try {
      for (const name of Object.keys(localStorage)) {
        if (name.startsWith(KEY)) localStorage.removeItem(name);
      }
      indexedDB.deleteDatabase('festrec-metadata');
      return true;
    } catch {
      return false;
    }
  },

  /** Rough size of what is stored, so the UI can be specific about it. */
  footprint() {
    try {
      const raw = localStorage.getItem(`${KEY}.state`) || '';
      return raw.length;
    } catch {
      return 0;
    }
  },
};
