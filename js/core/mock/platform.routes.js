/**
 * platform.routes.js - Super Admin (platform) endpoints (mock).
 * Every route is gated on a platform actor and reads across ALL merchants.
 * The merchant panels never call these.
 */
import db from '../db.js';
import { ok, created, notFound, badRequest } from './router.js';
import { audit } from './helpers.js';
import { requirePlatform, liveStatus, subscribeMerchant, dueAmount, applyConfirmedPayment, PAYMENT_TYPES } from './platform-helpers.js';
import { activePlans } from './plans.routes.js';
import { getActor } from './context.js';
import { hashPassword } from '../../utils/crypto.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';
import { DEFAULT_PRINT } from '../print-config.js';

const c = (n) => db.collection(n);
const daysAgoIso = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };

function subFor(merchantId) {
  return c('subscriptions').all().find((s) => s.merchantId === merchantId) || null;
}
function ownerOf(merchantId) {
  return c('users').all().find((u) => u.merchantId === merchantId && u.roleId === 'role_owner')
    || c('users').all().find((u) => u.merchantId === merchantId) || null;
}
function businessOf(merchantId) {
  return c('businesses').all().find((b) => b.merchantId === merchantId) || null;
}
function count(name, merchantId, extra = () => true) {
  return c(name).all().filter((r) => r.merchantId === merchantId && extra(r)).length;
}

/* -------------------------------------------------- provision a merchant */
async function provisionMerchant({ name, ownerName, ownerEmail, ownerPassword, platform = false }) {
  const email = String(ownerEmail || '').trim().toLowerCase();
  if (c('users').all().some((u) => u.email.toLowerCase() === email)) {
    const err = new Error('A user with this email already exists.'); err.status = 409; err.name = 'ConflictError'; throw err;
  }
  const merchant = c('merchants').insert({ id: uuid(), name: String(name).trim(), status: 'active', createdAt: now() });
  const M = merchant.id;
  const business = c('businesses').insert({
    id: uuid(), merchantId: M, name: merchant.name, legalName: '', logoId: null,
    address: '', phone: '', email: '', website: '', vatNo: '', currency: 'BDT', currencySymbol: '৳',
  });
  const branch = c('branches').insert({ id: uuid(), merchantId: M, name: 'Main Store', code: 'MAIN', address: '', phone: '', email: '', isDefault: true, status: 'active' });
  const owner = c('users').insert({
    id: uuid(), merchantId: platform ? null : M,
    name: platform ? 'Platform Admin' : (String(ownerName || '').trim() || 'Owner'), email,
    passwordHash: await hashPassword(ownerPassword), roleId: platform ? 'role_super_admin' : 'role_owner',
    status: 'active', platform, permissionGrants: [], permissionRevokes: [], lastLoginAt: null,
  });
  c('employees').insert({ id: uuid(), merchantId: M, userId: owner.id, branchIds: [branch.id], joinDate: now() });
  c('taxes').insert({ id: uuid(), merchantId: M, name: 'VAT 15%', rate: 15, inclusive: false, scope: 'product', isDefault: true, status: 'active' });
  c('settings').insert({ id: 'settings_' + M, merchantId: M, ...defaultMerchantSettings(merchant.name) });
  return { merchantId: M, ownerId: owner.id, ownerEmail: email };
}

function defaultMerchantSettings(businessName) {
  return {
    business: { name: businessName, legalName: '', logoId: null, address: '', phone: '', email: '', website: '', vatNo: '', currency: 'BDT', currencySymbol: '৳', invoicePrefix: 'INV' },
    pos: { invoiceTemplate: 'INV-{BR}-{SEQ}', receiptSize: '80', printAfterSale: true, autoFocusBarcode: true, holdSaleLimit: 20, requireOpenRegister: false, defaultTaxId: null, defaultCustomerId: null, loyaltyPerCurrency: 0.01, quickCash: [50, 100, 200, 500, 1000], allowPriceOverride: true, roundTotalsTo: 0, showProductImages: true },
    inventory: { allowNegativeStock: false, lowStockThreshold: 5, valuationMethod: 'moving_average', autoReorderAlerts: true },
    receipt: { header: businessName, footer: 'Thank you for shopping with us!', showLogo: true, showCashier: true, showBarcode: true, showTaxBreakdown: true },
    notifications: { lowStock: true, newSale: false, refund: true, registerClose: true, purchaseReceived: true },
    security: { sessionIdleTimeoutMin: 30, requirePinForRefund: false, requirePinForDiscount: false },
    printing: { paperSize: '80', marginMm: 4, copies: 1 },
    print: structuredClone(DEFAULT_PRINT),
  };
}

