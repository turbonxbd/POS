/**
 * finance.routes.js - expenses, taxes/VAT, discounts, and the cash register.
 */

import db from '../db.js';
import { tdb } from './scope.js';
import { ok, created, notFound, badRequest, conflict, applyListQuery } from './router.js';
import { defineResource } from './resource.js';
import { audit, notify, requireBranch, actorStamp , seqKey } from './helpers.js';
import money from '../../utils/money.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';

const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Internet', 'Salary', 'Transport', 'Maintenance', 'Marketing', 'Supplies', 'Other'];

export default function register(router) {
  /* ------------------------------------------------------------- expenses */
  router.get('/expense-categories', () => ok(EXPENSE_CATEGORIES));

  defineResource(router, {
    base: '/expenses',
    collection: 'expenses',
    entity: 'expense',
    softDelete: false,
    allowHardDelete: true,
    listOptions: {
      searchable: ['description', 'category', 'note', 'reference'],
      sortable: ['at', 'amount', 'category'], defaultSort: 'at', defaultDir: 'desc',
      filters: { category: 'category', paymentMethod: 'paymentMethod', branchId: 'branchId' },
      dateField: 'at',
      summarize: (list) => ({
        totalAmount: list.reduce((s, e) => s + (e.amount || 0), 0),
        count: list.length,
      }),
    },
    beforeCreate: (b) => {
      if (!EXPENSE_CATEGORIES.includes(b.category)) badRequest('Choose a valid expense category', { category: 'Invalid' });
      const amount = Math.trunc(b.amount || 0);
      if (amount <= 0) badRequest('Amount must be greater than zero', { amount: 'Required' });
      const branch = requireBranch(b.branchId);
      return {
        reference: db.seq(seqKey('expense'), { template: 'EXP-{YY}{MM}-{SEQ}', seqWidth: 4 }),
        category: b.category, description: String(b.description || '').trim(), amount,
        paymentMethod: b.paymentMethod || 'cash', branchId: branch.id,
        employeeId: b.employeeId || actorStamp().userId, employeeName: actorStamp().userName,
        note: b.note || '', attachmentRef: b.attachmentRef || null,
        registerSessionId: tdb('register_sessions').findOne((s) => s.branchId === branch.id && s.status === 'open')?.id || null,
        at: b.at || now(),
      };
    },
    afterCreate: (row) => audit('create', 'expense', row.id, { after: row }),
  });

  /* ------------------------------------------------------------- taxes */
  const normalizeTax = (b, existing = {}) => {
    const type = b.type || existing.type || 'percent';
    const out = { ...b, type };
    if (type === 'fixed') {
      const amount = Math.trunc(b.amount ?? existing.amount ?? 0);
      if (!(amount > 0)) badRequest('Enter a VAT amount greater than zero', { amount: 'Invalid' });
      out.amount = amount;
      out.rate = 0;
      out.inclusive = false;
    } else {
      const rate = Number(b.rate ?? existing.rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) badRequest('Rate must be between 0 and 100', { rate: 'Invalid' });
      out.rate = rate;
      out.amount = 0;
    }
    if (b.name != null) out.name = String(b.name).trim();
    if (b.scope != null) out.scope = b.scope;
    if (b.inclusive != null && type !== 'fixed') out.inclusive = !!b.inclusive;
    if (b.isDefault != null) out.isDefault = !!b.isDefault;
    return out;
  };
  defineResource(router, {
    base: '/taxes',
    collection: 'taxes',
    entity: 'tax',
    listOptions: { searchable: ['name'], sortable: ['name', 'rate'], defaultSort: 'name', defaultDir: 'asc', pageSize: 'all' },
    beforeCreate: (b) => ({ scope: 'product', isDefault: false, inclusive: false, ...normalizeTax(b), status: 'active' }),
    beforeUpdate: (b, existing) => normalizeTax(b, existing),
    afterCreate: (row) => { if (row.isDefault) clearOtherDefaults('taxes', row.id); },
    afterUpdate: (row) => { if (row.isDefault) clearOtherDefaults('taxes', row.id); },
  });

  /* ------------------------------------------------------------- discounts */
  defineResource(router, {
    base: '/discounts',
    collection: 'discounts',
    entity: 'discount',
    listOptions: { searchable: ['name', 'code'], sortable: ['name', 'value', 'createdAt'], defaultSort: 'createdAt', defaultDir: 'desc' },
    beforeCreate: (b) => {
      if (!b.name) badRequest('Discount name is required', { name: 'Required' });
      if (!['percent', 'fixed'].includes(b.type)) badRequest('Choose a discount type', { type: 'Invalid' });
      if (b.code && tdb('discounts').exists((d) => d.code && d.code.toLowerCase() === String(b.code).toLowerCase())) {
        conflict('That coupon code is already in use.');
      }
      return {
        name: String(b.name).trim(), code: b.code ? String(b.code).trim().toUpperCase() : null,
        type: b.type, value: Number(b.value) || 0, scope: b.scope || 'cart',
        appliesTo: b.appliesTo || [], minSpend: Math.trunc(b.minSpend || 0),
        maxDiscount: Math.trunc(b.maxDiscount || 0), customerId: b.customerId || null,
        startsAt: b.startsAt || null, endsAt: b.endsAt || null,
        usageLimit: Number(b.usageLimit) || 0, usageCount: 0, status: b.status || 'active',
      };
    },
  });

  router.post('/discounts/validate', ({ body }) => {
    const code = String(body?.code || '').trim().toUpperCase();
    const subtotal = Math.trunc(body?.subtotal || 0);
    const d = tdb('discounts').findOne((x) => x.code === code && x.status === 'active' && !x.archivedAt);
    if (!d) return ok({ valid: false, message: 'Coupon not found or inactive.' });
    const t = Date.now();
    if (d.startsAt && new Date(d.startsAt).getTime() > t) return ok({ valid: false, message: 'This coupon is not active yet.' });
    if (d.endsAt && new Date(d.endsAt).getTime() < t) return ok({ valid: false, message: 'This coupon has expired.' });
    if (d.usageLimit && d.usageCount >= d.usageLimit) return ok({ valid: false, message: 'This coupon has reached its usage limit.' });
    if (d.minSpend && subtotal < d.minSpend) return ok({ valid: false, message: `Spend at least ${money.format(d.minSpend)} to use this coupon.` });
    let amount = d.type === 'percent' ? money.percent(subtotal, d.value) : money.toMinor(d.value);
    if (d.maxDiscount) amount = Math.min(amount, d.maxDiscount);
    return ok({ valid: true, discount: d, amount, type: d.type, value: d.value });
  });

  /* ==================================================== CASH REGISTER */
  router.get('/cash-register/current', ({ query }) => {
    const branch = requireBranch(query.branchId);
    const stamp = actorStamp();
    const session = tdb('register_sessions').findOne(
      (s) => s.branchId === branch.id && s.status === 'open' && (s.cashierId === stamp.userId || !query.mine),
    );
    return ok(session ? withSessionTotals(session) : null);
  });

  router.get('/cash-register/sessions', ({ query }) => {
    let rows = tdb('register_sessions').all();
    if (query.branchId) rows = rows.filter((s) => s.branchId === query.branchId);
    if (query.cashierId) rows = rows.filter((s) => s.cashierId === query.cashierId);
    if (query.status && query.status !== 'all') rows = rows.filter((s) => s.status === query.status);
    const decorated = rows.map((s) => withSessionTotals(s));
    return ok(applyListQuery(decorated, query, {
      searchable: ['reference', 'cashierName'], sortable: ['openedAt', 'reference', 'expectedCash'],
      defaultSort: 'openedAt', defaultDir: 'desc',
      summarize: (list) => ({
        sessions: list.length,
        open: list.filter((r) => r.status === 'open').length,
        cashOnHandOpen: list.filter((r) => r.status === 'open').reduce((s, r) => s + (r.expectedCash || 0), 0),
        discrepancies: list.filter((r) => r.difference).length,
      }),
    }));
  });

  router.get('/cash-register/sessions/:id', ({ params }) => {
    const s = tdb('register_sessions').get(params.id);
    if (!s) notFound('Register session');
    return ok(withSessionTotals(s, true));
  });

  router.post('/cash-register/open', ({ body }) => {
    const branch = requireBranch(body?.branchId);
    const stamp = actorStamp();
    if (tdb('register_sessions').exists((s) => s.branchId === branch.id && s.status === 'open' && s.cashierId === stamp.userId)) {
      conflict('You already have an open register session at this branch.');
    }
    const opening = Math.trunc(body?.openingCash || 0);
    if (opening < 0) badRequest('Opening cash cannot be negative');
    return db.tx(() => {
      const ref = db.seq(`register:${branch.id}`, { template: 'REG-{BR}-{SEQ}', branchCode: branch.code || 'MAIN', seqWidth: 4 });
      const doc = tdb('register_sessions').insert({
        id: uuid(), reference: ref, branchId: branch.id, branchName: branch.name,
        cashierId: stamp.userId, cashierName: stamp.userName,
        openingCash: opening, openingNote: body.note || '',
        status: 'open', openedAt: now(), closedAt: null,
        closingCountedCash: null, closingExpectedCash: null, difference: null, closingNote: '',
      });
      audit('update', 'register_session', doc.id, { meta: { action: 'open', openingCash: opening } });
      return created(withSessionTotals(doc));
    });
  });

  router.post('/cash-register/sessions/:id/movements', ({ params, body }) => {
    const session = tdb('register_sessions').get(params.id);
    if (!session) notFound('Register session');
    if (session.status !== 'open') conflict('This register session is closed.');
    const amount = Math.trunc(body?.amount || 0);
    if (amount <= 0) badRequest('Amount must be greater than zero');
    if (!['in', 'out'].includes(body?.direction)) badRequest('Direction must be "in" or "out"');
    return db.tx(() => {
      const doc = tdb('register_movements').insert({
        id: uuid(), sessionId: session.id, branchId: session.branchId,
        direction: body.direction, amount, reason: body.reason || (body.direction === 'in' ? 'cash_in' : 'cash_out'),
        note: body.note || '', at: now(), userId: actorStamp().userId,
      });
      audit('update', 'register_session', session.id, { meta: { movement: body.direction, amount } });
      return created(doc);
    });
  });

  router.post('/cash-register/sessions/:id/close', ({ params, body }) => {
    const session = tdb('register_sessions').get(params.id);
    if (!session) notFound('Register session');
    if (session.status !== 'open') conflict('This register session is already closed.');
    const counted = Math.trunc(body?.countedCash || 0);
    return db.tx(() => {
      const totals = computeSessionCash(session);
      const difference = counted - totals.expectedCash;
      const row = tdb('register_sessions').update(session.id, {
        status: 'closed', closedAt: now(),
        closingCountedCash: counted, closingExpectedCash: totals.expectedCash,
        difference, closingNote: body.note || '',
        totalsSnapshot: totals,
      });
      audit('update', 'register_session', session.id, { meta: { action: 'close', difference, counted } });
      notify('register_close', 'Register closed', `${session.reference}: expected ${money.format(totals.expectedCash)}, counted ${money.format(counted)} (${difference === 0 ? 'balanced' : (difference > 0 ? 'over ' : 'short ') + money.format(Math.abs(difference))}).`, {
        level: difference === 0 ? 'success' : 'warning', link: `#/cash-register`,
      });
      return ok(withSessionTotals(row, true));
    });
  });
}

