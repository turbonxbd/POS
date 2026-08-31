import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="pos-root"></div><div id="print-root"></div></body></html>', { url: 'http://localhost:5173/cashier.html', pretendToBeVisual: true });
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window); def('document', window.document); def('navigator', window.navigator);
def('location', window.location); def('history', window.history);
globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node; globalThis.Image = window.Image;
globalThis.KeyboardEvent = window.KeyboardEvent; globalThis.CustomEvent = window.CustomEvent;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.matchMedia = globalThis.matchMedia;
def('localStorage', window.localStorage);
def('addEventListener', window.addEventListener.bind(window));
def('removeEventListener', window.removeEventListener.bind(window));
window.print = () => window.dispatchEvent(new window.Event('afterprint'));
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 10 }) });

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
const { session } = await import(R + 'js/core/session.js');
const { boot } = await import(R + 'js/core/boot.js');
initMockServer(); await boot(); db.load(); if (db.isEmpty) await seedDemo(db);
await session.login('admin@txdemo.shop', 'demo1234');

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
console.error = (...a) => errs.push(a.map(String).join(' '));

const { renderPOS } = await import(R + 'js/pages/cashier/pos.js');
const mount = document.getElementById('pos-root');
const inst = await renderPOS(mount, {});
await sleep(400);

const salesBefore = db.collection('sales').count();
const tiles = [...mount.querySelectorAll('.product-tile:not([disabled])')];
T('product tiles present', tiles.length > 0, tiles.length + '');
tiles[0].click(); await sleep(120);
tiles[1] && tiles[1].click(); await sleep(120);
const lines = mount.querySelectorAll('.cart-line');
T('cart has lines', lines.length >= 1, lines.length + '');

// increment qty on first line
const inc = mount.querySelector('.cart-line .js-inc');
inc.click(); await sleep(120);
const qtyInput = mount.querySelector('.cart-line .js-qty');
T('increment qty', Number(qtyInput.value) === 2, qtyInput.value);

// open payment
mount.querySelector('.js-pay').click();
await sleep(500);
const payModal = document.querySelector('.overlay .modal');
T('payment modal opens', !!payModal);
const totalText = document.querySelector('.pay-total-box .amount')?.textContent || '';
T('payment shows total', /\d/.test(totalText), totalText);

// tender buttons are flat: Cash, bKash, Nagad, Rocket, Bank, Card, Other (no "Mobile" step)
const methodBtns = [...document.querySelectorAll('.js-methods .pay-method')].map((b) => b.dataset.m);
T('cashier tender buttons: cash + bkash + nagad + card + bank, no "mobile" wrapper',
  methodBtns.includes('cash') && methodBtns.includes('bkash') && methodBtns.includes('nagad')
  && methodBtns.includes('card') && methodBtns.includes('bank_transfer') && !methodBtns.includes('mobile'),
  methodBtns.join(','));

// pay exact cash
const exactBtn = [...document.querySelectorAll('.quick-cash button')].find((b) => b.textContent === 'Exact');
exactBtn.click(); await sleep(120);
const confirmBtn = document.querySelector('.js-confirm');
T('confirm enabled after exact cash', !confirmBtn.disabled);
confirmBtn.click();
await sleep(500);

const salesAfter = db.collection('sales').count();
T('sale created', salesAfter === salesBefore + 1, `${salesBefore}->${salesAfter}`);
T('success modal shown', !!document.querySelector('.modal .js-print, .modal .js-next'));
// close success -> cart cleared
document.querySelector('.modal .js-next')?.click();
await sleep(200);
T('cart cleared after sale', mount.querySelectorAll('.cart-line').length === 0);

// the Pay button must recover — not stay stuck on "Processing…"
const payBtn = mount.querySelector('.js-pay');
T('Pay button recovers after a sale (not stuck on Processing)',
  !!payBtn && !/processing/i.test(payBtn.textContent) && !!payBtn.querySelector('.js-pay-total'), payBtn?.textContent?.trim());

// a second sale still works end to end
tiles[0] && tiles[0].click(); await sleep(120);
T('can start a new sale after the first', mount.querySelectorAll('.cart-line').length === 1);
mount.querySelector('.js-pay').click();
await sleep(400);
[...document.querySelectorAll('.quick-cash button')].find((b) => b.textContent === 'Exact')?.click();
await sleep(120);
document.querySelector('.js-confirm')?.click();
await sleep(500);
T('second sale created', db.collection('sales').count() === salesBefore + 2, String(db.collection('sales').count()));
document.querySelector('.modal .js-next')?.click();
await sleep(150);

// double-submit guard: the sale used an idempotency key; a fresh sale gets a new key
T('no console errors during flow', errs.filter((e) => !e.includes('chart') && !e.includes('Not implemented')).length === 0, errs[0] || '');

inst?.destroy?.();
console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
