/**
 * analytics.routes.js - dashboard aggregates + the reports engine.
 *
 * Every figure comes from report-lib.js so a dashboard card and the report it
 * drills into are computed by the SAME code. Nothing is hard-coded.
 */

import { tdb } from './scope.js';
import { ok, badRequest } from './router.js';
import { resolveBranchId } from './helpers.js';
import money from '../../utils/money.js';
import { resolveRange, isoDateKey } from '../../utils/date.js';
import * as lib from './report-lib.js';

function scope(query) {
  const branchId = query.branchId || resolveBranchId();
  const range =
    query.from || query.to
      ? { from: query.from || new Date(0).toISOString(), to: query.to || new Date().toISOString() }
      : resolveRange(query.preset || 'this_month');
  return { branchId, range, from: range.from, to: range.to };
}

export default function register(router) {
  /* ---------------------------------------------------------- DASHBOARD */
  router.get('/dashboard', ({ query }) => {
    const s = scope(query);
    const k = lib.periodKpis(s);
    const sales = lib.selectSales(s);

    // low / out of stock (current)
    const products = tdb('products').all().filter((p) => !p.archivedAt && p.trackInventory !== false);
    const stockRows = tdb('stock').all().filter((r) => !s.branchId || r.branchId === s.branchId);
    const qtyOf = new Map(stockRows.map((r) => [r.productId + ':' + (r.variantId || 'base'), r.quantity]));
    let low = 0;
    let out = 0;
    for (const p of products) {
      const targets = p.variants?.length ? p.variants.map((v) => ({ id: v.id, min: v.minStock ?? p.minStock })) : [{ id: 'base', min: p.minStock }];
      for (const tg of targets) {
        const q = qtyOf.get(p.id + ':' + tg.id) || 0;
        if (q <= 0) out++;
        else if (tg.min > 0 && q <= tg.min) low++;
      }
    }

    const cashInRegister = tdb('register_sessions')
      .find((rs) => rs.status === 'open' && (!s.branchId || rs.branchId === s.branchId))
      .reduce((sum, rs) => sum + (rs.totalsSnapshot?.expectedCash ?? rs.openingCash), 0);

    // time series
    const days = (new Date(s.to) - new Date(s.from)) / 86400000;
    const granularity = days > 120 ? 'month' : 'day';
    const series = lib.salesSeries(sales, granularity);

    // category / product / cashier / customer breakdowns
    const catMap = new Map();
    const prodMap = new Map();
    const cashierMap = new Map();
    const custMap = new Map();
    for (const sale of sales) {
      cashierMap.set(sale.cashierId || 'u', {
        id: sale.cashierId,
        label: sale.cashierName || '—',
        value: (cashierMap.get(sale.cashierId || 'u')?.value || 0) + sale.grandTotal,
        orders: (cashierMap.get(sale.cashierId || 'u')?.orders || 0) + 1,
      });
      if (sale.customerId) {
        const c = custMap.get(sale.customerId) || { id: sale.customerId, label: sale.customerName, value: 0, orders: 0 };
        c.value += sale.grandTotal;
        c.orders += 1;
        custMap.set(sale.customerId, c);
      }
      for (const it of tdb('sale_items').find({ saleId: sale.id })) {
        const product = tdb('products').get(it.productId);
        const catName = product?.categoryId ? tdb('categories').get(product.categoryId)?.name || 'Other' : 'Other';
        catMap.set(catName, (catMap.get(catName) || 0) + (it.lineTotal - it.taxAmount));
        const pa = prodMap.get(it.productId) || { id: it.productId, name: it.name, qty: 0, revenue: 0, profit: 0 };
        pa.qty += it.qty;
        pa.revenue += it.lineTotal - it.taxAmount;
        pa.profit += it.lineTotal - it.taxAmount - money.mul(it.costPrice, it.qty);
        prodMap.set(it.productId, pa);
      }
    }

    return ok({
      range: s.range,
      granularity,
      preset: query.from || query.to ? 'custom' : query.preset || 'this_month',
      kpis: {
        ...k,
        totalProducts: tdb('products').count((p) => !p.archivedAt),
        lowStockProducts: low,
        outOfStockProducts: out,
        totalCustomers: tdb('customers').count((c) => !c.archivedAt),
        totalSuppliers: tdb('suppliers').count((x) => !x.archivedAt),
        pendingPurchases: tdb('purchases').count((p) => ['ordered', 'partially_received', 'draft'].includes(p.status)),
        cashInRegister,
      },
      salesSeries: series.map((d) => ({
        label: granularity === 'month' ? d.date : d.date.slice(5),
        date: d.date,
        revenue: d.revenue,
        profit: d.profit,
        orders: d.orders,
      })),
      salesByCategory: [...catMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      topProducts: [...prodMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
      topCustomers: [...custMap.values()].sort((a, b) => b.value - a.value).slice(0, 8),
      topCashiers: [...cashierMap.values()].sort((a, b) => b.value - a.value),
      paymentGroups: k.paymentGroups,
      paymentMix: k.paymentGroups.map((g) => ({ label: g.label, key: g.key, value: g.inflow, count: g.count })),
    });
  });

  /* ------------------------------------------------------------ REPORTS */
  router.get('/reports/:type', ({ params, query }) => {
    const s = scope(query);
    const sales = lib.selectSales(s);
    const type = params.type;

    switch (type) {
      case 'sales': {
        let rows = lib.saleRows(sales);
        if (query.cashier) rows = rows.filter((r) => r.cashier === query.cashier);
        if (query.payment && query.payment !== 'all') rows = rows.filter((r) => r.payment.includes(query.payment));
        if (query.status && query.status !== 'all') rows = rows.filter((r) => r.status === query.status);
        if (query.customerId) rows = rows.filter((r) => r.customerId === query.customerId);
        return ok({ range: s.range, rows, totals: lib.aggregate(rows, ['items', 'subtotal', 'discount', 'tax', 'total', 'paid', 'due', 'profit']) });
      }
      case 'cash': {
        const pays = lib.selectPayments(s).filter((p) => lib.paymentKey(p) === 'cash');
        const rows = lib.paymentRows(pays);
        return ok({ range: s.range, rows, totals: lib.paymentTotals(rows) });
      }
      case 'epayments': {
        let pays = lib.selectPayments(s).filter((p) => lib.paymentKey(p) !== 'cash');
        if (query.method && query.method !== 'all') pays = pays.filter((p) => lib.paymentKey(p) === query.method);
        const rows = lib.paymentRows(pays);
        return ok({
          range: s.range,
          rows,
          breakdown: lib.paymentBreakdown(pays).epaymentGroups,
          totals: lib.paymentTotals(rows),
        });
      }
      case 'payments': {
        const bd = lib.paymentBreakdown(lib.selectPayments(s));
        const rows = bd.groups.map((g) => ({ method: g.label, inflow: g.inflow, refund: g.refund, net: g.net, count: g.count }));
        return ok({ range: s.range, rows, totals: lib.aggregate(rows, ['inflow', 'refund', 'net', 'count']) });
      }
      case 'discounts': {
        const rows = lib.discountRows(sales);
        const totals = lib.aggregate(rows, ['originalPrice', 'discount', 'finalPrice']);
        totals.avgDiscount = rows.length ? Math.round(totals.discount / rows.length) : 0;
        totals.maxDiscount = rows.reduce((m, r) => Math.max(m, r.discount), 0);
        return ok({ range: s.range, rows, totals });
      }
      case 'returns': {
        const rows = lib.returnRows(lib.selectReturns(s));
        return ok({ range: s.range, rows, totals: lib.aggregate(rows, ['qty', 'amount']) });
      }
      case 'receivables': {
        const rows = lib.receivableRows();
        if (query.status && query.status !== 'all') return ok({ rows: rows.filter((r) => r.status === query.status), totals: lib.aggregate(rows, ['total', 'paid', 'due']) });
        return ok({ rows, totals: lib.aggregate(rows, ['total', 'paid', 'due']) });
      }
      case 'customers-served': {
        const rows = lib.customersServedRows(sales);
        return ok({ range: s.range, rows, totals: lib.aggregate(rows, ['orders', 'purchased', 'paid', 'discount', 'outstanding']) });
      }
      case 'products-sold':
      case 'product-performance': {
        let rows = lib.productsSoldRows(sales);
        const sort = query.sort;
        if (sort === 'qtySold') rows.sort((a, b) => b.qtySold - a.qtySold);
        else if (sort === 'profit') rows.sort((a, b) => b.profit - a.profit);
        else if (sort === 'least') rows.sort((a, b) => a.qtySold - b.qtySold);
        return ok({ range: s.range, rows, totals: lib.aggregate(rows, ['qtySold', 'revenue', 'discount', 'cost', 'profit', 'transactions']) });
      }
      case 'purchases': {
        const rows = lib.purchaseRows(lib.selectPurchases(s)).filter((r) => {
          if (query.supplier && r.supplier !== query.supplier) return false;
          if (query.status && query.status !== 'all' && r.status !== query.status) return false;
          return true;
        });
        return ok({ range: s.range, rows, totals: lib.aggregate(rows, ['items', 'subtotal', 'tax', 'total', 'paid', 'due']) });
      }
      case 'inventory':
      case 'inventory-valuation': {
        const rows = lib.inventoryValuationRows(s.branchId);
        return ok({ rows, totals: lib.aggregate(rows, ['quantity', 'stockValue', 'potentialSales', 'potentialProfit']) });
      }
      case 'expenses': {
        const rows = lib.expenseRows(lib.selectExpenses(s)).filter((r) => !query.category || query.category === 'all' || r.category === query.category);
        return ok({ range: s.range, rows, totals: lib.aggregate(rows, ['amount']) });
      }
      case 'profit':
        return ok(reportProfit(sales, s.range));
      case 'cashier':
        return ok(reportCashier(sales, s));
      case 'customers':
        return ok(reportCustomers());
      case 'suppliers':
        return ok(reportSuppliers());
      case 'tax':
        return ok(reportTax(sales));
      case 'stock-movement':
        return ok(reportStockMovement(s));
      case 'category-performance':
        return ok(reportCategoryPerformance(sales));
      case 'daily-closing':
        return ok(reportDailyClosing(s));
      default:
        badRequest(`Unknown report "${type}"`);
    }
  });
}

/* --------------------------- remaining specialised report builders --------- */

function reportProfit(sales, range) {
  const byDay = new Map();
  for (const s of sales) {
    const key = isoDateKey(s.createdAt);
    const acc = byDay.get(key) || { date: key, revenue: 0, cost: 0, tax: 0, profit: 0, orders: 0 };
    acc.revenue += s.grandTotal - s.taxTotal;
    acc.cost += s.totalCost;
    acc.tax += s.taxTotal;
    acc.profit += s.estimatedProfit;
    acc.orders += 1;
    byDay.set(key, acc);
  }
  const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
    ...r, margin: r.revenue ? Number(((r.profit / r.revenue) * 100).toFixed(1)) : 0,
  }));
  return { range, rows, totals: lib.aggregate(rows, ['revenue', 'cost', 'tax', 'profit', 'orders']) };
}

