/**
 * exchange-return.mjs - Cashier Exchange / Return.
 * Scan invoice -> select product/qty -> Return (refund) or Exchange (swap +
 * price difference) -> inventory + financial record + admin dashboard update.
 */
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="pos-root"></div><div id="print-root"></div></body></html>', { url: 'http://localhost:5173/cashier.html', pretendToBeVisual: true });
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window); def('document', window.document); def('navigator', window.navigator);
def('location', window.location); def('history', window.history);
globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node; globalThis.CustomEvent = window.CustomEvent; globalThis.Event = window.Event; globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.matchMedia = globalThis.matchMedia;
def('localStorage', window.localStorage); def('sessionStorage', window.sessionStorage);
def('addEventListener', window.addEventListener.bind(window));
def('removeEventListener', window.removeEventListener.bind(window));
window.print = () => {};
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop() {}, measureText: () => ({ width: 8 }) }) });

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
const { session } = await import(R + 'js/core/session.js');
const { http } = await import(R + 'js/core/http.js');
initMockServer(); db.load(); if (db.isEmpty) await seedDemo(db);
await session.login('admin@txdemo.shop', 'demo1234');

const { getStockQty } = await import(R + 'js/core/mock/helpers.js');

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const branches = db.collection('branches').all();
const A = branches[0].id, B = branches[1].id;

/* fixtures: two products with known price + stock in branch A */
const pA = await http.post('/products', { name: 'XR Product A', unit: 'pcs', costPrice: 20000, sellingPrice: 50000, branchStock: [{ branchId: A, qty: 10 }] });
const pB = await http.post('/products', { name: 'XR Product B', unit: 'pcs', costPrice: 25000, sellingPrice: 60000, branchStock: [{ branchId: A, qty: 5 }] });
const pC = await http.post('/products', { name: 'XR Product C cheap', unit: 'pcs', costPrice: 10000, sellingPrice: 30000, branchStock: [{ branchId: A, qty: 5 }] });
const pZero = await http.post('/products', { name: 'XR Zero Stock', unit: 'pcs', costPrice: 10000, sellingPrice: 40000, branchStock: [{ branchId: A, qty: 0 }] });

/* an original sale in branch A: 2 A + 1 B */
const sale = await http.post('/sales', {
  branchId: A,
  items: [{ productId: pA.id, qty: 2 }, { productId: pB.id, qty: 1 }],
  payments: [{ method: 'cash', amount: 160000 }],
  idempotencyKey: 'xr-sale-1',
});
T('fixture sale created', sale.grandTotal === 160000, String(sale.grandTotal));

/* scan-by-invoice lookup works */
const looked = await http.get('/sales/lookup', { params: { invoice: sale.invoiceNo } });
T('lookup by invoice number returns the sale', looked.id === sale.id);
let notFound = false;
try { await http.get('/sales/lookup', { params: { invoice: 'AFIA-NOPE-99999' } }); } catch (e) { notFound = e.status === 404; }
T('unknown invoice -> 404', notFound);

const full = await http.get('/sales/' + sale.id);
const itA = full.items.find((i) => i.productId === pA.id);
const itB = full.items.find((i) => i.productId === pB.id);

/* ---------- PARTIAL RETURN: 1 of the 2 A units ---------- */
const stockAbefore = getStockQty(A, pA.id, null);
const ret1 = await http.post('/sales/' + sale.id + '/returns', {
  type: 'return', reason: 'customer_request', refundMethod: 'cash',
  lines: [{ saleItemId: itA.id, qty: 1 }],
});
T('return record type = return', ret1.type === 'return');
T('partial return: refund = 1 unit value (500.00)', ret1.refundTotal === 50000, String(ret1.refundTotal));
T('returned stock goes back to branch A (+1)', getStockQty(A, pA.id, null) === stockAbefore + 1);
T('branch B stock untouched by an A return', getStockQty(B, pA.id, null) === 0);
const afterRet = await http.get('/sales/' + sale.id);
T('sale marked partially_refunded, not fully', afterRet.status === 'partially_refunded');
T('remaining eligible for A is now 1', afterRet.items.find((i) => i.productId === pA.id).qty - (afterRet.items.find((i) => i.productId === pA.id).returnedQty) === 1);

/* ---------- PREVENT OVER-RETURN ---------- */
let over = false;
try {
  await http.post('/sales/' + sale.id + '/returns', { type: 'return', lines: [{ saleItemId: itA.id, qty: 5 }] });
} catch (e) { over = e.status === 409 && /remain returnable/i.test(JSON.stringify(e.data)); }
T('cannot return more than the remaining eligible qty (409)', over);

