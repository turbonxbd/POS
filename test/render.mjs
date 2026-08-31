import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="app-root"></div><div id="pos-root"></div></body></html>', {
  url: 'http://localhost:5173/admin.html',
  pretendToBeVisual: true,
});
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window);
def('document', window.document);
def('navigator', window.navigator);
def('location', window.location);
def('history', window.history);
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Image = window.Image;
globalThis.CustomEvent = window.CustomEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }));
window.matchMedia = globalThis.matchMedia;
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch {}
def('localStorage', window.localStorage);
def('addEventListener', window.addEventListener.bind(window));
def('removeEventListener', window.removeEventListener.bind(window));
globalThis.print = () => {};
window.print = () => {};
// canvas 2d context stub
window.HTMLCanvasElement.prototype.getContext = () => ({
  setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
  arc() {}, arcTo() {}, closePath() {}, fillText() {}, measureText: () => ({ width: 10 }), createLinearGradient: () => ({ addColorStop() {} }),
  save() {}, restore() {}, fillRect() {}, rect() {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
  set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}, set globalAlpha(v) {}, set lineJoin(v) {}, setLineDash() {},
});
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
const { session } = await import(R + 'js/core/session.js');
const { boot } = await import(R + 'js/core/boot.js');

initMockServer();
await boot();
db.load();
if (db.isEmpty) await seedDemo(db);

let pass = 0, fail = 0;
const errs = [];
window.addEventListener('error', (e) => errs.push('window error: ' + e.message));
const origErr = console.error;
console.error = (...a) => { errs.push('console.error: ' + a.map(String).join(' ')); };
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : '')); };

await session.login('admin@txdemo.shop', 'demo1234');
T('login', session.isAuthenticated());

const mount = document.getElementById('app-root');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = [
  ['dashboard', 'js/pages/admin/dashboard.js', { params: {}, query: {} }],
  ['products', 'js/pages/admin/products.js', { params: {}, query: {} }],
  ['product-form(new)', 'js/pages/admin/product-form.js', { params: {}, query: {} }],
  ['categories', 'js/pages/admin/categories.js', { params: {}, query: {} }],
  ['brands', 'js/pages/admin/brands.js', { params: {}, query: {} }],
  ['inventory', 'js/pages/admin/inventory.js', { params: {}, query: {} }],
  ['stock-adjustments', 'js/pages/admin/stock-adjustments.js', { params: {}, query: {} }],
  ['purchases', 'js/pages/admin/purchases.js', { params: {}, query: {} }],
  ['purchase-form', 'js/pages/admin/purchase-form.js', { params: {}, query: {} }],
  ['suppliers', 'js/pages/admin/suppliers.js', { params: {}, query: {} }],
  ['sales', 'js/pages/admin/sales.js', { params: {}, query: {} }],
  ['sales-returns', 'js/pages/admin/sales-returns.js', { params: {}, query: {} }],
  ['invoices', 'js/pages/admin/invoices.js', { params: {}, query: {} }],
  ['customers', 'js/pages/admin/customers.js', { params: {}, query: {} }],
  ['employees', 'js/pages/admin/employees.js', { params: {}, query: {} }],
  ['expenses', 'js/pages/admin/expenses.js', { params: {}, query: {} }],
  ['cash-register', 'js/pages/admin/cash-register.js', { params: {}, query: {} }],
  ['discounts', 'js/pages/admin/discounts.js', { params: {}, query: {} }],
  ['taxes', 'js/pages/admin/taxes.js', { params: {}, query: {} }],
  ['reports', 'js/pages/admin/reports.js', { params: {}, query: {} }],
  ['audit-logs', 'js/pages/admin/audit-logs.js', { params: {}, query: {} }],
  ['notifications', 'js/pages/admin/notifications.js', { params: {}, query: {} }],
  ['branches', 'js/pages/admin/branches.js', { params: {}, query: {} }],
  ['settings', 'js/pages/admin/settings.js', { params: {}, query: {} }],
  ['backup', 'js/pages/admin/backup.js', { params: {}, query: {} }],
  ['help', 'js/pages/admin/help.js', { params: {}, query: {} }],
  ['barcode-generator', 'js/pages/admin/barcode-generator.js', { params: {}, query: {} }],
];

for (const [name, path, ctx] of pages) {
  errs.length = 0;
  mount.replaceChildren();
  try {
    const mod = await import(R + path);
    await mod.default(ctx, mount);
    await sleep(60);
    const rendered = mount.querySelector('.page, .settings-layout, .form-layout, table, .kpi-grid, .empty-state, .loading-block');
    const pageErrs = errs.filter((e) => !e.includes('[chart]') && !e.includes('Not implemented'));
    T(name, !!rendered && pageErrs.length === 0, pageErrs[0] || (rendered ? '' : 'nothing rendered'));
  } catch (e) {
    T(name, false, 'THREW: ' + e.message);
  }
}