/* ------------------------------------------------------------ helpers */
function clearOtherDefaults(collection, keepId) {
  db.collection(collection).find((d) => d.isDefault && d.id !== keepId).forEach((d) => db.collection(collection).update(d.id, { isDefault: false }));
}

function computeSessionCash(session) {
  const from = new Date(session.openedAt).getTime();
  const to = session.closedAt ? new Date(session.closedAt).getTime() : Date.now();
  const inWindow = (iso) => { const t = new Date(iso).getTime(); return t >= from && t <= to; };

  const payments = tdb('payments').find((p) => p.branchId === session.branchId && inWindow(p.at));
  const cashSales = payments.filter((p) => p.method === 'cash' && p.direction === 'in' && !p.saleReturnId).reduce((s, p) => s + p.amount, 0);
  const cashRefunds = payments.filter((p) => p.method === 'cash' && p.direction === 'out').reduce((s, p) => s + p.amount, 0);
  const cardSales = payments.filter((p) => p.method !== 'cash' && p.direction === 'in').reduce((s, p) => s + p.amount, 0);

  const expenses = tdb('expenses').find((e) => e.branchId === session.branchId && e.paymentMethod === 'cash' && inWindow(e.at)).reduce((s, e) => s + e.amount, 0);
  const movements = tdb('register_movements').find({ sessionId: session.id });
  const cashIn = movements.filter((m) => m.direction === 'in').reduce((s, m) => s + m.amount, 0);
  const cashOut = movements.filter((m) => m.direction === 'out').reduce((s, m) => s + m.amount, 0);

  const salesCount = tdb('sales').count((s) => s.branchId === session.branchId && inWindow(s.createdAt));
  const expectedCash = session.openingCash + cashSales + cashIn - cashRefunds - expenses - cashOut;

  return { openingCash: session.openingCash, cashSales, cardSales, cashRefunds, cashExpenses: expenses, cashIn, cashOut, expectedCash, salesCount };
}

function withSessionTotals(session, full = false) {
  const totals = session.status === 'closed' && session.totalsSnapshot ? session.totalsSnapshot : computeSessionCash(session);
  return {
    ...session,
    expectedCash: totals.expectedCash,
    ...totals,
    movements: full ? tdb('register_movements').find({ sessionId: session.id }) : undefined,
  };
}
