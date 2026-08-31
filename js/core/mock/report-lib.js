/**
 * report-lib.js - the SINGLE source of truth for every dashboard number and
 * every detailed report row. `/dashboard` and `/reports/:type` both call these
 * helpers, so "Dashboard Total Sales" always equals "Sales Report Total".
 *
 * Every function is pure over the tenant-scoped collections (tdb).
 */

import { tdb } from './scope.js';
import money from '../../utils/money.js';
import { isoDateKey } from '../../utils/date.js';

const t = (iso) => new Date(iso).getTime();
const inRange = (iso, from, to) => {
  const x = t(iso);
  return x >= from && x <= to;
};

/* ------------------------------------------------------------- selection */

export function selectSales({ from, to, branchId }) {
  const f = t(from);
  const g = t(to);
  return tdb('sales')
    .all()
    .filter((s) => (!branchId || s.branchId === branchId) && inRange(s.createdAt, f, g))
    .sort((a, b) => t(b.createdAt) - t(a.createdAt));
}

export function selectPayments({ from, to, branchId }) {
  const f = t(from);
  const g = t(to);
  return tdb('payments')
    .all()
    .filter((p) => (!branchId || p.branchId === branchId) && inRange(p.at, f, g));
}

export function selectReturns({ from, to, branchId }) {
  const f = t(from);
  const g = t(to);
  return tdb('sale_returns')
    .all()
    .filter((r) => (!branchId || r.branchId === branchId) && inRange(r.at, f, g))
    .sort((a, b) => t(b.at) - t(a.at));
}

export function selectExpenses({ from, to, branchId }) {
  const f = t(from);
  const g = t(to);
  return tdb('expenses')
    .all()
    .filter((e) => (!branchId || e.branchId === branchId) && inRange(e.at, f, g))
    .sort((a, b) => t(b.at) - t(a.at));
}

export function selectPurchases({ from, to, branchId }) {
  const f = t(from);
  const g = t(to);
  return tdb('purchases')
    .all()
    .filter((p) => (!branchId || p.branchId === branchId) && inRange(p.createdAt, f, g))
    .sort((a, b) => t(b.createdAt) - t(a.createdAt));
}

/* ------------------------------------------------------------- payments */

export const PAYMENT_LABELS = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  bkash: 'bKash',
  nagad: 'Nagad',
  rocket: 'Rocket',
  mobile: 'Mobile Banking',
  other: 'Other',
};

/** Normalise a payment record to a display method key (provider wins for mobile). */
export function paymentKey(p) {
  if (p.method === 'mobile') return (p.provider || 'mobile').toLowerCase();
  return p.method || 'other';
}

/**
 * Money received, grouped by payment method / provider, plus cash vs e-payment
 * split. Refunds (direction 'out') are tracked separately as `refund`.
 */
export function paymentBreakdown(payments) {
  const by = new Map();
  let cashIn = 0;
  let cashOut = 0;
  let eIn = 0;
  let eOut = 0;

  for (const p of payments) {
    const key = paymentKey(p);
    const acc = by.get(key) || { key, label: PAYMENT_LABELS[key] || key, inflow: 0, refund: 0, count: 0 };
    if (p.direction === 'out') {
      acc.refund += p.amount;
      if (key === 'cash') cashOut += p.amount;
      else eOut += p.amount;
    } else {
      acc.inflow += p.amount;
      acc.count += 1;
      if (key === 'cash') cashIn += p.amount;
      else eIn += p.amount;
    }
    by.set(key, acc);
  }

  const groups = [...by.values()]
    .map((g) => ({ ...g, net: g.inflow - g.refund }))
    .sort((a, b) => b.inflow - a.inflow);

  return {
    groups,
    cash: { inflow: cashIn, refund: cashOut, net: cashIn - cashOut },
    epayment: { inflow: eIn, refund: eOut, net: eIn - eOut },
    epaymentGroups: groups.filter((g) => g.key !== 'cash'),
    total: cashIn + eIn,
  };
}

/* ------------------------------------------------------------- KPI core */

/**
 * The canonical dashboard figures for a period. Every card reads from here.
 */
