/**
 * sync-poll.js - cross-device real-time via polling.
 *
 * Shared PHP hosting can't hold WebSocket or SSE connections, so real-time is a
 * short poll of GET /sync/changes?since=<cursor>: the server answers with the
 * merchant's collections that changed since the cursor (never row data — the
 * payload is a handful of strings). We emit `db:changed` for those, and the
 * pages already subscribed to it (createDataTable, dashboards, POS catalog)
 * re-fetch on their own. No page refresh, no localStorage guesswork — the
 * signal is the real database.
 *
 * Same-browser tabs are already covered by db.startCrossTabSync() (the storage
 * event); this adds the other devices. Started from boot() in `rest` mode.
 */
import config from '../config.js';
import bus from './event-bus.js';
import store from './store.js';
import http from './http.js';

let timer = null;
let cursor = '';
let inFlight = false;
let backoff = 0;

async function tick() {
  if (inFlight) return;
  if (!store.get('user')) return; // not signed in
  if (store.get('online') === false) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

  inFlight = true;
  try {
    const res = await http.get('/sync/changes', { params: { since: cursor } });
    if (res && res.cursor) cursor = res.cursor;
    if (res && Array.isArray(res.changed) && res.changed.length) {
      bus.emit('db:changed', res.changed);
      bus.emit('db:external-change', res.changed);
    }
    backoff = 0;
  } catch {
    backoff = Math.min(backoff + 1, 5); // ease off while the network is unhappy
  } finally {
    inFlight = false;
  }
}

export function startSyncPoll() {
  if (timer) return;
  cursor = new Date().toISOString(); // only care about changes from now on
  const interval = Math.max(1000, config.sync?.pollMs || 3500);
  timer = setInterval(() => { if (backoff === 0 || Math.random() < 1 / (backoff + 1)) tick(); }, interval);
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => { backoff = 0; tick(); });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    });
  }
  bus.on('net:online', () => { backoff = 0; tick(); });
}

export function stopSyncPoll() {
  clearInterval(timer);
  timer = null;
}

/** For tests: force one poll now and wait for it. */
export async function pollOnce() {
  await tick();
}

export default startSyncPoll;
