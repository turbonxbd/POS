/**
 * platform-helpers.js - shared bits for the Super Admin (platform) mock routes.
 */
import db from '../db.js';
import { HttpError } from '../http.js';
import { getActor } from './context.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';
import { platformSettings } from './platform-settings.routes.js';

export const PAYMENT_TYPES = ['initial', 'monthly', 'branch'];

export function requirePlatform() {
  const a = getActor();
  if (!a) throw new HttpError(401, 'Not authenticated', { message: 'Not authenticated' });
  if (!a.platform) throw new HttpError(403, 'Super Admin access required', { message: 'Super Admin access required' });
  return a;
}

export function graceDays() {
  const g = platformSettings().billing?.graceDays;
  return Number.isFinite(g) ? g : 7;
}

/**
 * Effective, date-aware subscription status:
 *   none | pending | active | past_due | expired | suspended | cancelled
 * `past_due` = the period lapsed but the merchant is still inside the grace
 * window; `expired` = past grace (access gets blocked in phase 6).
 */
export function liveStatus(sub, grace) {
  if (!sub) return 'none';
  // a subscription may carry its own grace window (0 = hard cut-off at expiry)
  if (grace == null) grace = Number.isFinite(sub.graceDays) ? sub.graceDays : graceDays();
  const s = sub.status || 'pending';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'suspended') return 'suspended';
  if (s === 'expired') return 'expired';
  if (s === 'pending' || s === 'trialing_setup') return 'pending';
  if (s === 'active' || s === 'trialing') {
    if (!sub.expiresAt) return 'active';
    const end = new Date(sub.expiresAt).getTime();
    const now = Date.now();
    if (now <= end) return 'active';
    if (now <= end + grace * 86400000) return 'past_due';
    return 'expired';
  }
  return 'pending';
}

/** What the merchant owes right now, given the live status. */
export function dueAmount(sub, status = liveStatus(sub)) {
  if (!sub) return 0;
  if (status === 'pending' && !sub.setupPaid) return sub.setupPrice || 0;
  if (status === 'past_due' || status === 'expired') return sub.monthlyPrice ?? sub.planPrice ?? 0;
  return 0;
}

/** True when Admin + Cashier should be blocked (phase 6 enforces this). */
export function isBlocked(sub, status = liveStatus(sub)) {
  return status === 'expired' || status === 'suspended' || status === 'cancelled';
}

// Paths a blocked merchant may still reach (read their data, pay, sign out).
const GATE_ALLOW = [
  /^\/auth\//, /^\/billing\//, /^\/public/, /^\/plans$/, /^\/signup$/, /^\/support$/, /^\/chat/,
];

/**
 * Soft access gate: a merchant whose subscription is blocked (expired past the
 * grace window, suspended, or cancelled) may still READ their data and pay, but
 * cannot make changes. GET is always allowed; other verbs get 402 unless the
 * path is on the allow-list. Platform actors and legacy single-tenant mode are
 * exempt. Call this before dispatching a mock request.
 */
export function enforceAccessGate({ method, path }) {
  if (!method || method.toUpperCase() === 'GET') return;
  const actor = getActor();
  if (!actor || actor.platform || !actor.merchantId) return;
  const clean = String(path || '').split('?')[0];
  if (GATE_ALLOW.some((re) => re.test(clean))) return;
  const sub = subscriptionFor(actor.merchantId);
  if (!sub || !isBlocked(sub)) return;
  const state = liveStatus(sub);
  throw new HttpError(402, 'Your subscription needs attention before you can make changes.', {
    message: 'Subscription blocked',
    subscriptionBlocked: true,
    state,
    dueAmount: dueAmount(sub, state),
  });
}

export function planById(id) {
  return id ? db.collection('plans').get(id) : null;
}

/* ------------------------------------------------ platform notifications */

const NOTIF_TYPE_LABEL = {
  initial: 'initial plan purchase',
  monthly: 'monthly server & backup charge',
  branch: 'additional branch',
};

/** Insert a platform-wide (Super Admin) notification. Not merchant-scoped. */
export function notifyPlatform({ type, title, message, level = 'info', link = '#/payments', meta = {} }) {
  return db.collection('platform_notifications').insert({
    id: uuid(), type, title, message, level, link, meta,
    read: false, readAt: null, at: now(), createdAt: now(),
  });
}

/** A merchant just submitted a manual payment that needs Super Admin approval. */
export function notifyPaymentRequest(pay, planOrBranch) {
  const biz = db.collection('businesses').all().find((b) => b.merchantId === pay.merchantId)?.name
    || db.collection('merchants').get(pay.merchantId)?.name || 'A merchant';
  const amt = `৳${((pay.amount || 0) / 100).toLocaleString('en-BD')}`;
  return notifyPlatform({
    type: 'payment_request',
    title: 'New payment request',
    message: `${biz} submitted a ${NOTIF_TYPE_LABEL[pay.type] || pay.type} payment of ${amt}${pay.reference ? ` · Txn ${pay.reference}` : ''}`,
    level: 'warning',
    link: '#/payments?status=pending',
    meta: {
      paymentId: pay.id, merchantId: pay.merchantId, type: pay.type,
      amount: pay.amount, reference: pay.reference || null, planOrBranch: planOrBranch || null,
    },
  });
}