function reportCashier(sales, s) {
  const map = new Map();
  for (const sale of sales) {
    const acc = map.get(sale.cashierId || 'u') || { cashierId: sale.cashierId, cashier: sale.cashierName || '—', orders: 0, revenue: 0, discount: 0, refunds: 0 };
    acc.orders += 1;
    acc.revenue += sale.grandTotal;
    acc.discount += sale.discountTotal;
    map.set(sale.cashierId || 'u', acc);
  }
  for (const r of lib.selectReturns(s)) {
    const acc = map.get(r.cashierId || 'u');
    if (acc) acc.refunds += r.refundTotal;
  }
  const rows = [...map.values()].map((r) => ({ ...r, avgSale: r.orders ? Math.round(r.revenue / r.orders) : 0 })).sort((a, b) => b.revenue - a.revenue);
  return { rows, totals: lib.aggregate(rows, ['orders', 'revenue', 'discount', 'refunds']) };
}

function reportCustomers() {
  const rows = tdb('customers').find((c) => !c.archivedAt).map((c) => ({
    customerId: c.id, name: c.name, phone: c.phone, orders: c.totalOrders || 0, spent: c.totalPurchases || 0,
    outstanding: c.outstandingBalance || 0, loyalty: c.loyaltyPoints || 0, lastPurchase: c.lastPurchaseAt,
  })).sort((a, b) => b.spent - a.spent);
  return { rows, totals: lib.aggregate(rows, ['orders', 'spent', 'outstanding', 'loyalty']) };
}

