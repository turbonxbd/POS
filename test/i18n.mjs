/**
 * i18n.mjs - বাংলা / English whole-interface switch.
 */
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><head><title>Dashboard · TX Demo</title></head><body><div id="app-root"></div></body></html>', { url: 'http://localhost:5173/admin.html', pretendToBeVisual: true });
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window); def('document', window.document); def('navigator', window.navigator);
def('location', window.location); def('history', window.history);
globalThis.Node = window.Node; globalThis.NodeFilter = window.NodeFilter; globalThis.MutationObserver = window.MutationObserver;
globalThis.HTMLElement = window.HTMLElement; globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.matchMedia = globalThis.matchMedia;
def('localStorage', window.localStorage); def('sessionStorage', window.sessionStorage);
def('addEventListener', window.addEventListener.bind(window));
def('removeEventListener', window.removeEventListener.bind(window));

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
initMockServer(); db.load(); if (db.isEmpty) await seedDemo(db);
const { initI18n, applyLang, getLang, t } = await import(R + 'js/core/i18n.js');
const config = (await import(R + 'js/config.js')).default;

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

document.body.innerHTML = `
  <nav><a class="nav-link">Products</a><a class="nav-link">Reports</a><a class="nav-link">Settings</a></nav>
  <button class="btn">Save</button>
  <button class="btn">Cancel</button>
  <h1>Total Sales</h1>
  <input placeholder="Search products, invoices, customers…">
  <span class="pos-amount">৳ 1,234.00</span>
  <span class="mono">AFIA-BAN-00042</span>
  <p>Matte Lipstick</p>
  <div>Showing 12 of 340</div>`;

initI18n();
T('default language is English', getLang() === 'en');
T('English leaves text as-is', document.querySelector('.nav-link').textContent === 'Products');

applyLang('bn');
await sleep(30);
T('getLang is bn', getLang() === 'bn');
T('nav Products -> পণ্য', document.querySelector('.nav-link').textContent === 'পণ্য', document.querySelector('.nav-link').textContent);
T('nav Reports -> রিপোর্ট', document.querySelectorAll('.nav-link')[1].textContent === 'রিপোর্ট');
T('button Save -> সংরক্ষণ', document.querySelector('.btn').textContent === 'সংরক্ষণ');
T('h1 Total Sales -> মোট বিক্রয়', document.querySelector('h1').textContent === 'মোট বিক্রয়');
T('placeholder translated', document.querySelector('input').getAttribute('placeholder').includes('খুঁজুন'));
T('money NOT translated (.pos-amount skipped)', document.querySelector('.pos-amount').textContent === '৳ 1,234.00');
T('invoice no NOT translated (.mono skipped)', document.querySelector('.mono').textContent === 'AFIA-BAN-00042');
T('product name (data) NOT translated', document.querySelector('p').textContent === 'Matte Lipstick');
T('pattern "Showing 12 of 340" translated', /দেখাচ্ছে/.test(document.querySelector('div').textContent), document.querySelector('div').textContent);
T('t() helper works in bn', t('Save') === 'সংরক্ষণ');

// persistence
const prefs = JSON.parse(localStorage.getItem(config.storage.prefsKey) || '{}');
T('language persisted to prefs', prefs.lang === 'bn');
T('<html lang> updated', document.documentElement.getAttribute('lang') === 'bn');
T('<html> gets lang-bn class', document.documentElement.classList.contains('lang-bn'));

// dynamically added node gets translated by the observer
const fresh = document.createElement('button');
fresh.textContent = 'Cancel';
document.body.appendChild(fresh);
await sleep(60);
T('dynamically added node translated by observer', fresh.textContent === 'বাতিল', fresh.textContent);

// broad coverage: strings from many panels
T('POS: "Complete sale" translated', t('Complete sale') === 'বিক্রয় সম্পন্ন করো', t('Complete sale'));
T('inventory: "Out of stock" translated', t('Out of stock') === 'স্টক নেই');
T('purchases: "Receive Stock" translated', t('Receive Stock') === 'স্টক গ্রহণ করো');
T('settings: "Backup / Data Management" translated', t('Backup / Data Management') === 'ব্যাকআপ / ডেটা ব্যবস্থাপনা');
T('roles: "Super Admin" translated', t('Super Admin') === 'সুপার অ্যাডমিন');
T('returns: "Process Return" translated', t('Process Return') === 'ফেরত প্রক্রিয়া করো');
T('notifications: "No notifications" translated', t('No notifications') === 'কোনো নোটিফিকেশন নেই');
T('confirm: "Wipe everything?" translated', t('Wipe everything?') === 'সবকিছু মুছবেন?');
T('table header "Barcode" translated', t('Barcode') === 'বারকোড');
T('empty state "No products found" translated', t('No products found') === 'কোনো পণ্য পাওয়া যায়নি');

// document <title> follows the language
T('<title> translated to Bangla', document.querySelector('title').textContent === 'ড্যাশবোর্ড · TX Demo', document.querySelector('title').textContent);

// switch back to English restores originals
applyLang('en');
T('<title> restored to English', document.querySelector('title').textContent === 'Dashboard · TX Demo', document.querySelector('title').textContent);
applyLang('bn'); await sleep(20); applyLang('en');
await sleep(30);
T('switch back: Products restored', document.querySelector('.nav-link').textContent === 'Products');
T('switch back: Save restored', document.querySelector('.btn').textContent === 'Save');
T('switch back: placeholder restored', document.querySelector('input').getAttribute('placeholder') === 'Search products, invoices, customers…');
T('switch back: html class removed', !document.documentElement.classList.contains('lang-bn'));

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
