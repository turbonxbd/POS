/**
 * db.js - browser-local document database.
 *
 * Purpose: give the mock backend a persistent, transactional data store so the
 * frontend behaves exactly as it will against a real database - data survives
 * refresh / tab close, mutations are atomic, and document numbers never repeat.
 *
 * Design:
 *  - One JSON tree persisted to localStorage under config.storage.dbKey.
 *  - Named collections of documents ({ id, ...fields, createdAt, updatedAt }).
 *  - `tx(fn)` runs a unit of work against a snapshot; on any throw the entire
 *    tree is rolled back and nothing is persisted (atomicity for checkout).
 *  - Monotonic sequence counters in `meta.sequences` for invoice / doc numbers.
 *  - Writes are debounced & coalesced; a `tx` commit forces an immediate flush.
 *
 * Swapping to a real backend: services never touch db.js directly - they call
 * http.js which (in mock mode) routes to mock-server.js which uses this module.
 */

import config from '../config.js';
import { now } from '../utils/date.js';
import { uuid, pad, formatDocNo } from '../utils/id.js';
import bus from './event-bus.js';

const KEY = config.storage.dbKey;
const EMPTY = () => ({
  __v: 1,
  meta: { sequences: {}, seededAt: null, demo: false, createdAt: now() },
  collections: {},
});

class Database {
  #data = EMPTY();
  #persistTimer = null;
  #txDepth = 0;
  #txBackup = null;
  #pendingEvents = [];
  #loaded = false;
  #crossTab = false;
  #crossTabTimer = null;

  /* ------------------------------------------------------------------ load */
  load() {
    if (this.#loaded) return this;
    try {
      const rawStr = localStorage.getItem(KEY);
      if (rawStr) {
        const parsed = JSON.parse(rawStr);
        if (parsed && parsed.collections) this.#data = parsed;
      }
    } catch (err) {
      console.error('[db] failed to parse stored data - starting empty', err);
      this.#data = EMPTY();
    }
    this.#loaded = true;
    return this;
  }

  get isLoaded() {
    return this.#loaded;
  }

  get isEmpty() {
    return Object.keys(this.#data.collections).length === 0;
  }

  get meta() {
    return this.#data.meta;
  }

  /* ------------------------------------------------------------- persist */
  #schedulePersist() {
    if (this.#txDepth > 0) return; // defer until commit
    clearTimeout(this.#persistTimer);
    this.#persistTimer = setTimeout(() => this.#persistNow(), config.storage.persistDebounceMs);
  }

  #persistNow() {
    clearTimeout(this.#persistTimer);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.#data));
    } catch (err) {
      if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
        bus.emit('db:quota-exceeded', err);
        console.error('[db] localStorage quota exceeded - data not saved', err);
      } else {
        console.error('[db] persist failed', err);
      }
    }
  }

  flush() {
    this.#persistNow();
  }

  /* ---------------------------------------------------- cross-tab realtime */
  /**
   * Adopt writes made by OTHER tabs of this origin. The browser fires a
   * `storage` event in every other tab when localStorage changes; we reload
   * the tree and emit `data:<collection>` + `db:changed` so open pages
   * (cashier grid, admin dashboard, …) refetch without a manual refresh.
   */
  startCrossTabSync() {
    if (this.#crossTab || typeof window === 'undefined' || !window.addEventListener) return;
    this.#crossTab = true;
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY || e.newValue == null) return;
      clearTimeout(this.#crossTabTimer);
      this.#crossTabTimer = setTimeout(() => this.#adoptExternal(e.newValue), 80);
    });
  }