export function periodKpis({ from, to, branchId }) {
  const sales = selectSales({ from, to, branchId });
  const payments = selectPayments({ from, to, branchId });
  const returns = selectReturns({ from, to, branchId });
  const expenses = selectExpenses({ from, to, branchId });
  const purchases = selectPurchases({ from, to, branchId });
  const pay = paymentBreakdown(payments);

  let unitsSold = 0;
  const customerIds = new Set();
  for (const s of sales) {
    unitsSold += s.totalQty || 0;
    if (s.customerId) customerIds.add(s.customerId);
  }

  const totalSales = sales.reduce((a, s) => a + s.grandTotal, 0);
  const totalDiscount = sales.reduce((a, s) => a + s.discountTotal, 0);
  const couponDiscount = sales.reduce((a, s) => a + (s.couponDiscount || 0), 0);
  const autoDiscount = sales.reduce((a, s) => a + (s.autoDiscount || 0), 0);
  const taxCollected = sales.reduce((a, s) => a + (s.taxTotal || 0), 0);
  const grossProfit = sales.reduce((a, s) => a + s.estimatedProfit, 0);
  const returnsTotal = returns.reduce((a, r) => a + r.refundTotal, 0);
  const expensesTotal = expenses.reduce((a, e) => a + e.amount, 0);
  const purchaseTotal = purchases.reduce((a, p) => a + p.grandTotal, 0);

  // current-balance figures (not period-bound)
  const stock = tdb('stock').all().filter((s) => (!branchId || s.branchId === branchId) && s.quantity !== 0);
  let stockCost = 0;
  let stockRetail = 0;
  for (const s of stock) {
    const p = tdb('products').get(s.productId);
    if (!p) continue;
    const sell = s.variantId ? p.variants?.find((v) => v.id === s.variantId)?.sellingPrice ?? p.sellingPrice : p.sellingPrice;
    stockCost += money.mul(s.avgCost, s.quantity);
    stockRetail += money.mul(sell, s.quantity);
  }
  const receivable = tdb('sales').all().reduce((a, s) => a + (s.dueTotal || 0), 0);

  return {
    totalSales,
    invoiceCount: sales.length,
    cashPayments: pay.cash.inflow,
    cashNet: pay.cash.net,
    ePayments: pay.epayment.inflow,
    ePaymentGroups: pay.epaymentGroups,
    paymentGroups: pay.groups,
    customersServed: customerIds.size,
    unitsSold,
    totalDiscount,
    couponDiscount,
    autoDiscount,
    taxCollected,
    purchaseTotal,
    stockCost,
    stockRetail,
    potentialProfit: stockRetail - stockCost,
    grossProfit,
    netProfit: grossProfit - expensesTotal,
    returnsTotal,
    returnsCount: returns.length,
    exchangesCount: returns.filter((r) => r.type === 'exchange').length,
    exchangeAddon: returns.reduce((a, r) => a + (r.additionalPayment || 0), 0),
    returnedUnits: returns.reduce((a, r) => a + (r.items || []).reduce((x, i) => x + (i.qty || 0), 0), 0),
    exchangedUnits: returns.reduce((a, r) => a + (r.replacementItems || []).reduce((x, i) => x + (i.qty || 0), 0), 0),
    expensesTotal,
    receivable,
    avgOrderValue: sales.length ? Math.round(totalSales / sales.length) : 0,
  };
}

/* ------------------------------------------------------- detail rows */

export function saleRows(sales) {
  return sales.map((s) => ({
    id: s.id,
    invoiceNo: s.invoiceNo,
    date: s.createdAt,
    customer: s.customerName || 'Walk-in Customer',
    customerId: s.customerId || null,
    cashier: s.cashierName || '—',
    items: s.totalQty,
    subtotal: s.subtotal,
    discount: s.discountTotal,
    tax: s.taxTotal,
    total: s.grandTotal,
    paid: s.paidTotal,
    due: s.dueTotal,
    profit: s.estimatedProfit,
    payment: s.paymentSummary || '—',
    status: s.status,
  }));
}

export function paymentRows(payments) {
  const rows = payments
    .map((p) => {
      const sale = p.saleId ? tdb('sales').get(p.saleId) : null;
      const out = p.direction === 'out';
      return {
        id: p.id,
        saleId: p.saleId || null,
        txnRef: p.reference || p.id.slice(0, 8).toUpperCase(),
        invoiceNo: sale?.invoiceNo || '—',
        date: p.at,
        customer: sale?.customerName || 'Walk-in Customer',
        cashier: sale?.cashierName || '—',
        method: PAYMENT_LABELS[paymentKey(p)] || paymentKey(p),
        methodKey: paymentKey(p),
        direction: p.direction,
        received: out ? 0 : p.amount,
        refund: out ? p.amount : 0,
        amount: out ? -p.amount : p.amount,
        saleTotal: sale?.grandTotal || 0,
        change: !out && paymentKey(p) === 'cash' ? sale?.changeTotal || 0 : 0,
        status: p.saleReturnId ? 'refund' : 'received',
      };
    })
    .sort((a, b) => t(b.date) - t(a.date));
  return rows;
}

/** Totals for a payment detail report - received/refund/net kept separate. */
export function paymentTotals(rows) {
  const received = rows.reduce((s, r) => s + r.received, 0);
  const refund = rows.reduce((s, r) => s + r.refund, 0);
  return { received, refund, net: received - refund, count: rows.filter((r) => r.received > 0).length };
}

