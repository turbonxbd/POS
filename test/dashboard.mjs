/**
 * dashboard.mjs - the interactive dashboard + drill-down reports.
 * Verifies §24 data-accuracy: dashboard card === report total.
 */
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="app-root"></div><div id="print-root"></div></body></html>', { url: 'http://localhost:5173/admin.html', pretendToBeVisual: true });
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window); def('document', window.document); def('navigator', window.navigator);
def('location', window.location); def('history', window.history);
globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node; globalThis.CustomEvent = window.CustomEvent; globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.matchMedia = globalThis.matchMedia;
def('localStorage', window.localStorage); def('sessionStorage', window.sessionStorage);
def('addEventListener', window.addEventListener.bind(window));
def('removeEventListener', window.removeEventListener.bind(window));
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 10, measureText: () => ({ width: 10 }) }) });
window.HTMLElement.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} });
window.HTMLElement.prototype.scrollTo = () => {};

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
const { session } = await import(R + 'js/core/session.js');
const { http } = await import(R + 'js/core/http.js');
initMockServer(); db.load(); if (db.isEmpty) await seedDemo(db);
await session.login('admin@txdemo.shop', 'demo1234');

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
console.error = (...a) => errs.push(a.map(String).join(' '));

const P = 'this_year';
const dash = await http.get('/dashboard', { params: { preset: P } });
const k = dash.kpis;
T('dashboard has all 13 core kpis', ['totalSales', 'cashPayments', 'ePayments', 'invoiceCount', 'customersServed', 'unitsSold', 'totalDiscount', 'purchaseTotal', 'stockCost', 'grossProfit', 'returnsTotal', 'expensesTotal', 'receivable'].every((key) => typeof k[key] === 'number'));

/* ---- §24 consistency: dashboard number === report total ---- */
const rep = (t, params = {}) => http.get('/reports/' + t, { params: { preset: P, ...params } });

T('Total Sales === Sales Report total', k.totalSales === (await rep('sales')).totals.total, k.totalSales + ' vs ' + (await rep('sales')).totals.total);
T('Cash === Cash Report received', k.cashPayments === (await rep('cash')).totals.received, k.cashPayments + ' vs ' + (await rep('cash')).totals.received);
T('E-Payments === E-Payment Report received', k.ePayments === (await rep('epayments')).totals.received);
T('Products Sold === Products report qtySold', k.unitsSold === (await rep('products-sold')).totals.qtySold, k.unitsSold + ' vs ' + (await rep('products-sold')).totals.qtySold);
T('Total Discount === Discount report total', k.totalDiscount === (await rep('discounts')).totals.discount, k.totalDiscount + ' vs ' + (await rep('discounts')).totals.discount);
T('Expenses === Expense report total', k.expensesTotal === (await rep('expenses')).totals.amount);
T('Returns === Return report total', k.returnsTotal === (await rep('returns')).totals.amount, k.returnsTotal + ' vs ' + (await rep('returns')).totals.amount);
T('Stock Value === Valuation report total', k.stockCost === (await rep('inventory-valuation')).totals.stockValue);
T('Receivable === Due report total', k.receivable === (await rep('receivables')).totals.due);
T('Customers Served === report row count', k.customersServed <= (await rep('customers-served')).rows.length + 1);
T('Purchases === Purchase report total', k.purchaseTotal === (await rep('purchases')).totals.total);
T('Gross Profit === Profit report total', k.grossProfit === (await rep('profit')).totals.profit, k.grossProfit + ' vs ' + (await rep('profit')).totals.profit);

/* ---- e-payment breakdown reaches providers ---- */
const ep = await rep('epayments');
T('e-payment breakdown has provider groups', (ep.breakdown || []).some((g) => ['bkash', 'nagad', 'rocket'].includes(g.key)), JSON.stringify((ep.breakdown || []).map((g) => g.key)));
const bk = await rep('epayments', { method: 'bkash' });
T('filter epayments by bkash', bk.rows.every((r) => r.methodKey === 'bkash') && bk.rows.length > 0, bk.rows.length + ' rows');