  #sig(arr) {
    let max = '';
    for (const d of arr) if (d.updatedAt && d.updatedAt > max) max = d.updatedAt;
    return `${arr.length}:${max}`;
  }

  #adoptExternal(rawStr) {
    if (this.#txDepth > 0) return;
    let parsed;
    try { parsed = JSON.parse(rawStr); } catch { return; }
    if (!parsed || !parsed.collections) return;

    const before = this.#data.collections;
    const after = parsed.collections;
    const changed = [];
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (this.#sig(before[name] || []) !== this.#sig(after[name] || [])) changed.push(name);
    }
    this.#data = parsed;
    if (!changed.length) return;
    changed.forEach((c) => bus.emit('data:' + c));
    bus.emit('db:changed', changed);
    bus.emit('db:external-change', changed);
  }

  /* --------------------------------------------------------- transactions */
  /**
   * Run `fn` as an atomic unit. Mutations are applied to the live tree; if `fn`
   * throws, the tree is restored to its pre-transaction state and no events or
   * writes escape. Nested tx() calls join the outermost transaction.
   */
  tx(fn) {
    if (this.#txDepth > 0) return fn(this); // join outer tx

    this.#txDepth = 1;
    this.#txBackup = structuredClone(this.#data);
    this.#pendingEvents = [];
    try {
      const result = fn(this);
      this.#txDepth = 0;
      this.#txBackup = null;
      this.#persistNow();
      this.#flushEvents();
      return result;
    } catch (err) {
      this.#data = this.#txBackup;
      this.#txBackup = null;
      this.#txDepth = 0;
      this.#pendingEvents = [];
      throw err;
    }
  }

  #emit(event, payload) {
    if (this.#txDepth > 0) this.#pendingEvents.push([event, payload]);
    else bus.emit(event, payload);
  }

  #flushEvents() {
    const events = this.#pendingEvents;
    this.#pendingEvents = [];
    const collections = new Set();
    for (const [event, payload] of events) {
      bus.emit(event, payload);
      if (event.startsWith('db:change:')) collections.add(event.slice('db:change:'.length));
    }
    collections.forEach((c) => bus.emit('data:' + c));
    bus.emit('db:changed', [...collections]);
  }

  /* ---------------------------------------------------------- sequences */
  /** Raw next integer for a named counter. Call inside tx() for safety. */
  nextSeq(name, { start = 1 } = {}) {
    const seqs = this.#data.meta.sequences;
    const current = seqs[name] ?? start - 1;
    const next = current + 1;
    seqs[name] = next;
    this.#schedulePersist();
    return next;
  }

  peekSeq(name, { start = 1 } = {}) {
    return (this.#data.meta.sequences[name] ?? start - 1) + 1;
  }

  /**
   * Formatted document number. Guaranteed-unique per (name) counter.
   * e.g. seq('invoice', { template:'{PREFIX}-{BR}-{SEQ}', prefix:'AFIA', branchCode:'MAIN' })
   */
  seq(name, opts = {}) {
    const n = this.nextSeq(name, opts);
    if (!opts.template) return String(n);
    return formatDocNo(opts.template, { ...opts, seq: n, seqWidth: opts.seqWidth ?? 5 });
  }

  /* -------------------------------------------------------- collections */
  collection(name) {
    if (!this.#data.collections[name]) this.#data.collections[name] = [];
    return new Collection(name, this.#data.collections, {
      emit: (e, p) => this.#emit(e, p),
      schedulePersist: () => this.#schedulePersist(),
    });
  }

  collectionNames() {
    return Object.keys(this.#data.collections);
  }

  /* ------------------------------------------------------- import/export */
  export() {
    return structuredClone(this.#data);
  }

  snapshot() {
    return JSON.stringify(this.#data);
  }

  restore(snapshotStr) {
    this.#data = typeof snapshotStr === 'string' ? JSON.parse(snapshotStr) : structuredClone(snapshotStr);
    this.#persistNow();
    bus.emit('db:restored');
    bus.emit('db:changed', this.collectionNames());
  }

  import(tree, { merge = false } = {}) {
    if (!tree || !tree.collections) throw new Error('Invalid data file');
    if (merge) {
      for (const [name, docs] of Object.entries(tree.collections)) {
        const col = this.collection(name);
        docs.forEach((d) => col.upsert(d));
      }
      this.#data.meta.sequences = { ...this.#data.meta.sequences, ...(tree.meta?.sequences || {}) };
    } else {
      this.#data = {
        __v: tree.__v || 1,
        meta: { ...EMPTY().meta, ...(tree.meta || {}) },
        collections: structuredClone(tree.collections),
      };
    }
    this.#persistNow();
    bus.emit('db:restored');
    bus.emit('db:changed', this.collectionNames());
  }

  reset() {
    this.#data = EMPTY();
    this.#persistNow();
    bus.emit('db:reset');
  }

  stats() {
    const collections = {};
    let docs = 0;
    for (const [name, arr] of Object.entries(this.#data.collections)) {
      collections[name] = arr.length;
      docs += arr.length;
    }
    let bytes = 0;
    try {
      bytes = new Blob([localStorage.getItem(KEY) || '']).size;
    } catch {
      /* ignore */
    }
    return { collections, totalDocuments: docs, storageBytes: bytes, meta: this.#data.meta };
  }
}

/* ====================================================================== */

class Collection {
  #name;
  #store;
  #hooks;

  constructor(name, store, hooks) {
    this.#name = name;
    this.#store = store;
    this.#hooks = hooks;
  }

  get #arr() {
    return this.#store[this.#name];
  }

  #changed(type, doc) {
    this.#hooks.emit(`db:change:${this.#name}`, { type, doc, collection: this.#name });
    this.#hooks.schedulePersist();
  }

  all() {
    return this.#arr.slice();
  }

  raw() {
    return this.#arr;
  }

  get(id) {
    return this.#arr.find((d) => d.id === id) || null;
  }

  findOne(predicate) {
    const fn = toPredicate(predicate);
    return this.#arr.find(fn) || null;
  }

  find(predicate) {
    if (predicate == null) return this.all();
    const fn = toPredicate(predicate);
    return this.#arr.filter(fn);
  }

  count(predicate) {
    return predicate == null ? this.#arr.length : this.#arr.filter(toPredicate(predicate)).length;
  }

  exists(predicate) {
    return this.#arr.some(toPredicate(predicate));
  }

  insert(doc) {
    const ts = now();
    const record = {
      id: doc.id || uuid(),
      ...doc,
      createdAt: doc.createdAt || ts,
      updatedAt: ts,
    };
    if (this.#arr.some((d) => d.id === record.id)) {
      throw new Error(`[db] duplicate id "${record.id}" in ${this.#name}`);
    }
    this.#arr.push(record);
    this.#changed('insert', record);
    return structuredClone(record);
  }

  insertMany(docs) {
    return docs.map((d) => this.insert(d));
  }

  update(id, patch) {
    const idx = this.#arr.findIndex((d) => d.id === id);
    if (idx === -1) throw new Error(`[db] ${this.#name} "${id}" not found`);
    const current = this.#arr[idx];
    const next = {
      ...current,
      ...(typeof patch === 'function' ? patch(current) : patch),
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now(),
    };
    this.#arr[idx] = next;
    this.#changed('update', next);
    return structuredClone(next);
  }

  upsert(doc) {
    if (doc.id && this.#arr.some((d) => d.id === doc.id)) return this.update(doc.id, doc);
    return this.insert(doc);
  }

  /** Hard remove. Prefer soft-delete (archivedAt) for business documents. */
  remove(id) {
    const idx = this.#arr.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    const [removed] = this.#arr.splice(idx, 1);
    this.#changed('remove', removed);
    return true;
  }

  removeWhere(predicate) {
    const fn = toPredicate(predicate);
    const kept = [];
    const removed = [];
    for (const d of this.#arr) (fn(d) ? removed : kept).push(d);
    this.#store[this.#name] = kept;
    removed.forEach((d) => this.#changed('remove', d));
    return removed.length;
  }

  clear() {
    this.#store[this.#name] = [];
    this.#changed('clear', null);
  }
}

/* ---------------------------------------------------------------- helpers */
function toPredicate(query) {
  if (typeof query === 'function') return query;
  const entries = Object.entries(query);
  return (doc) =>
    entries.every(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('$in' in v) return v.$in.includes(doc[k]);
        if ('$ne' in v) return doc[k] !== v.$ne;
        if ('$gte' in v) return doc[k] >= v.$gte;
        if ('$lte' in v) return doc[k] <= v.$lte;
        if ('$exists' in v) return (doc[k] !== undefined) === v.$exists;
      }
      return doc[k] === v;
    });
}

export const db = new Database();
export { pad };
export default db;