export function discountRows(sales) {
  const rows = [];
  for (const s of sales) {
    if (!s.discountTotal) continue;
    for (const it of tdb('sale_items').find({ saleId: s.id })) {
      if (!it.discountTotal) continue;
      rows.push({
        invoiceNo: s.invoiceNo,
        saleId: s.id,
        date: s.createdAt,
        customer: s.customerName || 'Walk-in Customer',
        cashier: s.cashierName || '—',
        product: it.name,
        type: it.lineDiscount && it.cartDiscountShare ? 'line + cart' : it.lineDiscount ? 'line' : 'cart',
        originalPrice: money.mul(it.unitPrice, it.qty),
        discount: it.discountTotal,
        finalPrice: it.lineTotal,
      });
    }
  }
  return rows.sort((a, b) => t(b.date) - t(a.date));
}

export function returnRows(returns) {
  const rows = [];
  for (const r of returns) {
    for (const it of r.items || []) {
      rows.push({
        returnRef: r.reference,
        type: r.type || 'return',
        saleId: r.saleId,
        invoiceNo: r.invoiceNo,
        date: r.at,
        customer: r.customerName || (r.customerId && tdb('customers').get(r.customerId)?.name) || 'Walk-in Customer',
        cashier: r.cashierName || '—',
        product: it.name || it.productId,
        qty: it.qty,
        amount: it.refund || 0,
        reason: r.reason,
        method: r.refundMethod || 'cash',
      });
    }
  }
  return rows.sort((a, b) => t(b.date) - t(a.date));
}

export function receivableRows() {
  const bySale = tdb('sales').all().filter((s) => (s.dueTotal || 0) > 0);
  return bySale
    .map((s) => ({
      saleId: s.id,
      invoiceNo: s.invoiceNo,
      date: s.createdAt,
      customer: s.customerName || 'Walk-in Customer',
      customerId: s.customerId || null,
      phone: s.customerPhone || (s.customerId && tdb('customers').get(s.customerId)?.phone) || '—',
      total: s.grandTotal,
      paid: s.paidTotal,
      due: s.dueTotal,
      status: s.status,
    }))
    .sort((a, b) => b.due - a.due);
}

export function customersServedRows(sales) {
  const map = new Map();
  for (const s of sales) {
    const key = s.customerId || 'walkin';
    const acc = map.get(key) || {
      customerId: s.customerId || null,
      name: s.customerName || 'Walk-in Customer',
      phone: s.customerPhone || (s.customerId && tdb('customers').get(s.customerId)?.phone) || '—',
      orders: 0,
      purchased: 0,
      paid: 0,
      discount: 0,
      lastPurchase: null,
    };
    acc.orders += 1;
    acc.purchased += s.grandTotal;
    acc.paid += s.paidTotal;
    acc.discount += s.discountTotal;
    if (!acc.lastPurchase || t(s.createdAt) > t(acc.lastPurchase)) acc.lastPurchase = s.createdAt;
    map.set(key, acc);
  }
  return [...map.values()]
    .map((c) => ({
      ...c,
      outstanding: c.customerId ? tdb('customers').get(c.customerId)?.outstandingBalance || 0 : 0,
    }))
    .sort((a, b) => b.purchased - a.purchased);
}