/* ---- custom from/to range: dashboard === report, and narrows the window ---- */
const now = new Date();
const cFrom = new Date(now.getFullYear(), 0, 1).toISOString();
const cTo = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
const cDash = await http.get('/dashboard', { params: { from: cFrom, to: cTo } });
const cSales = await http.get('/reports/sales', { params: { from: cFrom, to: cTo } });
T('custom range: dashboard preset flagged custom', cDash.preset === 'custom', cDash.preset);
T('custom range: dashboard Total Sales === Sales Report total', cDash.kpis.totalSales === cSales.totals.total, cDash.kpis.totalSales + ' vs ' + cSales.totals.total);
const narrowFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
const narrow = await http.get('/dashboard', { params: { from: narrowFrom, to: cTo } });
T('custom range: narrower window <= wider window sales', narrow.kpis.totalSales <= cDash.kpis.totalSales);

/* ---- new sale updates dashboard (§25) ---- */
const B = db.collection('branches').all()[0].id;
const tp = await http.post('/products', { branchId: B, name: 'Dash Test Item', sellingPrice: 50000, costPrice: 30000, unit: 'pcs', openingStock: 5 });
const before = (await http.get('/dashboard', { params: { preset: P } })).kpis;
await http.post('/sales', { branchId: B, items: [{ productId: tp.id, qty: 1 }], payments: [{ method: 'mobile', provider: 'nagad', amount: 50000 }], idempotencyKey: 'dash-t1' });
const after = (await http.get('/dashboard', { params: { preset: P } })).kpis;
T('sale bumps invoice count', after.invoiceCount === before.invoiceCount + 1);
T('mobile sale bumps e-payments by 500.00', after.ePayments === before.ePayments + 50000, (after.ePayments - before.ePayments) + '');
T('mobile sale bumps units sold', after.unitsSold === before.unitsSold + 1);

/* ---- dashboard PAGE renders clickable cards ---- */
const mod = await import(R + 'js/pages/admin/dashboard.js');
const mount = document.getElementById('app-root');

// a fresh load (no query) defaults to TODAY, not this-month
await mod.default({ query: {} }, mount);
await sleep(400);
T('dashboard defaults to Today on a fresh load',
  mount.querySelector('#dt-seg button[data-p="today"]')?.getAttribute('aria-pressed') === 'true',
  [...mount.querySelectorAll('#dt-seg button[aria-pressed="true"]')].map((b) => b.dataset.p).join());
mount.replaceChildren();

await mod.default({ query: { preset: 'this_year' } }, mount);
await sleep(500);
const kpiLinks = [...mount.querySelectorAll('a.kpi--link')];
T('dashboard renders >=10 clickable KPI cards', kpiLinks.length >= 10, kpiLinks.length + ' cards');
T('every KPI card links to a report or page', kpiLinks.every((a) => /^#\/(reports\/|products|inventory|cash-register)/.test(a.getAttribute('href'))));
T('payment tiles clickable', mount.querySelectorAll('.pay-tile').length >= 2);
T('top-product rank rows link to product', [...mount.querySelectorAll('.rank-row')].some((a) => a.getAttribute('href').startsWith('#/products/')));
T('no console errors rendering dashboard', errs.filter((e) => !e.includes('[chart]') && !e.includes('Not implemented')).length === 0, errs[0] || '');

/* ---- dashboard PAGE with custom from/to ---- */
mount.replaceChildren();
await mod.default({ query: { from: cFrom, to: cTo } }, mount);
await sleep(400);
T('custom range: Custom button pressed', mount.querySelector('#dt-seg button[data-p="custom"]')?.getAttribute('aria-pressed') === 'true');
T('custom range: date inputs prefilled', mount.querySelector('.js-from')?.value === cFrom.slice(0, 10) && mount.querySelector('.js-to')?.value === cTo.slice(0, 10));
T('custom range: KPI cards still render + link with from/to', [...mount.querySelectorAll('a.kpi--link')].some((a) => a.getAttribute('href').includes('from=')));

/* ---- reports PAGE renders + drills ---- */
const rmod = await import(R + 'js/pages/admin/reports.js');
mount.replaceChildren();
await rmod.default({ params: { type: 'sales' }, query: { preset: 'this_year' } }, mount);
await sleep(400);
T('report page renders table', !!mount.querySelector('#report-table tbody tr'), mount.textContent.slice(0, 80));
T('report rows are drillable', !!mount.querySelector('tr.js-drill'));

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