/* ---------- EXCHANGE: return remaining A (৳500) -> B (৳600), customer pays ৳100 ---------- */
const stockBbefore = getStockQty(A, pB.id, null);
const stockAbefore2 = getStockQty(A, pA.id, null);
const ex1 = await http.post('/sales/' + sale.id + '/returns', {
  type: 'exchange', reason: 'wrong_item', refundMethod: 'cash',
  lines: [{ saleItemId: itA.id, qty: 1 }],
  replacementItems: [{ productId: pB.id, qty: 1 }],
});
T('exchange record type = exchange', ex1.type === 'exchange');
T('exchange returned value = 500.00', ex1.returnRefund === 50000, String(ex1.returnRefund));
T('exchange replacement value = 600.00', ex1.replacementTotal === 60000, String(ex1.replacementTotal));
T('difference = +100.00 (customer pays)', ex1.difference === 10000 && ex1.additionalPayment === 10000 && ex1.refundTotal === 0);
T('exchange restocks returned A (+1)', getStockQty(A, pA.id, null) === stockAbefore2 + 1);
T('exchange deducts replacement B (-1)', getStockQty(A, pB.id, null) === stockBbefore - 1);
const exPay = db.collection('payments').all().filter((p) => p.saleReturnId === ex1.id);
T('exchange top-up recorded as a payment IN', exPay.some((p) => p.direction === 'in' && p.amount === ex1.additionalPayment && ex1.additionalPayment > 0), JSON.stringify({ addon: ex1.additionalPayment, pays: exPay.map((p) => [p.direction, p.amount]) }));

/* ---------- EXCHANGE cheaper: B (৳600) -> C (৳300), refund ৳300 ---------- */
const sale2 = await http.post('/sales', { branchId: A, items: [{ productId: pB.id, qty: 1 }], payments: [{ method: 'cash', amount: 60000 }], idempotencyKey: 'xr-sale-2' });
const s2 = await http.get('/sales/' + sale2.id);
const ex2 = await http.post('/sales/' + sale2.id + '/returns', {
  type: 'exchange', refundMethod: 'bkash',
  lines: [{ saleItemId: s2.items[0].id, qty: 1 }],
  replacementItems: [{ productId: pC.id, qty: 1 }],
});
T('cheaper exchange -> refund the difference', ex2.difference === -30000 && ex2.refundTotal === 30000 && ex2.additionalPayment === 0);
T('cheaper exchange refund uses the chosen method', ex2.refundMethod === 'bkash');

/* ---------- INSUFFICIENT REPLACEMENT STOCK ---------- */
const sale3 = await http.post('/sales', { branchId: A, items: [{ productId: pC.id, qty: 1 }], payments: [{ method: 'cash', amount: 30000 }], idempotencyKey: 'xr-sale-3' });
const s3 = await http.get('/sales/' + sale3.id);
let insufficient = false;
try {
  await http.post('/sales/' + sale3.id + '/returns', {
    type: 'exchange', lines: [{ saleItemId: s3.items[0].id, qty: 1 }],
    replacementItems: [{ productId: pZero.id, qty: 3 }],
  });
} catch (e) { insufficient = e.status === 409 && /Insufficient stock/i.test(JSON.stringify(e.data)); }
T('insufficient replacement stock is blocked (409)', insufficient);
T('nothing happened: sale3 still completed, not refunded', (await http.get('/sales/' + sale3.id)).status === 'completed');

/* ---------- ADMIN: list + dashboard ---------- */
const list = await http.get('/sale-returns', { params: { pageSize: 'all' } });
T('exchange & return both appear in /sale-returns', list.data.some((r) => r.type === 'exchange') && list.data.some((r) => r.type === 'return'));

const dash = await http.get('/dashboard', { params: { preset: 'this_year' } });
T('dashboard exposes exchangesCount', dash.kpis.exchangesCount >= 2, String(dash.kpis.exchangesCount));
T('dashboard exposes exchangeAddon (extra collected)', dash.kpis.exchangeAddon >= 10000, String(dash.kpis.exchangeAddon));
T('dashboard returnsCount includes every return doc', dash.kpis.returnsCount >= 4);

const repRet = await http.get('/reports/returns', { params: { preset: 'this_year' } });
T('returns report rows carry a type', repRet.rows.every((r) => r.type === 'return' || r.type === 'exchange'));

/* ---------- receipt builds ---------- */
const { buildReturnReceipt } = await import(R + 'js/pages/shared/return-receipt.js');
const settings = await (await import(R + 'js/services/settings-service.js')).default.getSettings();
const rcpt = buildReturnReceipt(ex1, { sale: full, settings });
T('exchange receipt: title + replacement + difference', /EXCHANGE RECEIPT/.test(rcpt) && /Replacement Products/.test(rcpt) && /CUSTOMER PAID/.test(rcpt));
const rcpt2 = buildReturnReceipt(ret1, { sale: full, settings });
T('return receipt: title + refund', /RETURN RECEIPT/.test(rcpt2) && /REFUND/.test(rcpt2));

/* ---------- cashier UI opens the scan step ---------- */
const { openExchangeReturn } = await import(R + 'js/pages/cashier/exchange-return.js');
openExchangeReturn();
await sleep(60);
T('cashier Exchange/Return modal shows the scan-invoice input', !!document.querySelector('.js-inv'));
T('modal title is Exchange / Return', /Exchange \/ Return/.test(document.body.textContent));

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
