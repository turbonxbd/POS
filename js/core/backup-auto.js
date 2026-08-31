/**
 * backup-auto.js — automatic local snapshots of the whole dataset.
 *
 * Mock/localStorage mode only: the dataset lives in the browser, so this keeps
 * timestamped copies in IndexedDB (~50 MB+ quota, far more than localStorage)
 * that the owner can restore from if a wipe / bad import / cleared-cache event
 * loses the live copy. Runs every SNAPSHOT_EVERY_MS while the app is open and
 * once more when the tab is hidden/closed; keeps the newest KEEP snapshots.
 *
 * A real (rest-mode) deployment ignores this entirely — the PHP backend's
 * `bin/backup.php` cron + Super Admin → Backups is the authoritative story.
 *
 * Everything is wrapped so a missing IndexedDB (old browser, private window,
 * jsdom in tests) degrades to a no-op instead of throwing.
 */
import db from './db.js';
import bus from './event-bus.js';
import config from '../config.js';

const DB_NAME = 'afia_pos_backups';
const STORE = 'snapshots';
const KEEP = 5;
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000; // never snapshot twice within a minute

let idbPromise = null;
let timer = null;
let lastAt = 0;
let started = false;

function hasIDB() {
  return typeof indexedDB !== 'undefined' && indexedDB && typeof indexedDB.open === 'function';
}

function openDb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(STORE)) {
        idb.createObjectStore(STORE, { keyPath: 'at' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    idbPromise = null;
    throw err;
  });
  return idbPromise;
}

function tx(mode) {
  return openDb().then((idb) => idb.transaction(STORE, mode).objectStore(STORE));
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Write one snapshot now (respecting MIN_GAP_MS) and prune old ones. */
export async function snapshotNow({ force = false, reason = 'auto' } = {}) {
  if (!hasIDB() || config.api?.mode !== 'mock') return null;
  const now = Date.now();
  if (!force && now - lastAt < MIN_GAP_MS) return null;
  lastAt = now;

  let payload;
  try {
    payload = db.export();
  } catch {
    return null;
  }
  const json = JSON.stringify(payload);
  const record = {
    at: new Date(now).toISOString(),
    ts: now,
    reason,
    bytes: json.length,
    collections: Object.fromEntries(
      Object.entries(payload.collections || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]),
    ),
    json,
  };

  try {
    const store = await tx('readwrite');
    await reqToPromise(store.put(record));
    // prune: keep the newest KEEP
    const all = await reqToPromise(store.getAllKeys());
    all.sort();
    const drop = all.slice(0, Math.max(0, all.length - KEEP));
    for (const key of drop) store.delete(key);
    bus.emit('backup:auto-snapshot', { at: record.at, reason });
    return { at: record.at, bytes: record.bytes };
  } catch {
    return null;
  }
}

/** Metadata for every snapshot, newest first (no `json` payload). */
export async function listSnapshots() {
  if (!hasIDB()) return [];
  try {
    const store = await tx('readonly');
    const rows = await reqToPromise(store.getAll());
    return rows
      .map(({ json, ...meta }) => meta) // eslint-disable-line no-unused-vars
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  } catch {
    return [];
  }
}

/** The full JSON backup string for one snapshot (for download). */
export async function readSnapshot(at) {
  if (!hasIDB()) return null;
  try {
    const store = await tx('readonly');
    const row = await reqToPromise(store.get(at));
    return row?.json || null;
  } catch {
    return null;
  }
}

/** Restore the live dataset from a snapshot. Destructive — replaces everything. */
export async function restoreSnapshot(at) {
  const json = await readSnapshot(at);
  if (!json) throw new Error('That snapshot could not be read.');
  const parsed = JSON.parse(json);
  if (!parsed?.collections) throw new Error('That snapshot is not valid.');
  db.import(parsed);
  bus.emit('data:imported');
  bus.emit('backup:restored', { at });
  return true;
}

export async function deleteSnapshot(at) {
  if (!hasIDB()) return;
  try {
    const store = await tx('readwrite');
    await reqToPromise(store.delete(at));
  } catch { /* ignore */ }
}

export function autoBackupStatus() {
  return {
    supported: hasIDB() && config.api?.mode === 'mock',
    running: started,
    everyMs: SNAPSHOT_EVERY_MS,
    keep: KEEP,
    lastAt: lastAt ? new Date(lastAt).toISOString() : null,
  };
}

/** Begin the periodic snapshot loop. Safe to call more than once. */
export function startAutoBackup() {
  if (started || !hasIDB() || config.api?.mode !== 'mock') return;
  started = true;

  // one snapshot shortly after boot (data settled), then on a timer
  setTimeout(() => snapshotNow({ reason: 'startup' }), 20 * 1000);
  timer = setInterval(() => snapshotNow({ reason: 'interval' }), SNAPSHOT_EVERY_MS);

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') snapshotNow({ reason: 'hidden' });
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', () => snapshotNow({ force: true, reason: 'pagehide' }));
  }
}

export function stopAutoBackup() {
  clearInterval(timer);
  started = false;
}

export default { startAutoBackup, snapshotNow, listSnapshots, readSnapshot, restoreSnapshot, deleteSnapshot, autoBackupStatus };