function addPeriod(iso, billingPeriod) {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + (billingPeriod === 'yearly' ? 12 : 1));
  return d.toISOString();
}

/**
 * Create / replace a merchant's subscription, snapshotting the plan's setup /
 * monthly / branch terms onto the row (standard SaaS: the merchant keeps their
 * agreed terms until they change plan).
 */
export function subscribeMerchant(merchantId, planId, status = 'pending', opts = {}) {
  const { startedAt = null, expiresAt = null, setupPaid, extraBranchesPaid, lastPaymentAt } = opts;
  const plan = planById(planId);
  const period = plan?.billingPeriod || 'monthly';
  const start = startedAt || new Date().toISOString();
  const end = expiresAt || addPeriod(start, period);
  const existing = db.collection('subscriptions').all().find((x) => x.merchantId === merchantId);

  const monthlyPrice = plan?.monthlyPrice ?? plan?.price ?? existing?.monthlyPrice ?? null;
  const doc = {
    id: existing?.id || uuid(), merchantId, planId: planId || null,
    planName: plan?.name || existing?.planName || null,
    planPrice: monthlyPrice, monthlyPrice,
    setupPrice: plan?.setupPrice ?? existing?.setupPrice ?? 0,
    includedBranches: plan?.includedBranches ?? existing?.includedBranches ?? 1,
    billingPeriod: period,
    status,
    setupPaid: setupPaid != null ? !!setupPaid : (existing?.setupPaid ?? false),
    extraBranchesPaid: extraBranchesPaid != null ? Math.max(0, Math.trunc(extraBranchesPaid)) : (existing?.extraBranchesPaid ?? 0),
    startedAt: start, expiresAt: end,
    nextBillingAt: end,
    lastPaymentAt: lastPaymentAt !== undefined ? lastPaymentAt : (existing?.lastPaymentAt ?? null),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  doc.branchLimit = (doc.includedBranches || 0) + (doc.extraBranchesPaid || 0);
  if (existing) db.collection('subscriptions').update(existing.id, doc);
  else db.collection('subscriptions').insert(doc);
  return doc;
}

export { addPeriod };

export function subscriptionFor(merchantId) {
  return db.collection('subscriptions').all().find((s) => s.merchantId === merchantId) || null;
}

/** Branches this merchant is entitled to (included + purchased). 0 subscription => unlimited. */
export function branchLimitFor(merchantId) {
  const sub = subscriptionFor(merchantId);
  if (!sub) return Infinity;
  const included = sub.includedBranches ?? 1;
  return included === 0 ? Infinity : included + (sub.extraBranchesPaid || 0);
}

/** Price of one extra branch: the plan's own price, else the platform default. */
export function extraBranchPrice(sub) {
  const plan = planById(sub?.planId);
  if (plan && plan.extraBranchPrice != null) return plan.extraBranchPrice;
  const d = platformSettings().billing?.defaultExtraBranchPrice;
  return Number.isFinite(d) ? d : 0;
}

/**
 * Push a just-confirmed (status 'paid') payment into the merchant's
 * subscription state. Shared by the Super Admin routes and merchant self-service
 * billing so both paths behave identically.
 */
export function applyConfirmedPayment(pay) {
  const sub = subscriptionFor(pay.merchantId);
  if (!sub) return;
  if (pay.type === 'initial') {
    subscribeMerchant(pay.merchantId, sub.planId, 'active', { startedAt: now(), setupPaid: true, lastPaymentAt: now() });
  } else if (pay.type === 'branch') {
    subscribeMerchant(pay.merchantId, sub.planId, liveStatus(sub) === 'expired' ? 'active' : sub.status, {
      startedAt: sub.startedAt, expiresAt: sub.expiresAt,
      extraBranchesPaid: (sub.extraBranchesPaid || 0) + 1, lastPaymentAt: now(),
    });
    const bReq = db.collection('branch_requests').all().find((r) => r.id === pay.branchRef && r.status !== 'activated');
    if (bReq) {
      // the branch was paid for - create it so it is immediately usable
      const code = String(bReq.code || bReq.name || 'BR').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'BR';
      const uniqueCode = db.collection('branches').all().some((b) => b.merchantId === pay.merchantId && b.code === code) ? code + Math.floor(Math.random() * 90 + 10) : code;
      const branch = db.collection('branches').insert({
        id: uuid(), merchantId: pay.merchantId, name: bReq.name, code: uniqueCode,
        address: bReq.address || '', phone: '', email: '', isDefault: false, status: 'active',
      });
      db.collection('branch_requests').update(bReq.id, { status: 'activated', paymentId: pay.id, branchId: branch.id });
    }
  } else {
    const base = new Date(Math.max(new Date(sub.expiresAt || 0).getTime(), Date.now())).toISOString();
    subscribeMerchant(pay.merchantId, sub.planId, 'active', {
      startedAt: sub.startedAt, expiresAt: addPeriod(base, sub.billingPeriod), lastPaymentAt: now(),
    });
  }
}
