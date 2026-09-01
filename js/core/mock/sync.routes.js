/**
 * sync.routes.js - lightweight change feed for cross-device real-time.
 *
 * `GET /sync/changes?since=<cursor>` returns the names of the merchant's
 * collections that have a row newer than `cursor`, plus a new cursor. The client
 * (js/core/sync-poll.js) polls this every few seconds and emits `db:changed` so
 * open tables re-fetch — no page refresh. The payload never carries row data, so
 * it stays tiny even across slow connections, and it is merchant-scoped through
 * tdb() so one merchant never learns another changed anything.
 */
import { tdb } from './scope.js';
import { ok } from './router.js';

// merchant-owned collections whose changes a live UI cares about
export const WATCH = [
  'products', 'categories', 'brands', 'customers', 'branches', 'suppliers',
  'stock', 'inventory_transactions', 'stock_adjustments', 'stock_transfers',
  'sales', 'sale_items', 'payments', 'sale_returns', 'purchases', 'purchase_returns',
  'taxes', 'discounts', 'expenses', 'register_sessions', 'register_movements',
  'customer_ledger', 'settings', 'notifications',
];

const stampOf = (row) => row.updatedAt || row.createdAt || row.at || '';

export default function register(router) {
  router.get('/sync/changes', ({ query }) => {
    const since = String(query.since || '');
    const changed = [];
    let cursor = since;
    for (const name of WATCH) {
      let maxAt = '';
      for (const row of tdb(name).all()) {
        const t = stampOf(row);
        if (t > maxAt) maxAt = t;
      }
      if (maxAt && maxAt > since) {
        changed.push(name);
        if (maxAt > cursor) cursor = maxAt;
      }
    }
    return ok({ cursor: cursor || new Date().toISOString(), changed });
  });
}