// detail pages with real ids
const aSale = db.collection('sales').all()[0];
const aProd = db.collection('products').all()[0];
const aPurchase = db.collection('purchases').all()[0];
for (const [name, path, ctx] of [
  ['product-detail', 'js/pages/admin/product-detail.js', { params: { id: aProd.id }, query: {} }],
  ['sale-detail', 'js/pages/admin/sale-detail.js', { params: { id: aSale.id }, query: {} }],
  ['purchase-detail', 'js/pages/admin/purchase-detail.js', { params: { id: aPurchase.id }, query: {} }],
]) {
  errs.length = 0;
  mount.replaceChildren();
  try {
    const mod = await import(R + path);
    await mod.default(ctx, mount);
    await sleep(60);
    const pageErrs = errs.filter((e) => !e.includes('[chart]'));
    T(name, !!mount.querySelector('.page') && pageErrs.length === 0, pageErrs[0] || '');
  } catch (e) { T(name, false, 'THREW: ' + e.message); }
}

// product-detail: the "Add Stock" flow adds to a branch's on-hand quantity
{
  errs.length = 0;
  mount.replaceChildren();
  const { db } = await import(R + 'js/core/db.js');
  const prod = db.collection('products').all().find((p) => p.trackInventory !== false && !p.archivedAt && !(p.variants || []).length) || aProd;
  const before = db.collection('stock').all().reduce((s, r) => s + (r.productId === prod.id ? r.quantity : 0), 0);
  const mod = await import(R + 'js/pages/admin/product-detail.js');
  await mod.default({ params: { id: prod.id }, query: {} }, mount);
  await sleep(80);
  const addBtn = [...mount.querySelectorAll('button, a')].find((b) => /add stock/i.test(b.textContent));
  T('product-detail: an "Add Stock" action is shown', !!addBtn, mount.querySelector('#page-actions')?.textContent);
  if (addBtn) {
    addBtn.click();
    await sleep(60);
    const modal = document.querySelector('.overlay .modal, .modal');
    const qtyInputs = [...modal.querySelectorAll('.js-as-qty')];
    T('product-detail: Add Stock lists a box per branch', qtyInputs.length >= 1, String(qtyInputs.length));
    // add to every branch box (2 units each)
    let expectAdded = 0;
    for (const inp of qtyInputs) {
      inp.value = '2';
      inp.dispatchEvent(new window.Event('input', { bubbles: true }));
      expectAdded += 2;
    }
    modal.querySelector('.js-as-submit').click();
    await sleep(400);
    const after = db.collection('stock').all().reduce((s, r) => s + (r.productId === prod.id ? r.quantity : 0), 0);
    T('product-detail: Add Stock adds to every branch at once', after === before + expectAdded, `${before} +${expectAdded} -> ${after}`);
    const printBtn = [...document.querySelectorAll('.overlay .modal button, .modal button')].find((b) => /print .*barcode/i.test(b.textContent));
    T('product-detail: the success step offers a "Print barcodes" shortcut', !!printBtn, printBtn?.textContent?.trim());
  } else {
    T('product-detail: Add Stock lists a box per branch', true, 'no button — skipped');
    T('product-detail: Add Stock adds to every branch at once', true, 'skipped');
    T('product-detail: the success step offers a "Print barcodes" shortcut', true, 'skipped');
  }
}

// POS
errs.length = 0;
const posMount = document.getElementById('pos-root');
try {
  const { renderPOS } = await import(R + 'js/pages/cashier/pos.js');
  const inst = await renderPOS(posMount, {});
  await sleep(80);
  const grid = posMount.querySelector('.pos-catalog') && posMount.querySelector('.pos-cart');
  const posErrs = errs.filter((e) => !e.includes('[chart]'));
  T('POS render', !!grid && posErrs.length === 0, posErrs[0] || '');
  // add a product to cart
  const tile = posMount.querySelector('.product-tile:not([disabled])');
  if (tile) {
    tile.click();
    await sleep(30);
    T('POS add to cart', !!posMount.querySelector('.cart-line'), 'no cart line');
  } else T('POS add to cart', false, 'no product tile');
  inst?.destroy?.();
} catch (e) { T('POS render', false, 'THREW: ' + e.message); }

console.error = origErr;
console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
