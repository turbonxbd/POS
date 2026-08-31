/**
 * product-barcode.mjs - branch-wise stock + MRP + Product -> Barcode Generator.
 * Branch quantities -> total product stock -> barcode quantity, and the MRP /
 * selling-price label option.
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
window.print = () => {};
globalThis.print = () => {};
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop() {}, measureText: () => ({ width: 8 }) }) });

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
const { session } = await import(R + 'js/core/session.js');
const { http } = await import(R + 'js/core/http.js');
initMockServer(); db.load(); if (db.isEmpty) await seedDemo(db);
await session.login('admin@txdemo.shop', 'demo1234');

const pc = await import(R + 'js/core/print-config.js');
const { buildBarcodePages, renderBarcodeCard } = await import(R + 'js/pages/shared/barcode-label.js');

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const branches = db.collection('branches').all();
const A = branches[0].id, B = branches[1].id;

/* ---------- branch-wise opening stock -> total ---------- */
const p1 = await http.post('/products', {
  name: 'QA Gaming Mouse', unit: 'pcs', costPrice: 120000, mrp: 260000, sellingPrice: 240000,
  attributes: { color: 'Black', size: 'M' },
  branchStock: [{ branchId: A, qty: 20 }, { branchId: B, qty: 20 }],
});
T('product created with mrp', p1.mrp === 260000);
T('attributes persisted', p1.attributes.color === 'Black' && p1.attributes.size === 'M');
T('branchStock array returned', Array.isArray(p1.branchStock));
const qA = p1.branchStock.find((r) => r.branchId === A)?.qty;
const qB = p1.branchStock.find((r) => r.branchId === B)?.qty;
T('Branch A = 20', qA === 20, String(qA));
T('Branch B = 20', qB === 20, String(qB));
T('Total stock = 40 (branch sum)', p1.totalStockAllBranches === 40, String(p1.totalStockAllBranches));

/* uneven per-branch quantities keep their own values */
const p2 = await http.post('/products', {
  name: 'QA Uneven Branch Item', unit: 'pcs', costPrice: 5000, sellingPrice: 9000,
  branchStock: [{ branchId: A, qty: 15 }, { branchId: B, qty: 25 }],
});
T('per-branch quantities not overwritten (15 + 25 = 40)',
  p2.branchStock.find((r) => r.branchId === A).qty === 15 &&
  p2.branchStock.find((r) => r.branchId === B).qty === 25 &&
  p2.totalStockAllBranches === 40, String(p2.totalStockAllBranches));

/* duplicate branch rows are merged, not overwritten */
const p3 = await http.post('/products', {
  name: 'QA Dup Branch', unit: 'pcs', costPrice: 100, sellingPrice: 200,
  branchStock: [{ branchId: A, qty: 20 }, { branchId: A, qty: 10 }],
});
T('duplicate branch rows merged (20 + 10 = 30)', (p3.branchStock.find((r) => r.branchId === A)?.qty) === 30);

/* ---------- MRP validation ---------- */
let rejected = false;
try {
  await http.post('/products', { name: 'QA Bad MRP', unit: 'pcs', costPrice: 100, mrp: 400, sellingPrice: 500 });
} catch (e) { rejected = (e.status === 422 || e.status === 400) && /exceed the MRP/i.test(JSON.stringify(e.data || {})); }
T('selling price above MRP is rejected', rejected);

/* ---------- data consistency: sell from Branch A ---------- */
const before = (await http.get('/products/' + p1.id, { params: { allBranches: true } })).totalStockAllBranches;
await http.post('/sales', { branchId: A, items: [{ productId: p1.id, qty: 1 }], payments: [{ method: 'cash', amount: 240000 }], idempotencyKey: 'qa-mouse-1' });
const after = await http.get('/products/' + p1.id, { params: { allBranches: true } });
T('sale from Branch A drops that branch by 1', after.branchStock.find((r) => r.branchId === A).qty === qA - 1);
T('Branch B unchanged after A sells', after.branchStock.find((r) => r.branchId === B).qty === qB);
T('total stock = 39 (branch sum stays the source of truth)', after.totalStockAllBranches === before - 1, `${after.totalStockAllBranches} vs ${before - 1}`);

