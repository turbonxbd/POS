/**
 * mock/scope.js - data-access scoping for the mock backend.
 *
 * This build runs as a SINGLE business, so `tdb(name)` is a
 * transparent pass-through to `db.collection(name)`. The wrapper is kept because
 * every route already calls it and it is the natural seam to re-introduce
 * multi-business isolation later - `scopeFilterFor()` already contains the
 * per-tenant filter, gated behind `isLegacyMode()` which is currently always
 * true (no `merchants` collection exists).
 */

import db from '../db.js';
import { HttpError } from '../http.js';
import { getScopeMerchantId, getWriteMerchantId, ALL_TENANTS } from './context.js';

/** Collections that would carry a `merchantId` in a multi-business deployment. */
export const TENANT_COLLECTIONS = new Set([
  'businesses', 'branches', 'products', 'categories', 'brands',
  'customers', 'customer_ledger', 'suppliers', 'supplier_payments',
  'sales', 'sale_items', 'payments', 'held_sales', 'sale_returns',
  'purchases', 'purchase_returns',
  'inventory_transactions', 'stock', 'stock_adjustments', 'stock_transfers',
  'expenses', 'discounts', 'taxes',
  'register_sessions', 'register_movements',
  'notifications', 'settings', 'employees',
]);

// Platform-global collections: rows may carry no merchantId and are visible to
// everyone (plans on the public Live panel) or only to platform admins.
const SHARED_ALLOW_NULL_MERCHANT = new Set(['roles', 'plans', 'support_requests']);

class UnauthenticatedError extends HttpError {
  constructor() {
    super(401, 'Your session has expired. Please sign in again.', { message: 'Not authenticated' });
  }
}

/** Single-business mode: no `merchants` collection -> every collection is global. */
export function isLegacyMode() {
  return db.collection('merchants').count() === 0;
}

function scopeFilterFor(collection) {
  if (isLegacyMode()) return () => true;
  const scope = getScopeMerchantId();
  if (scope === ALL_TENANTS) return () => true;
  if (scope == null) throw new UnauthenticatedError();
  const allowNull = SHARED_ALLOW_NULL_MERCHANT.has(collection);
  return (doc) => doc.merchantId === scope || (allowNull && doc.merchantId == null);
}

class ScopedCollection {
  #name;
  constructor(name) {
    this.#name = name;
  }
  /**
   * ALWAYS resolve a fresh Collection. db.tx() rollback swaps db's internal
   * data object, so a cached Collection would keep writing to an orphaned
   * store and its changes would silently never persist.
   */
  get #col() {
    return db.collection(this.#name);
  }
  #filter() {
    return scopeFilterFor(this.#name);
  }
  all() { return this.#col.all().filter(this.#filter()); }
  get(id) {
    const doc = this.#col.get(id);
    return doc && this.#filter()(doc) ? doc : null;
  }
  find(predicate) { return this.#col.find(predicate).filter(this.#filter()); }
  findOne(predicate) { return this.#col.find(predicate).find(this.#filter()) || null; }
  count(predicate) { return this.find(predicate == null ? () => true : predicate).length; }
  exists(predicate) { return this.count(predicate) > 0; }
  insert(doc) {
    if (isLegacyMode()) return this.#col.insert(doc);
    const mid = doc.merchantId || getWriteMerchantId();
    if (!mid) throw new HttpError(403, 'No business scope for this write.', { message: 'No tenant scope' });
    return this.#col.insert({ ...doc, merchantId: mid });
  }
  insertMany(docs) { return docs.map((d) => this.insert(d)); }
  update(id, patch) {
    const existing = this.get(id);
    if (!existing) throw new HttpError(404, `${cap(this.#name)} not found`, { message: 'Not found or not in your account' });
    const clean = typeof patch === 'function' ? patch : { ...patch };
    if (clean && typeof clean === 'object') delete clean.merchantId;
    return this.#col.update(id, clean);
  }
  upsert(doc) {
    if (doc.id && this.get(doc.id)) return this.update(doc.id, doc);
    return this.insert(doc);
  }
  remove(id) {
    if (!this.get(id)) return false;
    return this.#col.remove(id);
  }
  removeWhere(predicate) {
    const ids = this.find(predicate).map((d) => d.id);
    ids.forEach((id) => this.#col.remove(id));
    return ids.length;
  }
}

const cache = new Map();
export function tdb(name) {
  if (!cache.has(name)) cache.set(name, new ScopedCollection(name));
  return cache.get(name);
}

/** The active business id (null in single-business mode). */
export function currentMerchantId() {
  const s = getScopeMerchantId();
  return s === ALL_TENANTS ? null : s;
}

function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1).replace(/_/g, ' ');
}