export { provisionMerchant };

/* ================================================================ routes */
export default function register(router) {
  /* ---- dashboard ---- */
  const dashboard = () => {
    requirePlatform();
    const merchants = c('merchants').all();
    const subs = c('subscriptions').all();
    const pays = c('subscription_payments').all();
    const monthAgo = daysAgoIso(30);
    const paid = pays.filter((p) => (p.status || 'paid') === 'paid');
    let active = 0, expired = 0, pastDue = 0, pending = 0, mrr = 0;
    for (const s of subs) {
      const st = liveStatus(s);
      if (st === 'active') { active++; mrr += (s.billingPeriod === 'yearly' ? Math.trunc((s.monthlyPrice ?? s.planPrice ?? 0) / 12) : (s.monthlyPrice ?? s.planPrice ?? 0)); }
      else if (st === 'expired') expired++;
      else if (st === 'past_due') pastDue++;
      else pending++;
    }
    const byType = { initial: 0, monthly: 0, branch: 0 };
    for (const p of paid) byType[p.type || 'monthly'] = (byType[p.type || 'monthly'] || 0) + (p.amount || 0);
    return ok({
      merchants: {
        total: merchants.length,
        active: merchants.filter((m) => m.status === 'active').length,
        inactive: merchants.filter((m) => m.status !== 'active').length,
        new30d: merchants.filter((m) => (m.createdAt || '') >= monthAgo).length,
      },
      subscriptions: { active, expired, pastDue, pending, total: subs.length },
      attention: approvalCounts(),
      revenue: {
        total: paid.reduce((a, p) => a + (p.amount || 0), 0),
        thisMonth: paid.filter((p) => (p.at || '') >= monthAgo).reduce((a, p) => a + (p.amount || 0), 0),
        mrr, payments: paid.length, byType,
        pending: pays.filter((p) => (p.status || 'paid') === 'pending').length,
      },
      usage: {
        branches: c('branches').count(),
        users: c('users').all().filter((u) => !u.platform).length,
        products: c('products').count(),
        sales: c('sales').count(),
        grossSales: c('sales').all().reduce((a, s) => a + (s.grandTotal || 0), 0),
      },
      support: { open: c('support_requests').all().filter((s) => s.status === 'open').length },
      chat: { open: c('chat_threads').all().filter((t) => t.status === 'open').length },
      plans: c('plans').count(),
    });
  };
  router.get('/platform/dashboard', dashboard);
  router.get('/platform/stats', dashboard);

  /* ---- merchants ---- */
  router.get('/platform/merchants', ({ query }) => {
    requirePlatform();
    const monthAgo = daysAgoIso(30);
    let rows = c('merchants').all().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map((m) => {
      const sub = subFor(m.id); const owner = ownerOf(m.id) || {}; const biz = businessOf(m.id) || {};
      return {
        id: m.id, name: m.name, businessName: biz.name || m.name, status: m.status || 'active',
        ownerName: owner.name || '—', email: owner.email || '—', phone: biz.phone || owner.phone || '—',
        registeredAt: m.createdAt,
        planId: sub?.planId || null, planName: sub?.planName || null,
        subscriptionStatus: sub ? liveStatus(sub) : 'none',
        subscriptionStart: sub?.startedAt || null, subscriptionExpiry: sub?.expiresAt || null,
        branches: count('branches', m.id), users: c('users').all().filter((u) => u.merchantId === m.id && !u.platform).length,
        tags: Array.isArray(m.tags) ? m.tags : [],
        noteCount: Array.isArray(m.notes) ? m.notes.length : 0,
      };
    });
    if (query.status && query.status !== 'all') rows = rows.filter((r) => r.status === query.status);
    if (query.subscription && query.subscription !== 'all') rows = rows.filter((r) => r.subscriptionStatus === query.subscription);
    if (query.new === 'true') rows = rows.filter((r) => (r.registeredAt || '') >= monthAgo);
    if (query.planId) rows = rows.filter((r) => r.planId === query.planId);
    if (query.tag) rows = rows.filter((r) => r.tags.includes(query.tag));
    const q = String(query.search || '').trim().toLowerCase();
    if (q) rows = rows.filter((r) => `${r.name} ${r.businessName} ${r.email} ${r.tags.join(' ')}`.toLowerCase().includes(q));

    const allTags = [...new Set(c('merchants').all().flatMap((m) => (Array.isArray(m.tags) ? m.tags : [])))].sort();
    const total = rows.length;
    const pageSize = query.pageSize === 'all' ? (total || 1) : Math.max(1, Number(query.pageSize) || 20);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Number(query.page) || 1), totalPages);
    return ok({ data: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, totalPages, tags: allTags });
  });

  router.get('/platform/merchants/:id', ({ params }) => {
    requirePlatform();
    const m = c('merchants').get(params.id);
    if (!m) notFound('Merchant');
    const sub = subFor(m.id); const biz = businessOf(m.id);
    return ok({
      merchant: { ...m, registeredAt: m.createdAt, tags: Array.isArray(m.tags) ? m.tags : [], notes: Array.isArray(m.notes) ? [...m.notes].sort((a, b) => (b.at || '').localeCompare(a.at || '')) : [] },
      business: biz || null,
      subscription: sub ? { ...sub, liveStatus: liveStatus(sub), dueAmount: dueAmount(sub), branchLimit: (sub.includedBranches || 0) + (sub.extraBranchesPaid || 0) } : null,
      branches: c('branches').all().filter((b) => b.merchantId === m.id),
      users: c('users').all().filter((u) => u.merchantId === m.id && !u.platform).map((u) => ({ id: u.id, name: u.name, email: u.email, roleId: u.roleId, status: u.status })),
      payments: c('subscription_payments').all().filter((p) => p.merchantId === m.id).sort((a, b) => (b.at || '').localeCompare(a.at || '')),
      branchRequests: c('branch_requests').all().filter((r) => r.merchantId === m.id).sort((a, b) => (b.at || '').localeCompare(a.at || '')),
      usage: {
        products: count('products', m.id), customers: count('customers', m.id), sales: count('sales', m.id),
        grossSales: c('sales').all().filter((s) => s.merchantId === m.id).reduce((a, s) => a + (s.grandTotal || 0), 0),
        lastSaleAt: c('sales').all().filter((s) => s.merchantId === m.id).map((s) => s.createdAt).sort().pop() || null,
      },
    });
  });

  router.post('/platform/merchants', async ({ body }) => {
    requirePlatform();
    const { name, ownerEmail, ownerPassword, planId, subscriptionStatus } = body || {};
    if (!name || !ownerEmail || String(ownerPassword || '').length < 8) {
      badRequest('Business name, owner email and an 8+ character password are required', {
        name: !name ? 'Required' : undefined, ownerEmail: !ownerEmail ? 'Required' : undefined,
        ownerPassword: String(ownerPassword || '').length < 8 ? 'Min 8 characters' : undefined,
      });
    }
    return db.tx(async () => {
      const res = await provisionMerchant({ name, ownerEmail, ownerPassword });
      const st = subscriptionStatus || 'active';
      subscribeMerchant(res.merchantId, planId || null, st, { setupPaid: st === 'active' });
      audit('create', 'merchant', res.merchantId, { meta: { name } });
      return created({ merchantId: res.merchantId, ownerEmail: res.ownerEmail });
    });
  });

  router.patch('/platform/merchants/:id', ({ params, body }) => {
    requirePlatform();
    const m = c('merchants').get(params.id);
    if (!m) notFound('Merchant');
    return db.tx(() => {
      const patch = {};
      if (body.name != null) patch.name = String(body.name).trim();
      if (['active', 'suspended'].includes(body.status)) patch.status = body.status;
      if (Array.isArray(body.tags)) {
        patch.tags = [...new Set(body.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean))].slice(0, 12);
      }
      const row = c('merchants').update(params.id, patch);
      // Suspending a merchant must actually cut off access - mirror it onto the
      // subscription so the access gate (which reads the subscription) blocks.
      if (patch.status) {
        const sub = subFor(params.id);
        if (sub) {
          if (patch.status === 'suspended') {
            subscribeMerchant(params.id, sub.planId, 'suspended', { startedAt: sub.startedAt, expiresAt: sub.expiresAt });
          } else if (sub.status === 'suspended') {
            subscribeMerchant(params.id, sub.planId, 'active', { startedAt: sub.startedAt, expiresAt: sub.expiresAt });
          }
        }
      }
      audit('update', 'merchant', params.id, { after: row });
      return ok(row);
    });
  });

  /* ---- reset a merchant owner's password (forgot-password ops flow) ---- */
  router.post('/platform/merchants/:id/reset-owner', async ({ params }) => {
    requirePlatform();
    const m = c('merchants').get(params.id);
    if (!m) notFound('Merchant');
    const staff = c('users').all().filter((u) => u.merchantId === m.id && !u.platform && !u.archivedAt);
    const owner = staff.find((u) => u.roleId === 'role_owner') || staff.find((u) => u.roleId === 'role_admin') || staff[0];
    if (!owner) badRequest('This merchant has no staff account to reset.');
    const temp = 'tx-' + Math.random().toString(36).slice(2, 8) + Math.floor(Math.random() * 90 + 10);
    c('users').update(owner.id, { passwordHash: await hashPassword(temp) });
    c('platform_notifications').all()
      .filter((n) => n.type === 'password_reset' && n.meta?.merchantId === m.id && !n.read)
      .forEach((n) => c('platform_notifications').update(n.id, { read: true, readAt: now() }));
    audit('update', 'user', owner.id, { meta: { action: 'password_reset_by_platform', merchantId: m.id } });
    return ok({ email: owner.email, name: owner.name, tempPassword: temp });
  });

  /* ---- merchant notes (internal CRM, never shown to the merchant) ---- */
  router.post('/platform/merchants/:id/notes', ({ params, body }) => {
    requirePlatform();
    const m = c('merchants').get(params.id);
    if (!m) notFound('Merchant');
    const text = String(body?.text || '').trim();
    if (!text) badRequest('Write a note first.');
    const actor = getActor() || {};
    const note = { id: uuid(), text: text.slice(0, 2000), authorName: actor.name || 'Super Admin', at: now() };
    return db.tx(() => {
      c('merchants').update(m.id, (row) => ({ notes: [...(row.notes || []), note] }));
      audit('update', 'merchant', m.id, { meta: { action: 'note_added' } });
      return created(note);
    });
  });

  router.del('/platform/merchants/:id/notes/:noteId', ({ params }) => {
    requirePlatform();
    const m = c('merchants').get(params.id);
    if (!m) notFound('Merchant');
    return db.tx(() => {
      c('merchants').update(m.id, (row) => ({ notes: (row.notes || []).filter((n) => n.id !== params.noteId) }));
      return ok({ deleted: true });
    });
  });

  /* ---- message a merchant (drops a notification into their panel) ---- */
  router.post('/platform/merchants/:id/message', ({ params, body }) => {
    requirePlatform();
    const m = c('merchants').get(params.id);
    if (!m) notFound('Merchant');
    const title = String(body?.title || '').trim() || 'Message from POS TXbd';
    const message = String(body?.message || '').trim();
    if (!message) badRequest('Write a message first.');
    const actor = getActor() || {};
    return db.tx(() => {
      notifyMerchant(m.id, { title: title.slice(0, 120), message: message.slice(0, 1000), level: body?.level === 'warning' ? 'warning' : 'info', link: body?.link || '#/' });
      c('merchants').update(m.id, (row) => ({ notes: [...(row.notes || []), { id: uuid(), text: `Message sent: "${message.slice(0, 200)}"`, authorName: actor.name || 'Super Admin', at: now(), kind: 'message' }] }));
      audit('update', 'merchant', m.id, { meta: { action: 'message_sent' } });
      return ok({ sent: true });
    });
  });

  /* ---- subscriptions ---- */
  router.get('/platform/subscriptions', ({ query }) => {
    requirePlatform();
    let rows = c('subscriptions').all().map((s) => ({
      ...s, merchantName: c('merchants').get(s.merchantId)?.name || '—',
      liveStatus: liveStatus(s), dueAmount: dueAmount(s),
    }));
    if (query.status && query.status !== 'all') rows = rows.filter((r) => r.liveStatus === query.status);
    return ok({ data: rows, total: rows.length });
  });

  router.patch('/platform/subscriptions/:id', ({ params, body }) => {
    requirePlatform();
    const s = c('subscriptions').get(params.id);
    if (!s) notFound('Subscription');
    const action = body?.action || 'update';
    return db.tx(() => {
      let doc;
      if (action === 'renew') {
        const months = (s.billingPeriod === 'yearly') ? 12 : 1;
        const base = new Date(Math.max(new Date(s.expiresAt || 0).getTime(), Date.now()));
        base.setMonth(base.getMonth() + months);
        doc = subscribeMerchant(s.merchantId, s.planId, 'active', { startedAt: s.startedAt, expiresAt: base.toISOString() });
      } else if (action === 'cancel') {
        doc = subscribeMerchant(s.merchantId, s.planId, 'cancelled', { startedAt: s.startedAt });
      } else if (action === 'change-plan') {
        doc = subscribeMerchant(s.merchantId, body.planId || null, 'active');
      } else {
        const status = ['pending', 'active', 'trialing', 'expired', 'cancelled'].includes(body.status) ? body.status : s.status;
        doc = subscribeMerchant(s.merchantId, body.planId || s.planId, status, { startedAt: s.startedAt });
      }
      audit('update', 'subscription', params.id, { meta: { action } });
      return ok(doc);
    });
  });

  /* ---- payments + revenue ---- */
  const PAY_TYPES = PAYMENT_TYPES;

  router.get('/platform/subscription-payments', ({ query }) => {
    requirePlatform();
    let data = c('subscription_payments').all()
      .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
      .map((p) => {
        const biz = c('businesses').all().find((x) => x.merchantId === p.merchantId);
        const merchantName = c('merchants').get(p.merchantId)?.name || '—';
        return { ...p, merchantName, businessName: biz?.name || merchantName };
      });
    if (query.type && query.type !== 'all') data = data.filter((p) => (p.type || 'monthly') === query.type);
    if (query.status && query.status !== 'all') data = data.filter((p) => (p.status || 'paid') === query.status);
    if (query.merchantId) data = data.filter((p) => p.merchantId === query.merchantId);
    const paid = data.filter((p) => (p.status || 'paid') === 'paid');
    return ok({ data, total: data.length, sum: paid.reduce((a, p) => a + (p.amount || 0), 0) });
  });

  router.post('/platform/subscription-payments', ({ body }) => {
    requirePlatform();
    const merchantId = String(body?.merchantId || '');
    const amount = Math.trunc(Number(body?.amount) || 0);
    if (!merchantId || amount <= 0) badRequest('merchantId and a positive amount are required');
    const type = PAY_TYPES.includes(body?.type) ? body.type : 'monthly';
    const status = ['pending', 'paid', 'failed'].includes(body?.status) ? body.status : 'paid';
    return db.tx(() => {
      const sub = subFor(merchantId);
      const doc = c('subscription_payments').insert({
        id: uuid(), merchantId, subscriptionId: sub?.id || null, planId: body.planId || sub?.planId || null,
        type, status, amount, method: body.method || 'manual', reference: body.reference || null,
        branchRef: body.branchRef || null, note: body.note || '',
        periodStart: body.periodStart || now(), periodEnd: body.periodEnd || sub?.expiresAt || null,
        submittedBy: getActor()?.name || 'Super Admin',
        confirmedBy: status === 'paid' ? (getActor()?.name || 'Super Admin') : null,
        confirmedAt: status === 'paid' ? now() : null,
        at: body.at || now(), createdAt: now(),
      });
      if (status === 'paid') applyConfirmedPayment(doc);
      audit('create', 'subscription_payment', doc.id, { after: doc });
      return created(doc);
    });
  });

  router.patch('/platform/subscription-payments/:id', ({ params, body }) => {
    requirePlatform();
    const p = c('subscription_payments').get(params.id);
    if (!p) notFound('Payment');
    const status = ['paid', 'failed', 'refunded', 'rejected'].includes(body?.status) ? body.status : null;
    if (!status) badRequest('status must be paid, rejected, failed or refunded');
    return db.tx(() => {
      const patch = {
        status,
        confirmedBy: getActor()?.name || 'Super Admin',
        confirmedAt: now(),
        adminNote: body.note != null ? String(body.note) : p.adminNote,
      };
      if (status === 'rejected' && body.reason != null) patch.rejectedReason = String(body.reason);
      const doc = c('subscription_payments').update(params.id, patch);
      if (status === 'paid' && (p.status || 'pending') !== 'paid') applyConfirmedPayment(doc);
      if (status === 'rejected' && p.branchRef) {
        const br = c('branch_requests').get(p.branchRef);
        if (br && br.status === 'pending') c('branch_requests').update(br.id, { status: 'rejected' });
      }
      audit('update', 'subscription_payment', params.id, { meta: { status } });
      return ok(doc);
    });
  });

  router.get('/platform/revenue', () => {
    requirePlatform();
    const pays = c('subscription_payments').all().filter((p) => (p.status || 'paid') === 'paid');
    const all = c('subscription_payments').all();
    const byMonth = new Map(); const byPlan = new Map(); const byType = { initial: 0, monthly: 0, branch: 0 };
    const monthKey = new Date().toISOString().slice(0, 7);
    const dayKey = new Date().toISOString().slice(0, 10);
    let thisMonth = 0; let today = 0;
    for (const p of pays) {
      const mk = String(p.at || '').slice(0, 7);
      byMonth.set(mk, (byMonth.get(mk) || 0) + (p.amount || 0));
      byPlan.set(p.planId || 'unknown', (byPlan.get(p.planId || 'unknown') || 0) + (p.amount || 0));
      byType[p.type || 'monthly'] = (byType[p.type || 'monthly'] || 0) + (p.amount || 0);
      if (mk === monthKey) thisMonth += p.amount || 0;
      if (String(p.at || '').slice(0, 10) === dayKey) today += p.amount || 0;
    }
    const planName = (id) => c('plans').get(id)?.name || 'Unknown';
    const pending = all.filter((p) => (p.status || 'paid') === 'pending');
    const failed = all.filter((p) => p.status === 'failed');
    const rejected = all.filter((p) => p.status === 'rejected');
    // upcoming: active subs billing in the next 30 days
    const soon = Date.now() + 30 * 86400000;
    const upcoming = c('subscriptions').all()
      .filter((s) => ['active', 'past_due'].includes(liveStatus(s)) && s.nextBillingAt && new Date(s.nextBillingAt).getTime() <= soon)
      .map((s) => ({ merchantId: s.merchantId, merchantName: c('merchants').get(s.merchantId)?.name || '—', dueAt: s.nextBillingAt, amount: s.monthlyPrice ?? s.planPrice ?? 0 }))
      .sort((a, b) => (a.dueAt || '').localeCompare(b.dueAt || ''));
    return ok({
      total: pays.reduce((a, p) => a + (p.amount || 0), 0), count: pays.length,
      today, thisMonth,
      byType,
      pendingCount: pending.length, pendingSum: pending.reduce((a, p) => a + (p.amount || 0), 0),
      failedCount: failed.length,
      approvedCount: pays.length, rejectedCount: rejected.length,
      byMonth: [...byMonth.entries()].sort().map(([month, amount]) => ({ month, amount })),
      byPlan: [...byPlan.entries()].map(([planId, amount]) => ({ planId, planName: planName(planId), amount })),
      upcoming,
    });
  });

  /* ---- support ---- */
  router.get('/platform/support', ({ query }) => {
    requirePlatform();
    let rows = c('support_requests').all().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    if (query.status && query.status !== 'all') rows = rows.filter((r) => r.status === query.status);
    return ok({ data: rows, open: c('support_requests').all().filter((r) => r.status === 'open').length });
  });

  router.post('/platform/support/:id/reply', ({ params, body }) => {
    requirePlatform();
    const r = c('support_requests').get(params.id);
    if (!r) notFound('Support request');
    const text = String(body?.text || '').trim();
    if (!text) badRequest('Reply text is required');
    return db.tx(() => {
      const replies = [...(r.replies || []), { by: 'Super Admin', text, at: now() }];
      return ok(c('support_requests').update(params.id, { replies, status: 'answered' }));
    });
  });

  router.patch('/platform/support/:id', ({ params, body }) => {
    requirePlatform();
    if (!c('support_requests').get(params.id)) notFound('Support request');
    const status = ['open', 'answered', 'closed'].includes(body?.status) ? body.status : 'open';
    return ok(c('support_requests').update(params.id, { status }));
  });

  /* ---- platform notifications (Super Admin bell) ---- */
  router.get('/platform/notifications', ({ query }) => {
    requirePlatform();
    let rows = c('platform_notifications').all().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    if (query.unread === 'true') rows = rows.filter((n) => !n.read);
    const unreadCount = c('platform_notifications').all().filter((n) => !n.read).length;
    const pageSize = Math.max(1, Number(query.pageSize) || 30);
    return ok({ data: rows.slice(0, pageSize), total: rows.length, unreadCount });
  });

  router.post('/platform/notifications/:id/read', ({ params }) => {
    requirePlatform();
    const n = c('platform_notifications').get(params.id);
    if (!n) notFound('Notification');
    return ok(c('platform_notifications').update(params.id, { read: true, readAt: now() }));
  });

  router.post('/platform/notifications/read-all', () => {
    requirePlatform();
    return db.tx(() => {
      c('platform_notifications').all().filter((n) => !n.read).forEach((n) => c('platform_notifications').update(n.id, { read: true, readAt: now() }));
      return ok({ ok: true });
    });
  });

  router.del('/platform/notifications/:id', ({ params }) => {
    requirePlatform();
    c('platform_notifications').remove(params.id);
    return ok({ deleted: true });
  });

  /* ---- approvals inbox (pending merchants + pending payments + overdue) ---- */
  function pendingPaymentFor(merchantId) {
    return c('subscription_payments').all()
      .filter((p) => p.merchantId === merchantId && (p.status || 'pending') === 'pending')
      .sort((a, b) => (b.at || '').localeCompare(a.at || ''))[0] || null;
  }
  function merchantWhatsapp(biz) {
    const num = String(biz?.phone || '').replace(/[^0-9]/g, '');
    return num ? `https://wa.me/${num}` : null;
  }
  function approvalRows() {
    return c('merchants').all().map((m) => {
      const sub = subFor(m.id);
      const live = sub ? liveStatus(sub) : 'none';
      const pend = pendingPaymentFor(m.id);
      const needs = live === 'pending' || live === 'past_due' || live === 'expired' || !!pend;
      if (!needs) return null;
      const owner = ownerOf(m.id) || {}; const biz = businessOf(m.id) || {};
      return {
        merchantId: m.id, businessName: biz.name || m.name, ownerName: owner.name || '—',
        email: owner.email || '—', phone: biz.phone || owner.phone || '',
        planName: sub?.planName || null,
        setupPrice: sub?.setupPrice || 0, monthlyPrice: sub?.monthlyPrice ?? sub?.planPrice ?? 0,
        setupPaid: !!sub?.setupPaid, subscriptionStatus: live, dueAmount: sub ? dueAmount(sub, live) : 0,
        registeredAt: m.createdAt, accountStatus: m.status || 'active',
        pendingPayment: pend ? {
          id: pend.id, type: pend.type, amount: pend.amount, method: pend.method,
          reference: pend.reference || null, accountNumber: pend.accountNumber || null,
          proofImage: pend.proofImage || null, note: pend.note || null, at: pend.at,
        } : null,
        whatsapp: merchantWhatsapp(biz),
      };
    }).filter(Boolean).sort((a, b) => (b.pendingPayment ? 1 : 0) - (a.pendingPayment ? 1 : 0) || (a.registeredAt || '').localeCompare(b.registeredAt || ''));
  }
  function approvalCounts(rows = approvalRows()) {
    return {
      accounts: rows.filter((r) => r.subscriptionStatus === 'pending').length,
      payments: rows.filter((r) => r.pendingPayment).length,
      overdue: rows.filter((r) => r.subscriptionStatus === 'past_due' || r.subscriptionStatus === 'expired').length,
    };
  }

  function notifyMerchant(merchantId, { title, message, level = 'info', link = '#/billing' }) {
    return c('notifications').insert({
      id: uuid(), merchantId, type: 'billing', title, message, level,
      read: false, link, meta: {}, at: now(), createdAt: now(),
    });
  }

  router.get('/platform/approvals', () => {
    requirePlatform();
    const rows = approvalRows();
    return ok({ data: rows, counts: approvalCounts(rows) });
  });

  router.post('/platform/approvals/:merchantId/approve', ({ params }) => {
    requirePlatform();
    const m = c('merchants').get(params.merchantId);
    if (!m) notFound('Merchant');
    return db.tx(() => {
      const pend = pendingPaymentFor(m.id);
      if (pend) {
        const doc = c('subscription_payments').update(pend.id, {
          status: 'paid', confirmedBy: getActor()?.name || 'Super Admin', confirmedAt: now(),
        });
        if ((pend.status || 'pending') !== 'paid') applyConfirmedPayment(doc);
      } else {
        const sub = subFor(m.id);
        if (sub) subscribeMerchant(m.id, sub.planId, 'active', { startedAt: now(), setupPaid: true, lastPaymentAt: now() });
      }
      if ((m.status || 'active') !== 'active') c('merchants').update(m.id, { status: 'active' });
      notifyMerchant(m.id, {
        title: 'Account approved',
        message: 'Your POS TXbd account has been verified and approved. You now have full access.',
        level: 'info',
      });
      audit('update', 'merchant', m.id, { meta: { action: 'approve' } });
      return ok({ ok: true, merchantId: m.id });
    });
  });

  router.post('/platform/approvals/:merchantId/reject', ({ params, body }) => {
    requirePlatform();
    const m = c('merchants').get(params.merchantId);
    if (!m) notFound('Merchant');
    const reason = String(body?.reason || '').trim() || 'Payment could not be verified.';
    return db.tx(() => {
      const pend = pendingPaymentFor(m.id);
      if (pend) {
        c('subscription_payments').update(pend.id, {
          status: 'rejected', rejectedReason: reason,
          confirmedBy: getActor()?.name || 'Super Admin', confirmedAt: now(),
        });
        if (pend.branchRef) {
          const br = c('branch_requests').get(pend.branchRef);
          if (br && br.status === 'pending') c('branch_requests').update(br.id, { status: 'rejected' });
        }
      }
      notifyMerchant(m.id, {
        title: 'Payment not verified',
        message: `We could not verify your payment: ${reason} Please check the details and submit again.`,
        level: 'warning',
      });
      audit('update', 'merchant', m.id, { meta: { action: 'reject', reason } });
      return ok({ ok: true, merchantId: m.id });
    });
  });

  /* expose for consistency (also used by activePlans) */
  void activePlans;
}