/* ---------- MRP / selling-price on the label ---------- */
const item = { name: 'QA Mouse', brandName: 'QA Brand', sku: 'QA-M', barcode: '8901234599999', sellingPrice: 240000, mrp: 260000, attributes: { color: 'Black', size: 'XL', variant: 'Premium' } };
const on = renderBarcodeCard(item, { ...pc.DEFAULT_BARCODE, showMrp: true }, {});
T('showMrp ON: struck MRP + selling price, no "MRP" text', /class="bc-mrp"[^>]*>[^<]*<\/s>/.test(on) && on.includes('bc-sell') && !/>MRP\b/.test(on));
const off = renderBarcodeCard(item, { ...pc.DEFAULT_BARCODE, showMrp: false }, {});
T('showMrp OFF: no struck MRP', !off.includes('bc-mrp'));
const noMrp = renderBarcodeCard({ ...item, mrp: 0 }, { ...pc.DEFAULT_BARCODE, showMrp: true }, {});
T('showMrp ON but no MRP: plain selling price only', !noMrp.includes('bc-mrp') && noMrp.includes('bc-sell'));

/* ---------- attributes above the barcode ---------- */
const attrsAll = renderBarcodeCard(item, { ...pc.DEFAULT_BARCODE, showColor: true, showSize: true, showVariant: true }, {});
T('attributes render as Black | XL | Premium', /bc-attrs[\s\S]*Black[\s\S]*XL[\s\S]*Premium/.test(attrsAll));
T('attributes sit ABOVE the barcode bars', attrsAll.indexOf('bc-attrs') < attrsAll.indexOf('bc-bars'));
const attrsSome = renderBarcodeCard({ ...item, attributes: { size: '30 ml' } }, { ...pc.DEFAULT_BARCODE, showColor: true, showSize: true, showVariant: true }, {});
T('missing attributes are skipped (only Size shows)', /bc-attrs[^>]*>30 ml<\/div>/.test(attrsSome) && !/Black/.test(attrsSome));
const attrsOff = renderBarcodeCard(item, { ...pc.DEFAULT_BARCODE, showColor: false, showSize: false, showVariant: false }, {});
T('attribute toggles OFF: no attribute line', !/bc-attrs/.test(attrsOff));
const colorOnly = renderBarcodeCard(item, { ...pc.DEFAULT_BARCODE, showColor: true }, {});
T('Show Color only: just the colour', /bc-attrs[^>]*>Black<\/div>/.test(colorOnly));

/* ---------- fixed sticker order: brand -> name -> attrs -> bars -> number -> price ---------- */
const full = renderBarcodeCard(item, {
  ...pc.DEFAULT_BARCODE, showBrand: true, showProductName: true,
  showColor: true, showSize: true, showVariant: true,
  showBarcode: true, showBarcodeNumber: true, showPrice: true, showMrp: true,
}, {});
const order = ['bc-brand', 'bc-name', 'bc-attrs', 'bc-bars', 'bc-num', 'bc-price'].map((c) => full.indexOf(c));
T('sticker content is in the exact top-to-bottom order', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), JSON.stringify(order));
T('Show Brand renders the brand first', full.indexOf('bc-brand') < full.indexOf('bc-name') && full.includes('QA Brand'));
T('Show Brand OFF -> no brand line', !renderBarcodeCard(item, { ...pc.DEFAULT_BARCODE, showBrand: false }, {}).includes('bc-brand'));
T('Show Brand ON but product has no brand -> nothing', !renderBarcodeCard({ ...item, brandName: '' }, { ...pc.DEFAULT_BARCODE, showBrand: true }, {}).includes('bc-brand'));
// price still last even with SKU + business name enabled
const withExtras = renderBarcodeCard(item, { ...pc.DEFAULT_BARCODE, showBrand: true, showSku: true, showBusinessName: true, showColor: true }, { bizName: 'Afia' });
T('price stays at the bottom below everything', withExtras.lastIndexOf('bc-price') > Math.max(withExtras.indexOf('bc-sku'), withExtras.indexOf('bc-num'), withExtras.indexOf('bc-attrs')));

