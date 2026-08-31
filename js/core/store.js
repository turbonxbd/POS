/**
 * store.js - minimal reactive state container for UI-level state
 * (current user, active branch, sidebar state, theme, POS cart draft).
 * Persistent domain data lives in db.js, not here.
 */

import config from '../config.js';

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(config.storage.prefsKey)) || {};
  } catch {
    return {};
  }
}

class Store {
  #state;
  #subs = new Set();
  #keySubs = new Map();

  constructor(initial) {
    this.#state = initial;
  }

  get state() {
    return this.#state;
  }

  get(key) {
    return key == null ? this.#state : this.#state[key];
  }

  set(patch) {
    const prev = this.#state;
    const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
    this.#state = next;
    const changedKeys = Object.keys(next).filter((k) => next[k] !== prev[k]);
    this.#subs.forEach((fn) => fn(next, prev, changedKeys));
    changedKeys.forEach((k) => this.#keySubs.get(k)?.forEach((fn) => fn(next[k], prev[k])));
  }

  subscribe(fn) {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  watch(key, fn) {
    if (!this.#keySubs.has(key)) this.#keySubs.set(key, new Set());
    this.#keySubs.get(key).add(fn);
    return () => this.#keySubs.get(key)?.delete(fn);
  }

  /** Persist a subset of state as user preferences. */
  persistPrefs(keys) {
    const prefs = loadPrefs();
    keys.forEach((k) => (prefs[k] = this.#state[k]));
    try {
      localStorage.setItem(config.storage.prefsKey, JSON.stringify(prefs));
    } catch (err) {
      console.warn('[store] could not persist prefs', err);
    }
  }
}

const prefs = loadPrefs();

export const store = new Store({
  user: null,
  session: null,
  business: null,
  branches: [],
  activeBranchId: prefs.activeBranchId || null,
  permissions: new Set(),
  theme: prefs.theme || 'system', // 'light' | 'dark' | 'system'
  sidebarCollapsed: prefs.sidebarCollapsed || false,
  sidebarOpenMobile: false,
  online: navigator.onLine,
  syncPending: 0,
  notificationsUnread: 0,
  bootReady: false,
});

export default store;
