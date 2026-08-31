/**
 * purchasing.routes.js - suppliers, purchases (with receiving), purchase returns.
 * Receiving stock increases inventory; purchase returns decrease it.
 */

import db from '../db.js';
import { tdb } from './scope.js';
import { ok, created, notFound, badRequest, conflict, applyListQuery } from './router.js';
import { defineResource } from './resource.js';
import { audit, notify, postInventory, requireBranch, actorStamp , seqKey } from './helpers.js';
import money from '../../utils/money.js';
import { now } from '../../utils/date.js';
import { uuid } from '../../utils/id.js';

function computePurchase(lines) {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  const items = lines.map((l) => {
    const qty = Number(l.qty) || 0;
    const gross = money.mul(l.unitCost, qty);
    const disc = l.discountType === 'percent' ? money.percent(gross, l.discountValue || 0) : money.mul(l.discountValue || 0, qty);
    const net = Math.max(0, gross - disc);
    const tax = l.taxRate ? money.percent(net, l.taxRate) : 0;
    subtotal += gross;
    discountTotal += disc;
    taxTotal += tax;
    return { ...l, id: l.id || uuid(), qty, gross, discount: disc, tax, lineTotal: net + tax, receivedQty: l.receivedQty || 0, returnedQty: l.returnedQty || 0 };
  });
  return { items, subtotal, discountTotal, taxTotal, grandTotal: subtotal - discountTotal + taxTotal };
}

function decoratePurchase(p) {
  const supplier = tdb('suppliers').get(p.supplierId);
  const branch = tdb('branches').get(p.branchId);
  return { ...p, supplierName: supplier?.name || '—', branchName: branch?.name || null };
}