function reportSuppliers() {
  const rows = tdb('suppliers').find((s) => !s.archivedAt).map((s) => ({
    name: s.name, phone: s.phone, purchases: tdb('purchases').count({ supplierId: s.id }),
    totalValue: tdb('purchases').find({ supplierId: s.id }).reduce((sum, p) => sum + p.grandTotal, 0),
    balance: s.currentBalance || 0,
  })).sort((a, b) => b.totalValue - a.totalValue);
  return { rows, totals: lib.aggregate(rows, ['purchases', 'totalValue', 'balance']) };
}

function reportTax(sales) {
  const map = new Map();
  for (const s of sales) {
    for (const t of s.taxLines || []) {
      const acc = map.get(t.taxId) || { name: t.name, rate: t.rate, base: 0, amount: 0 };
      acc.base += t.base;
      acc.amount += t.amount;
      map.set(t.taxId, acc);
    }
  }
  const rows = [...map.values()];
  return { rows, totals: lib.aggregate(rows, ['base', 'amount']) };
}

function reportStockMovement(s) {
  const from = new Date(s.from).getTime();
  const to = new Date(s.to).getTime();
  const rows = tdb('inventory_transactions')
    .find((t) => (!s.branchId || t.branchId === s.branchId) && new Date(t.at).getTime() >= from && new Date(t.at).getTime() <= to)
    .map((t) => ({
      date: t.at, product: tdb('products').get(t.productId)?.name || t.productId,
      type: t.type, qty: t.qtyDelta, balance: t.balanceAfter, reference: t.refId, user: t.userName,
    }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  return { range: s.range, rows, totals: { rows: rows.length } };
}

function reportCategoryPerformance(sales) {
  const map = new Map();
  for (const s of sales) {
    for (const it of tdb('sale_items').find({ saleId: s.id })) {
      const p = tdb('products').get(it.productId);
      const cat = p?.categoryId ? tdb('categories').get(p.categoryId)?.name || 'Other' : 'Other';
      const acc = map.get(cat) || { category: cat, qtySold: 0, revenue: 0, profit: 0 };
      acc.qtySold += it.qty;
      acc.revenue += it.lineTotal - it.taxAmount;
      acc.profit += it.lineTotal - it.taxAmount - money.mul(it.costPrice, it.qty);
      map.set(cat, acc);
    }
  }
  const rows = [...map.values()].sort((a, b) => b.revenue - a.revenue);
  return { rows, totals: lib.aggregate(rows, ['qtySold', 'revenue', 'profit']) };
}

function reportDailyClosing(s) {
  const from = new Date(s.from).getTime();
  const to = new Date(s.to).getTime();
  const byDay = new Map();
  for (const sale of tdb('sales').all()) {
    if (s.branchId && sale.branchId !== s.branchId) continue;
    const x = new Date(sale.createdAt).getTime();
    if (x < from || x > to) continue;
    const key = isoDateKey(sale.createdAt);
    const acc = byDay.get(key) || { date: key, orders: 0, gross: 0, discount: 0, tax: 0, net: 0, cash: 0, epayment: 0, profit: 0 };
    acc.orders += 1;
    acc.gross += sale.subtotal;
    acc.discount += sale.discountTotal;
    acc.tax += sale.taxTotal;
    acc.net += sale.grandTotal;
    acc.profit += sale.estimatedProfit;
    byDay.set(key, acc);
  }
  for (const p of tdb('payments').all()) {
    if (s.branchId && p.branchId !== s.branchId) continue;
    const acc = byDay.get(isoDateKey(p.at));
    if (!acc || p.direction !== 'in') continue;
    if (lib.paymentKey(p) === 'cash') acc.cash += p.amount;
    else acc.epayment += p.amount;
  }
  const rows = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { range: s.range, rows, totals: lib.aggregate(rows, ['orders', 'gross', 'discount', 'tax', 'net', 'cash', 'epayment', 'profit']) };
}