export function productsSoldRows(sales) {
  const map = new Map();
  for (const s of sales) {
    for (const it of tdb('sale_items').find({ saleId: s.id })) {
      const acc = map.get(it.productId) || {
        productId: it.productId,
        product: it.name,
        sku: it.sku,
        barcode: it.barcode,
        qtySold: 0,
        revenue: 0,
        discount: 0,
        cost: 0,
        profit: 0,
        transactions: 0,
      };
      acc.qtySold += it.qty;
      acc.revenue += it.lineTotal - it.taxAmount;
      acc.discount += it.discountTotal;
      acc.cost += money.mul(it.costPrice, it.qty);
      acc.profit = acc.revenue - acc.cost;
      acc.transactions += 1;
      map.set(it.productId, acc);
    }
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}

export function purchaseRows(purchases) {
  return purchases.map((p) => ({
    saleId: null,
    reference: p.reference,
    purchaseId: p.id,
    date: p.createdAt,
    supplier: tdb('suppliers').get(p.supplierId)?.name || '—',
    items: p.lines?.length || 0,
    subtotal: p.subtotal,
    tax: p.taxTotal,
    total: p.grandTotal,
    paid: p.paidTotal,
    due: p.dueTotal,
    status: p.status,
  }));
}

export function inventoryValuationRows(branchId) {
  const rows = [];
  for (const s of tdb('stock').all()) {
    if (branchId && s.branchId !== branchId) continue;
    if (s.quantity === 0) continue;
    const p = tdb('products').get(s.productId);
    if (!p || p.archivedAt) continue;
    const sell = s.variantId ? p.variants?.find((v) => v.id === s.variantId)?.sellingPrice ?? p.sellingPrice : p.sellingPrice;
    const stockValue = money.mul(s.avgCost, s.quantity);
    const retail = money.mul(sell, s.quantity);
    rows.push({
      productId: p.id,
      product: p.name + (s.variantId ? ` (${p.variants?.find((v) => v.id === s.variantId)?.name || ''})` : ''),
      sku: p.sku,
      quantity: s.quantity,
      avgCost: s.avgCost,
      sellingPrice: sell,
      stockValue,
      potentialSales: retail,
      potentialProfit: retail - stockValue,
    });
  }
  return rows.sort((a, b) => b.stockValue - a.stockValue);
}

/**
 * Dead-stock / slow-mover / ageing report. For every in-stock product (or
 * variant) it looks up the last sale and the trailing 30/90-day sale volume
 * from the immutable movement ledger. `days` is the idle threshold that marks a
 * line "dead"; a line that has sold since the threshold but not in the last 30
 * days is "slow".
 */
export function deadStockRows(branchId, days = 90) {
  const nowMs = Date.now();
  const cutoff = nowMs - days * 86400000;
  const win30 = nowMs - 30 * 86400000;
  const win90 = nowMs - 90 * 86400000;

  const sale = new Map(); // "prod:variant" -> { last, q30, q90 }
  for (const t of tdb('inventory_transactions').all()) {
    if (t.type !== 'sale') continue;
    if (branchId && t.branchId !== branchId) continue;
    const key = `${t.productId}:${t.variantId || 'base'}`;
    const at = new Date(t.at).getTime();
    const units = Math.abs(Number(t.qtyDelta) || 0);
    const acc = sale.get(key) || { last: 0, q30: 0, q90: 0 };
    if (at > acc.last) acc.last = at;
    if (at >= win30) acc.q30 += units;
    if (at >= win90) acc.q90 += units;
    sale.set(key, acc);
  }

  const rows = [];
  for (const s of tdb('stock').all()) {
    if (branchId && s.branchId !== branchId) continue;
    if (s.quantity <= 0) continue;
    const p = tdb('products').get(s.productId);
    if (!p || p.archivedAt || p.trackInventory === false) continue;
    const vName = s.variantId ? p.variants?.find((v) => v.id === s.variantId)?.name || '' : '';
    const key = `${s.productId}:${s.variantId || 'base'}`;
    const agg = sale.get(key);
    const lastMs = agg?.last || 0;
    const sinceMs = lastMs || new Date(s.lastMovementAt || p.createdAt || nowMs).getTime();
    const stockValue = money.mul(s.avgCost, s.quantity);
    const status = !lastMs || lastMs < cutoff ? 'dead' : (!agg.q30 ? 'slow' : 'ok');
    rows.push({
      productId: p.id,
      product: p.name + (vName ? ` (${vName})` : ''),
      sku: s.variantId ? p.variants?.find((v) => v.id === s.variantId)?.sku || p.sku : p.sku,
      category: p.categoryId ? tdb('categories').get(p.categoryId)?.name || '—' : '—',
      quantity: s.quantity,
      avgCost: s.avgCost,
      stockValue,
      lastSold: lastMs ? new Date(lastMs).toISOString() : null,
      daysIdle: Math.max(0, Math.floor((nowMs - sinceMs) / 86400000)),
      soldLast30: agg?.q30 || 0,
      soldLast90: agg?.q90 || 0,
      status,
    });
  }
  return rows.sort((a, b) => b.stockValue - a.stockValue);
}

export function expenseRows(expenses) {
  return expenses.map((e) => ({
    reference: e.reference,
    category: e.category,
    description: e.description,
    amount: e.amount,
    paymentMethod: e.paymentMethod,
    employee: e.employeeName || '—',
    date: e.at,
  }));
}

export function aggregate(rows, keys) {
  const out = {};
  for (const k of keys) out[k] = rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  out.count = rows.length;
  return out;
}

/* time-series for charts */
export function salesSeries(sales, granularity) {
  const map = new Map();
  for (const s of sales) {
    const key = granularity === 'month' ? isoDateKey(s.createdAt).slice(0, 7) : isoDateKey(s.createdAt);
    const acc = map.get(key) || { date: key, revenue: 0, profit: 0, orders: 0 };
    acc.revenue += s.grandTotal;
    acc.profit += s.estimatedProfit;
    acc.orders += 1;
    map.set(key, acc);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