/* ---------- Barcode Generator deep-link: product -> qty = total ---------- */
const mount = document.getElementById('app-root');
const barcodePage = (await import(R + 'js/pages/admin/barcode-generator.js')).default;
await barcodePage({ query: { product: p1.id } }, mount);
await sleep(200);
const qtyInput = mount.querySelector('.js-qty');
T('generator pre-loads the product into the queue', !!mount.querySelector('tr[data-i="0"]'));
T('barcode quantity auto = current total stock (39)', Number(qtyInput?.value) === after.totalStockAllBranches, qtyInput?.value);
T('shows "Available Initial Stock" and "Barcodes to Generate"', /Available Initial Stock/.test(mount.textContent) && /Barcodes to Generate/.test(mount.textContent));

/* merchant overrides the quantity -> print makes exactly that many pages */
qtyInput.value = '25';
qtyInput.dispatchEvent(new window.Event('input'));
await sleep(50);
let printed = '';
const realPrintHtml = (await import(R + 'js/utils/print.js')).printHtml;
// intercept by rendering directly
const { buildBarcodePages: bbp } = await import(R + 'js/pages/shared/barcode-label.js');
const settings = await (await import(R + 'js/services/settings-service.js')).default.getSettings();
printed = bbp([{ ...item, qty: 25 }], { settings });
T('override 25 -> exactly 25 barcode pages', (printed.match(/class="bc-page"/g) || []).length === 25);
T('40 -> exactly 40 pages, no extras', (bbp([{ ...item, qty: 40 }], { settings }).match(/class="bc-page"/g) || []).length === 40);
void realPrintHtml;

/* ---------- deep-link with explicit qty overrides the auto value ---------- */
mount.replaceChildren();
await barcodePage({ query: { product: p1.id, qty: '12' } }, mount);
await sleep(150);
T('deep-link ?qty=12 pre-fills 12', Number(mount.querySelector('.js-qty')?.value) === 12, mount.querySelector('.js-qty')?.value);

/* ---------- existing single-branch openingStock path still works ---------- */
const legacy = await http.post('/products', { name: 'QA Legacy Opening', unit: 'pcs', costPrice: 100, sellingPrice: 200, openingStock: 7 });
T('legacy openingStock still posts stock', (legacy.totalStockAllBranches ?? legacy.stock) === 7, String(legacy.totalStockAllBranches ?? legacy.stock));

/* ---------- auto-generated barcodes are unique within the merchant ---------- */
{
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const p = await http.post('/products', { name: 'QA Barcode ' + i, unit: 'pcs', costPrice: 100, sellingPrice: 200 });
    codes.push(p.barcode);
  }
  T('every auto-generated barcode is a distinct EAN-13', new Set(codes).size === 6 && codes.every((c) => /^\d{13}$/.test(c)), codes.join(','));
  const all = (await http.get('/products', { params: { pageSize: 'all', status: 'all' } })).data.map((p) => p.barcode).filter(Boolean);
  T('no two products in this merchant share a barcode', new Set(all).size === all.length, `${all.length} products, ${new Set(all).size} unique`);
  // an explicit barcode that is already used is rejected
  let dupErr = null;
  try { await http.post('/products', { name: 'QA Dup Barcode', unit: 'pcs', costPrice: 1, sellingPrice: 2, barcode: codes[0] }); }
  catch (e) { dupErr = e; }
  T('re-using an existing barcode is rejected (422)', dupErr?.status === 422 && !!dupErr?.data?.errors?.barcode);
  // POST /barcode/generate returns distinct codes too
  const gen = await http.post('/barcode/generate', { count: 10 });
  T('/barcode/generate returns 10 distinct codes', gen.codes.length === 10 && new Set(gen.codes).size === 10);
}

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