export default function register(router) {
  /* ------------------------------------------------------------ suppliers */
  defineResource(router, {
    base: '/suppliers',
    collection: 'suppliers',
    entity: 'supplier',
    listOptions: {
      searchable: ['name', 'phone', 'email', 'company'],
      sortable: ['name', 'currentBalance', 'createdAt'], defaultSort: 'name', defaultDir: 'asc',
      filters: { status: 'status' },
    },
    beforeCreate: (b) => ({
      name: String(b.name || '').trim(),
      phone: b.phone || '', email: b.email || '', company: b.company || '',
      address: b.address || '', openingBalance: Math.trunc(b.openingBalance || 0),
      currentBalance: Math.trunc(b.openingBalance || 0), status: b.status || 'active', note: b.note || '',
    }),
    decorate: (s) => ({
      ...s,
      totalPurchases: tdb('purchases').find({ supplierId: s.id }).reduce((sum, p) => sum + (p.grandTotal || 0), 0),
      purchaseCount: tdb('purchases').count({ supplierId: s.id }),
    }),
  });

  router.get('/suppliers/:id/statement', ({ params }) => {
    const supplier = tdb('suppliers').get(params.id);
    if (!supplier) notFound('Supplier');
    const purchases = tdb('purchases').find({ supplierId: params.id }).map((p) => ({ type: 'purchase', ref: p.reference, amount: p.grandTotal, paid: p.paidTotal, at: p.createdAt }));
    const payments = tdb('supplier_payments').find({ supplierId: params.id }).map((p) => ({ type: 'payment', ref: p.reference, amount: p.amount, at: p.at }));
    const entries = [...purchases, ...payments].sort((a, b) => new Date(a.at) - new Date(b.at));
    return ok({ supplier, entries });
  });

  router.post('/suppliers/:id/payments', ({ params, body }) => {
    const supplier = tdb('suppliers').get(params.id);
    if (!supplier) notFound('Supplier');
    const amount = Math.trunc(body?.amount || 0);
    if (amount <= 0) badRequest('Payment amount must be greater than zero');
    return db.tx(() => {
      const ref = db.seq(seqKey('supplier_payment'), { template: 'SPMT-{YY}{MM}-{SEQ}', seqWidth: 4 });
      const doc = tdb('supplier_payments').insert({
        id: uuid(), reference: ref, supplierId: params.id, amount, method: body.method || 'cash',
        note: body.note || '', at: now(),
      });
      tdb('suppliers').update(params.id, (s) => ({ currentBalance: (s.currentBalance || 0) - amount }));
      audit('create', 'supplier_payment', doc.id, { after: doc });
      return created(doc);
    });
  });

  /* ------------------------------------------------------------ purchases */
  router.get('/purchases', ({ query }) => {
    let rows = tdb('purchases').all();
    if (query.supplierId) rows = rows.filter((p) => p.supplierId === query.supplierId);
    if (query.branchId) rows = rows.filter((p) => p.branchId === query.branchId);
    if (query.status && query.status !== 'all') rows = rows.filter((p) => p.status === query.status);
    if (query.from || query.to) {
      const from = query.from ? new Date(query.from).getTime() : -Infinity;
      const to = query.to ? new Date(query.to).getTime() : Infinity;
      rows = rows.filter((p) => { const t = new Date(p.createdAt).getTime(); return t >= from && t <= to; });
    }
    const result = applyListQuery(rows.map(decoratePurchase), query, {
      searchable: ['reference', 'supplierName', 'invoiceRef'],
      sortable: ['createdAt', 'reference', 'grandTotal', 'status'], defaultSort: 'createdAt', defaultDir: 'desc',
    });
    return ok(result);
  });

  router.get('/purchases/:id', ({ params }) => {
    const p = tdb('purchases').get(params.id);
    if (!p) notFound('Purchase');
    return ok(decoratePurchase(p));
  });

  router.post('/purchases', ({ body }) => {
    const branch = requireBranch(body?.branchId);
    const supplier = tdb('suppliers').get(body?.supplierId);
    if (!supplier) badRequest('Select a supplier', { supplierId: 'Required' });
    if (!body.lines?.length) badRequest('Add at least one product line', { lines: 'Required' });
    const calc = computePurchase(body.lines);
    const paidTotal = Math.trunc(body.paidTotal || 0);
    if (paidTotal > calc.grandTotal) badRequest('Paid amount exceeds the purchase total');

    return db.tx(() => {
      const ref = db.seq(seqKey('purchase'), { template: 'PO-{YY}{MM}-{SEQ}', seqWidth: 4 });
      const status = body.status === 'draft' ? 'draft' : 'ordered';
      const doc = tdb('purchases').insert({
        id: uuid(), reference: ref, branchId: branch.id, supplierId: supplier.id,
        invoiceRef: body.invoiceRef || '', note: body.note || '',
        lines: calc.items, subtotal: calc.subtotal, discountTotal: calc.discountTotal,
        taxTotal: calc.taxTotal, grandTotal: calc.grandTotal,
        paidTotal, dueTotal: calc.grandTotal - paidTotal, status,
        expectedAt: body.expectedAt || null, createdAt: now(), receivedAt: null,
      });
      if (paidTotal > 0) tdb('suppliers').update(supplier.id, (s) => ({ currentBalance: (s.currentBalance || 0) + (calc.grandTotal - paidTotal) }));
      else tdb('suppliers').update(supplier.id, (s) => ({ currentBalance: (s.currentBalance || 0) + calc.grandTotal }));
      audit('create', 'purchase', doc.id, { after: doc, meta: { reference: ref } });
      return created(decoratePurchase(doc));
    });
  });

  router.patch('/purchases/:id', ({ params, body }) => {
    const existing = tdb('purchases').get(params.id);
    if (!existing) notFound('Purchase');
    if (['received', 'cancelled'].includes(existing.status)) conflict(`A ${existing.status} purchase cannot be edited.`);
    const calc = body.lines ? computePurchase(body.lines) : null;
    return db.tx(() => {
      const patch = { ...body };
      if (calc) Object.assign(patch, { lines: calc.items, subtotal: calc.subtotal, discountTotal: calc.discountTotal, taxTotal: calc.taxTotal, grandTotal: calc.grandTotal, dueTotal: calc.grandTotal - (body.paidTotal ?? existing.paidTotal) });
      const row = tdb('purchases').update(params.id, patch);
      audit('update', 'purchase', row.id, { before: existing, after: row });
      return ok(decoratePurchase(row));
    });
  });

  router.post('/purchases/:id/receive', ({ params, body }) => {
    const purchase = tdb('purchases').get(params.id);
    if (!purchase) notFound('Purchase');
    if (purchase.status === 'cancelled') conflict('This purchase was cancelled.');
    if (purchase.status === 'received') conflict('This purchase is already fully received.');
    const receiveLines = body?.lines || purchase.lines.map((l) => ({ lineId: l.id || l.productId, qty: l.qty - (l.receivedQty || 0) }));

    return db.tx(() => {
      let anyReceived = false;
      const nextLines = purchase.lines.map((l) => {
        const key = l.id || l.productId;
        const match = receiveLines.find((r) => (r.lineId || r.productId) === key);
        const receiveQty = match ? Math.min(Number(match.qty) || 0, l.qty - (l.receivedQty || 0)) : 0;
        if (receiveQty > 0) {
          anyReceived = true;
          postInventory({
            branchId: purchase.branchId, productId: l.productId, variantId: l.variantId || null,
            type: 'purchase', qtyDelta: receiveQty, unitCost: l.unitCost,
            refType: 'purchase', refId: purchase.id, note: `PO ${purchase.reference}`,
          });
        }
        return { ...l, receivedQty: (l.receivedQty || 0) + receiveQty };
      });
      if (!anyReceived) badRequest('Nothing left to receive on this purchase');

      const fully = nextLines.every((l) => (l.receivedQty || 0) >= l.qty);
      const row = tdb('purchases').update(purchase.id, {
        lines: nextLines,
        status: fully ? 'received' : 'partially_received',
        receivedAt: fully ? now() : purchase.receivedAt,
      });
      audit('receive', 'purchase', row.id, { meta: { reference: purchase.reference, fully } });
      notify('purchase_received', 'Stock received', `${purchase.reference} ${fully ? 'fully' : 'partially'} received into ${tdb('branches').get(purchase.branchId)?.name || 'branch'}.`, {
        level: 'success', link: `#/purchases/${purchase.id}`,
      });
      return ok(decoratePurchase(row));
    });
  });

  router.post('/purchases/:id/cancel', ({ params }) => {
    const purchase = tdb('purchases').get(params.id);
    if (!purchase) notFound('Purchase');
    if (purchase.status === 'received' || purchase.status === 'partially_received') {
      conflict('Cannot cancel a purchase that already received stock. Create a purchase return instead.');
    }
    return db.tx(() => {
      const row = tdb('purchases').update(params.id, { status: 'cancelled' });
      tdb('suppliers').update(purchase.supplierId, (s) => ({ currentBalance: Math.max(0, (s.currentBalance || 0) - purchase.dueTotal) }));
      audit('update', 'purchase', row.id, { meta: { action: 'cancel' } });
      return ok(decoratePurchase(row));
    });
  });

  /* ------------------------------------------------------ purchase returns */
  router.get('/purchase-returns', ({ query }) => {
    let rows = tdb('purchase_returns').all();
    if (query.supplierId) rows = rows.filter((r) => r.supplierId === query.supplierId);
    return ok(applyListQuery(rows, query, {
      searchable: ['reference', 'supplierName'], sortable: ['at', 'reference', 'returnTotal'], defaultSort: 'at', defaultDir: 'desc',
    }));
  });

  router.post('/purchases/:id/returns', ({ params, body }) => {
    const purchase = tdb('purchases').get(params.id);
    if (!purchase) notFound('Purchase');
    const lines = body?.lines || [];
    if (!lines.length) badRequest('Select items to return');

    return db.tx(() => {
      const ref = db.seq(seqKey('purchase_return'), { template: 'PRET-{YY}{MM}-{SEQ}', seqWidth: 4 });
      let returnTotal = 0;
      const items = [];
      for (const line of lines) {
        const pl = purchase.lines.find((l) => (l.id || l.productId) === (line.lineId || line.productId));
        if (!pl) badRequest('A line does not belong to this purchase');
        const qty = Number(line.qty);
        const returnable = (pl.receivedQty || 0) - (pl.returnedQty || 0);
        if (!Number.isInteger(qty) || qty <= 0) badRequest('Invalid return quantity');
        if (qty > returnable) conflict(`Only ${returnable} of "${tdb('products').get(pl.productId)?.name}" can be returned.`);
        postInventory({
          branchId: purchase.branchId, productId: pl.productId, variantId: pl.variantId || null,
          type: 'purchase_return', qtyDelta: -qty, unitCost: pl.unitCost,
          refType: 'purchase_return', refId: ref, note: `Return to supplier — ${purchase.reference}`,
        });
        const amount = money.mul(pl.unitCost, qty);
        returnTotal += amount;
        items.push({ productId: pl.productId, variantId: pl.variantId || null, name: tdb('products').get(pl.productId)?.name, qty, amount });
        pl.returnedQty = (pl.returnedQty || 0) + qty;
      }
      tdb('purchases').update(purchase.id, { lines: purchase.lines });
      const doc = tdb('purchase_returns').insert({
        id: uuid(), reference: ref, purchaseId: purchase.id, purchaseRef: purchase.reference,
        supplierId: purchase.supplierId, supplierName: tdb('suppliers').get(purchase.supplierId)?.name,
        branchId: purchase.branchId, reason: body.reason || 'defective', note: body.note || '',
        items, returnTotal, at: now(), userId: actorStamp().userId, userName: actorStamp().userName,
      });
      tdb('suppliers').update(purchase.supplierId, (s) => ({ currentBalance: Math.max(0, (s.currentBalance || 0) - returnTotal) }));
      audit('refund', 'purchase_return', doc.id, { after: doc });
      notify('system', 'Purchase returned', `${ref} — ${money.format(returnTotal)} returned to ${doc.supplierName}.`, { level: 'info' });
      return created(doc);
    });
  });
}
