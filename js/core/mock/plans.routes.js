/**
 * plans.routes.js - subscription plans (mock).
 *   GET /plans              - PUBLIC, active plans for the Live/Public panel
 *   GET /platform/plans     - Super Admin, all plans
 *   POST/PATCH/DELETE /platform/plans[/:id]
 *
 * Plans are platform-global (no merchantId). Editing a plan here is what the
 * Live panel shows - one source of truth for pricing.
 */
import db from '../db.js';
import { ok, created, notFound, badRequest } from './router.js';
import { audit } from './helpers.js';
import { requirePlatform } from './platform-helpers.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';

const col = () => db.collection('plans');

export function activePlans() {
  return col().all()
    .filter((p) => p.status === 'active' && !p.archivedAt)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.price - b.price);
}

const int0 = (v) => Math.max(0, Math.trunc(Number(v) || 0));

function normalize(body, existing) {
  const b = body || {};
  const out = {
    ...(existing || { features: [], limits: {}, popular: false, status: 'active', sortOrder: 0 }),
  };
  if (b.name != null) out.name = String(b.name).trim();
  if (b.description != null) out.description = String(b.description);
  // monthlyPrice is canonical; `price` mirrors it for older readers.
  if (b.monthlyPrice != null) out.monthlyPrice = int0(b.monthlyPrice);
  else if (b.price != null && existing == null) out.monthlyPrice = int0(b.price);
  else if (b.price != null && b.monthlyPrice == null) out.monthlyPrice = int0(b.price);
  if (b.setupPrice != null) out.setupPrice = int0(b.setupPrice);
  if (b.includedBranches != null) out.includedBranches = int0(b.includedBranches);
  if (b.extraBranchPrice != null) out.extraBranchPrice = b.extraBranchPrice === '' ? null : int0(b.extraBranchPrice);
  if (b.billingPeriod && ['monthly', 'yearly'].includes(b.billingPeriod)) out.billingPeriod = b.billingPeriod;
  if (Array.isArray(b.features)) out.features = b.features.map(String);
  if (b.limits && typeof b.limits === 'object') out.limits = b.limits;
  if (b.popular != null) out.popular = !!b.popular;
  if (b.status && ['active', 'archived'].includes(b.status)) out.status = b.status;
  if (b.sortOrder != null) out.sortOrder = Math.trunc(Number(b.sortOrder) || 0);
  out.currency = out.currency || 'BDT';
  out.currencySymbol = out.currencySymbol || '৳';
  out.billingPeriod = out.billingPeriod || 'monthly';
  out.description = out.description || '';
  out.monthlyPrice = int0(out.monthlyPrice ?? out.price);
  out.price = out.monthlyPrice;
  out.setupPrice = int0(out.setupPrice);
  out.includedBranches = out.includedBranches != null ? int0(out.includedBranches) : int0(out.limits?.branches) || 1;
  if (out.extraBranchPrice != null) out.extraBranchPrice = int0(out.extraBranchPrice);
  else if (!('extraBranchPrice' in out)) out.extraBranchPrice = null;
  return out;
}

export default function register(router) {
  router.get('/plans', () => ok({ data: activePlans() }));

  router.get('/platform/plans', () => {
    requirePlatform();
    return ok({ data: col().all().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)) });
  });

  router.post('/platform/plans', ({ body }) => {
    requirePlatform();
    const priceGiven = body?.price != null || body?.monthlyPrice != null;
    if (!body?.name || !priceGiven) {
      badRequest('Plan name and monthly price are required', { name: !body?.name ? 'Required' : undefined, monthlyPrice: !priceGiven ? 'Required' : undefined });
    }
    return db.tx(() => {
      const row = col().insert({ id: uuid(), ...normalize(body, null), createdAt: now() });
      audit('create', 'plan', row.id, { after: row });
      return created(row);
    });
  });

  router.patch('/platform/plans/:id', ({ params, body }) => {
    requirePlatform();
    const existing = col().get(params.id);
    if (!existing) notFound('Plan');
    return db.tx(() => {
      const row = col().update(params.id, normalize(body, existing));
      audit('update', 'plan', row.id, { before: existing, after: row });
      return ok(row);
    });
  });

  router.del('/platform/plans/:id', ({ params }) => {
    requirePlatform();
    if (!col().get(params.id)) notFound('Plan');
    return db.tx(() => {
      col().update(params.id, { status: 'archived', archivedAt: now() });
      audit('archive', 'plan', params.id);
      return ok({ archived: true, id: params.id });
    });
  });
}
