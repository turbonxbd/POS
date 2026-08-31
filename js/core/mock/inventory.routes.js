/**
 * inventory.routes.js - stock levels, the movement ledger, adjustments,
 * transfers between branches, and valuation. Every quantity change goes through
 * postInventory() so the ledger and the cached balance never diverge.
 */

import db from '../db.js';
import { tdb } from './scope.js';
import { ok, created, notFound, badRequest, applyListQuery } from './router.js';
import { audit, notify, postInventory, resolveBranchId, requireBranch, variantName , seqKey } from './helpers.js';
import money from '../../utils/money.js';
import { now } from '../../utils/date.js';
import { uuid } from '../../utils/id.js';

function productLabel(productId, variantId) {
  const p = tdb('products').get(productId);
  if (!p) return productId;
  return p.name + (variantId ? ` — ${variantName(p, variantId)}` : '');
}

export default function register(router) {
  /* ------------------------------------------------------- stock overview */
  router.get('/inventory', ({ query }) => {
    const branchId = query.branchId || resolveBranchId();
    const products = tdb('products').all().filter((p) => !p.archivedAt && p.trackInventory !== false);
    const rows = [];
    for (const p of products) {
      const targets = p.variants?.length ? p.variants.map((v) => ({ variantId: v.id, label: variantName(p, v.id), min: v.minStock ?? p.minStock, cost: v.costPrice })) : [{ variantId: null, label: null, min: p.minStock, cost: p.costPrice }];
      for (const t of targets) {
        const stockRow = tdb('stock').get(`stk_${branchId}_${p.id}_${t.variantId || 'base'}`);
        const qty = stockRow?.quantity || 0;
        const avgCost = stockRow?.avgCost || t.cost || 0;
        rows.push({
          id: `${p.id}:${t.variantId || 'base'}`,
          productId: p.id,
          variantId: t.variantId,
          name: p.name,
          variantLabel: t.label,
          sku: t.variantId ? p.variants.find((v) => v.id === t.variantId)?.sku : p.sku,
          categoryName: p.categoryId ? tdb('categories').get(p.categoryId)?.name : null,
          quantity: qty,
          reserved: stockRow?.reserved || 0,
          available: qty - (stockRow?.reserved || 0),
          minStock: Number(t.min) || 0,
          avgCost,
          stockValue: money.mul(avgCost, qty),
          status: qty <= 0 ? 'out_of_stock' : (t.min > 0 && qty <= t.min ? 'low_stock' : 'in_stock'),
          lastMovementAt: stockRow?.lastMovementAt || null,
        });
      }
    }
    let filtered = rows;
    if (query.status && query.status !== 'all') filtered = filtered.filter((r) => r.status === query.status);
    if (query.product) filtered = filtered.filter((r) => r.productId === query.product);
    const result = applyListQuery(filtered, query, {
      searchable: ['name', 'sku', 'variantLabel'],
      sortable: ['name', 'quantity', 'available', 'stockValue', 'lastMovementAt'],
      defaultSort: 'name', defaultDir: 'asc',
    });
    const summary = {
      totalSkus: rows.length,
      inStock: rows.filter((r) => r.status === 'in_stock').length,
      lowStock: rows.filter((r) => r.status === 'low_stock').length,
      outOfStock: rows.filter((r) => r.status === 'out_of_stock').length,
      totalValue: rows.reduce((s, r) => s + r.stockValue, 0),
      totalUnits: rows.reduce((s, r) => s + r.quantity, 0),
    };
    return ok({ ...result, summary });
  });

  /* --------------------------------------------------------- movement log */
  router.get('/inventory/movements', ({ query }) => {
    const branchId = query.branchId || resolveBranchId();
    let rows = tdb('inventory_transactions').all().filter((t) => t.branchId === branchId);
    if (query.product) rows = rows.filter((t) => t.productId === query.product);
    if (query.type && query.type !== 'all') rows = rows.filter((t) => t.type === query.type);
    if (query.from || query.to) {
      const from = query.from ? new Date(query.from).getTime() : -Infinity;
      const to = query.to ? new Date(query.to).getTime() : Infinity;
      rows = rows.filter((t) => { const x = new Date(t.at).getTime(); return x >= from && x <= to; });
    }
    const decorated = rows.map((t) => ({
      ...t,
      productName: productLabel(t.productId, t.variantId),
      sku: tdb('products').get(t.productId)?.sku || null,
    }));
    const result = applyListQuery(decorated, query, {
      searchable: ['productName', 'sku', 'note', 'refId'],
      sortable: ['at', 'qtyDelta', 'balanceAfter', 'type'],
      defaultSort: 'at', defaultDir: 'desc',
    });
    return ok(result);
  });

  /* ------------------------------------------------------ adjustments */
  router.get('/inventory/adjustments', ({ query }) => {
    const branchId = query.branchId || resolveBranchId();
    let rows = tdb('stock_adjustments').all().filter((a) => a.branchId === branchId);
    const result = applyListQuery(rows, query, {
      searchable: ['reference', 'reason', 'note'],
      sortable: ['at', 'reference', 'type'], defaultSort: 'at', defaultDir: 'desc',
      filters: { type: 'type', reason: 'reason' },
    });
    return ok(result);
  });

  router.post('/inventory/adjustments', ({ body }) => {
    const branch = requireBranch(body?.branchId);
    const lines = body?.lines || [];
    if (!lines.length) badRequest('Add at least one product line to adjust');
    const reason = body.reason || 'manual';
    const validReasons = ['manual', 'damage', 'lost', 'expiry', 'theft', 'correction', 'recount'];
    if (!validReasons.includes(reason)) badRequest('Invalid adjustment reason');

    return db.tx(() => {
      const ref = db.seq(seqKey('stock_adjustment'), { template: 'ADJ-{YY}{MM}-{SEQ}', seqWidth: 4 });
      const ledgerIds = [];
      let netUnits = 0;
      let valueImpact = 0;
      for (const line of lines) {
        const product = tdb('products').get(line.productId);
        if (!product) notFound('Product in adjustment');
        const delta = Number(line.deltaQty);
        if (!Number.isFinite(delta) || delta === 0) badRequest(`Invalid quantity for ${product.name}`);
        const type = delta > 0 ? 'adjustment' : (['damage', 'lost', 'expiry', 'theft'].includes(reason) ? reason : 'adjustment');
        const unitCost = tdb('stock').get(`stk_${branch.id}_${line.productId}_${line.variantId || 'base'}`)?.avgCost || product.costPrice || 0;
        const res = postInventory({
          branchId: branch.id, productId: line.productId, variantId: line.variantId || null,
          type, qtyDelta: delta, unitCost, refType: 'stock_adjustment', refId: ref,
          note: line.note || reason, allowNegative: false,
        });
        ledgerIds.push(res.ledger.id);
        netUnits += delta;
        valueImpact += money.mul(unitCost, delta);
      }
      const doc = tdb('stock_adjustments').insert({
        id: uuid(), reference: ref, branchId: branch.id, type: netUnits >= 0 ? 'increase' : 'decrease',
        reason, note: body.note || '', lines: lines.map((l) => ({ ...l })), ledgerIds,
        netUnits, valueImpact, at: now(),
      });
      audit('adjust', 'stock_adjustment', doc.id, { after: doc, meta: { reference: ref, netUnits } });
      notify('system', 'Stock adjusted', `${ref}: ${netUnits >= 0 ? '+' : ''}${netUnits} units (${reason}).`, { level: 'info', link: '#/stock-adjustments' });
      return created(doc);
    });
  });

  /* -------------------------------------------------------- transfers */
  router.get('/inventory/transfers', ({ query }) => {
    const rows = tdb('stock_transfers').all();
    const result = applyListQuery(rows.map((t) => ({
      ...t,
      fromName: tdb('branches').get(t.fromBranchId)?.name,
      toName: tdb('branches').get(t.toBranchId)?.name,
    })), query, { searchable: ['reference', 'fromName', 'toName'], sortable: ['at', 'reference'], defaultSort: 'at', defaultDir: 'desc' });
    return ok(result);
  });

  router.post('/inventory/transfers', ({ body }) => {
    const { fromBranchId, toBranchId, lines = [], note = '' } = body || {};
    if (!fromBranchId || !toBranchId || fromBranchId === toBranchId) badRequest('Choose two different branches');
    if (!lines.length) badRequest('Add at least one product line');
    const from = tdb('branches').get(fromBranchId);
    const to = tdb('branches').get(toBranchId);
    if (!from || !to) notFound('Branch');

    return db.tx(() => {
      const ref = db.seq(seqKey('stock_transfer'), { template: 'TRF-{YY}{MM}-{SEQ}', seqWidth: 4 });
      for (const line of lines) {
        const qty = Math.abs(Number(line.qty));
        if (!qty) badRequest('Transfer quantity must be greater than zero');
        const avgCost = tdb('stock').get(`stk_${fromBranchId}_${line.productId}_${line.variantId || 'base'}`)?.avgCost || 0;
        postInventory({ branchId: fromBranchId, productId: line.productId, variantId: line.variantId || null, type: 'transfer_out', qtyDelta: -qty, unitCost: avgCost, refType: 'stock_transfer', refId: ref, note: `Transfer to ${to.name}` });
        postInventory({ branchId: toBranchId, productId: line.productId, variantId: line.variantId || null, type: 'transfer_in', qtyDelta: qty, unitCost: avgCost, refType: 'stock_transfer', refId: ref, note: `Transfer from ${from.name}` });
      }
      const doc = tdb('stock_transfers').insert({
        id: uuid(), reference: ref, fromBranchId, toBranchId, lines, note, status: 'completed', at: now(),
      });
      audit('transfer', 'stock_transfer', doc.id, { after: doc, meta: { reference: ref } });
      return created(doc);
    });
  });

  /* -------------------------------------------------------- valuation */
  router.get('/inventory/valuation', ({ query }) => {
    const branchId = query.branchId || resolveBranchId();
    const stockRows = tdb('stock').all().filter((s) => s.branchId === branchId && s.quantity !== 0);
    const byCategory = new Map();
    let totalCostValue = 0;
    let totalRetailValue = 0;
    let totalUnits = 0;
    for (const s of stockRows) {
      const p = tdb('products').get(s.productId);
      if (!p) continue;
      const sell = s.variantId ? p.variants.find((v) => v.id === s.variantId)?.sellingPrice || p.sellingPrice : p.sellingPrice;
      const costVal = money.mul(s.avgCost, s.quantity);
      const retailVal = money.mul(sell, s.quantity);
      totalCostValue += costVal;
      totalRetailValue += retailVal;
      totalUnits += s.quantity;
      const catName = p.categoryId ? tdb('categories').get(p.categoryId)?.name || 'Uncategorised' : 'Uncategorised';
      const acc = byCategory.get(catName) || { category: catName, units: 0, costValue: 0, retailValue: 0 };
      acc.units += s.quantity;
      acc.costValue += costVal;
      acc.retailValue += retailVal;
      byCategory.set(catName, acc);
    }
    return ok({
      branchId,
      summary: {
        totalUnits, totalCostValue, totalRetailValue,
        potentialProfit: totalRetailValue - totalCostValue,
        marginPct: totalRetailValue ? Number((((totalRetailValue - totalCostValue) / totalRetailValue) * 100).toFixed(1)) : 0,
      },
      byCategory: [...byCategory.values()].sort((a, b) => b.costValue - a.costValue),
    });
  });
}
