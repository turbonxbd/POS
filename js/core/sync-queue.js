/**
 * sync-queue.js - offline resilience architecture (§34).
 *
 * When a mutation (currently: completing a sale) fails because the network is
 * down, it is enqueued locally with its idempotency key. On reconnect the queue
 * is replayed in order. Because every queued request carries an idempotencyKey,
 * a replay can never create a duplicate. Conflicts (e.g. server already has a
 * newer record) are surfaced explicitly - never silently overwritten.
 */

import config from '../config.js';
import bus from './event-bus.js';
import store from './store.js';
import http, { HttpError } from './http.js';
import { uuid } from '../utils/id.js';

const QKEY = config.storage.syncQueueKey;

function load() {
  try {
    return JSON.parse(localStorage.getItem(QKEY)) || [];
  } catch {
    return [];
  }
}
function save(items) {
  try {
    localStorage.setItem(QKEY, JSON.stringify(items));
  } catch (err) {
    console.error('[sync] could not persist queue', err);
  }
  store.set({ syncPending: items.filter((i) => i.status !== 'done').length });
}

export const syncQueue = {
  list() {
    return load();
  },

  enqueue({ method = 'POST', path, body, kind = 'sale' }) {
    const items = load();
    const item = {
      id: uuid(),
      kind,
      method,
      path,
      body,
      idempotencyKey: body?.idempotencyKey || uuid(),
      status: 'queued', // queued | syncing | done | conflict | failed
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    };
    if (!item.body.idempotencyKey) item.body.idempotencyKey = item.idempotencyKey;
    items.push(item);
    save(items);
    bus.emit('sync:enqueued', item);
    return item;
  },

  remove(id) {
    save(load().filter((i) => i.id !== id));
  },

  clearResolved() {
    save(load().filter((i) => !['done'].includes(i.status)));
  },

  async flush() {
    if (!navigator.onLine) return { flushed: 0, pending: load().length };
    const items = load();
    let flushed = 0;
    for (const item of items) {
      if (item.status === 'done' || item.status === 'conflict') continue;
      item.status = 'syncing';
      item.attempts += 1;
      save(items);
      try {
        const result = await http.raw(item.method, item.path, { body: item.body });
        item.status = 'done';
        item.result = { id: result?.id, invoiceNo: result?.invoiceNo };
        flushed += 1;
        bus.emit('sync:item-synced', { item, result });
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) {
          item.status = 'conflict';
          item.lastError = err.message;
          bus.emit('sync:conflict', { item, error: err });
        } else if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) {
          item.status = 'failed';
          item.lastError = err.message;
          bus.emit('sync:item-failed', { item, error: err });
        } else {
          item.status = 'queued'; // transient - retry next flush
          item.lastError = err.message;
        }
        save(items);
      }
    }
    save(items);
    if (flushed) bus.emit('sync:flushed', { flushed });
    return { flushed, pending: load().filter((i) => i.status === 'queued').length };
  },

  start() {
    store.set({ syncPending: load().filter((i) => i.status === 'queued').length });
    window.addEventListener('online', () => {
      bus.emit('sync:online');
      this.flush();
    });
    // opportunistic periodic flush
    setInterval(() => {
      if (navigator.onLine && load().some((i) => i.status === 'queued')) this.flush();
    }, 20000);
  },
};

export default syncQueue;
