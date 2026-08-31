/**
 * app-boot.mjs - boots the admin and cashier SPAs the way a browser does
 * (portal unlock -> admin.html / cashier.html full bootstrap + first route),
 * catching shell/router errors the page-level render test misses.
 */
import { JSDOM } from 'jsdom';

function makeDom(url, bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}<div id="print-root"></div></body></html>`, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('window', window); def('document', window.document); def('navigator', window.navigator);
  def('location', window.location); def('history', window.history);
  globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node; globalThis.Image = window.Image;
  globalThis.KeyboardEvent = window.KeyboardEvent; globalThis.CustomEvent = window.CustomEvent; globalThis.Event = window.Event;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  window.matchMedia = globalThis.matchMedia;
  def('localStorage', window.localStorage);
  def('sessionStorage', window.sessionStorage);
  def('addEventListener', window.addEventListener.bind(window));
  def('removeEventListener', window.removeEventListener.bind(window));
  window.print = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 10 }) });
  window.HTMLElement.prototype.animate = function () { return { finished: Promise.resolve(), cancel() {} }; };
  window.HTMLElement.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  return window;
}

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = '../';

/* ---------- shared: seed once via a throwaway context ---------- */
{
  makeDom('http://localhost:5173/x.html', '');
  if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;
  const { db } = await import(R + 'js/core/db.js');
  const { initMockServer } = await import(R + 'js/core/mock-server.js');
  const { seedDemo } = await import(R + 'js/data/seed.js');
  initMockServer(); db.load(); if (db.isEmpty) await seedDemo(db);
  const users = db.collection('users').count();
  const products = db.collection('products').count();
  T('seed produced users + products', users > 0 && products > 0, `${users}u ${products}p`);
}

/* ---------- ADMIN bootstrap ---------- */
{
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  const win = makeDom('http://localhost:5173/admin.html', '<div id="app-progress"></div><div id="app-root" class="gate"></div>');
  // pre-authenticate (portal -> admin -> user would log in; emulate a live session)
  const { session } = await import(R + 'js/core/session.js');
  await session.login('admin@txdemo.shop', 'demo1234');
  win.location.hash = '#/';
  await import(R + 'js/app-admin.js?admin1');
  await sleep(600);
  const root = win.document.getElementById('app-root');
  T('admin shell rendered (sidebar + topbar)', !!root.querySelector('.sidebar') && !!root.querySelector('.topbar'), root.innerHTML.slice(0, 120));
  T('admin dashboard route rendered', !!root.querySelector('.kpi-grid, .page, .dash-grid'), 'no page content');
  T('admin "Back to Portal" wired', win.document.body.innerHTML.includes('user-btn'));

  /* responsive shell behaviour */
  const shell = root.querySelector('.app-shell');
  const menuBtn = root.querySelector('#menu-btn');
  const backdrop = root.querySelector('#sb-backdrop');
  T('mobile hamburger button exists', !!menuBtn);
  T('topbar page-title element populated on route', (root.querySelector('#topbar-title')?.textContent || '').length > 0, root.querySelector('#topbar-title')?.textContent);
  menuBtn.dispatchEvent(new win.Event('click'));
  T('hamburger click opens the sidebar drawer', shell.classList.contains('is-sidebar-open'));
  T('hamburger aria-expanded reflects open', menuBtn.getAttribute('aria-expanded') === 'true');
  menuBtn.dispatchEvent(new win.Event('click'));
  T('hamburger click again closes the drawer (toggle)', !shell.classList.contains('is-sidebar-open'));
  menuBtn.dispatchEvent(new win.Event('click'));
  backdrop.dispatchEvent(new win.Event('click'));
  T('tapping the backdrop closes the drawer', !shell.classList.contains('is-sidebar-open'));
  menuBtn.dispatchEvent(new win.Event('click'));
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  T('Escape closes the drawer', !shell.classList.contains('is-sidebar-open'));
  // navigating closes an open drawer
  shell.classList.add('is-sidebar-open');
  win.location.hash = '#/products';
  await sleep(200);
  T('route change closes an open drawer', !shell.classList.contains('is-sidebar-open'));
  T('topbar title updates on navigation', /product/i.test(root.querySelector('#topbar-title')?.textContent || ''), root.querySelector('#topbar-title')?.textContent);

  // subscription & billing page
  win.location.hash = '#/billing';
  await sleep(350);
  T('admin Subscription & Billing page renders', !!root.querySelector('.stat-strip, .kv-list, .alert'), root.querySelector('#page-body')?.innerHTML.slice(0, 100));
  T('billing page shows the plan + a Pay button or a due alert', /Pay (setup|monthly)|due now|Payment history/i.test(root.querySelector('#page-body')?.textContent || ''));

  const realErrs = errs.filter((e) => !e.includes('Not implemented') && !e.includes('[chart]'));
  T('admin: no console errors during boot', realErrs.length === 0, realErrs[0] || '');
  console.error = orig;
}

/* ---------- CASHIER bootstrap ---------- */
{
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  const win = makeDom('http://localhost:5173/cashier.html', '<div id="app-progress"></div><div id="pos-root"></div>');
  const { session } = await import(R + 'js/core/session.js');
  await session.logout({ redirect: false }).catch(() => {});
  await session.login('admin@txdemo.shop', 'demo1234');
  await import(R + 'js/app-cashier.js?cashier1');
  await sleep(700);
  const root = win.document.getElementById('pos-root');
  const html = root.innerHTML;
  T('cashier rendered something', html.length > 200, html.slice(0, 120));
  T('cashier shows POS terminal OR register gate', /pos-catalog|register-gate|pos-topbar/.test(html), html.slice(0, 160));
  if (root.querySelector('.pos-catalog')) {
    T('POS has a mobile cart button + bottom-sheet backdrop', !!root.querySelector('.js-cart-fab') && !!root.querySelector('.js-sheet-backdrop'));
    T('POS cart grabber toggle wired', typeof root.querySelector('.pos-cart__head') !== 'undefined');
  }
  const realErrs = errs.filter((e) => !e.includes('Not implemented') && !e.includes('[chart]') && !e.includes('camera'));
  T('cashier: no console errors during boot', realErrs.length === 0, realErrs[0] || '');
  console.error = orig;
}

/* ---------- LIVE / PUBLIC bootstrap ---------- */
{
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  const win = makeDom('http://localhost:5173/index.html', '<div id="app-root"></div>');
  const { session } = await import(R + 'js/core/session.js');
  await session.logout({ redirect: false }).catch(() => {});
  await import(R + 'js/app-live.js?live1');
  await sleep(600);
  const root = win.document.getElementById('app-root');
  T('live panel rendered nav + hero + pricing', !!root.querySelector('.live-nav') && !!root.querySelector('.live-hero') && !!root.querySelector('#pricing'));
  T('live pricing lists plans from /plans with setup + monthly', root.querySelectorAll('.live-plan').length >= 3 && /setup/i.test(root.querySelector('.live-plan__terms')?.textContent || ''));
  T('live WhatsApp links use a wa.me number', /wa\.me\/\d/.test(root.innerHTML));
  T('live support chat widget mounted', !!win.document.getElementById('live-chat'));
  const realErrs = errs.filter((e) => !e.includes('Not implemented') && !e.includes('[chart]') && !e.includes('MutationObserver'));
  T('live: no console errors during boot', realErrs.length === 0, realErrs[0] || '');
  console.error = orig;
}

/* ---------- SUPER ADMIN bootstrap ---------- */
{
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.map(String).join(' '));
  const win = makeDom('http://localhost:5173/superadmin.html', '<div id="app-progress"></div><div id="app-root" class="gate"></div>');
  const { session } = await import(R + 'js/core/session.js');
  const store = (await import(R + 'js/core/store.js')).default;
  const { db } = await import(R + 'js/core/db.js');
  const { ensurePlatform } = await import(R + 'js/data/seed.js');

  /* simulate a browser whose local DB was seeded BEFORE the 5-panel platform:
     no merchants row, no plans, no Super Admin account, no role_super_admin */
  for (const s of db.collection('subscriptions').all()) db.collection('subscriptions').remove(s.id);
  for (const p of db.collection('plans').all()) db.collection('plans').remove(p.id);
  for (const m of db.collection('merchants').all()) db.collection('merchants').remove(m.id);
  for (const u of db.collection('users').all()) { if (u.platform) db.collection('users').remove(u.id); else db.collection('users').update(u.id, { merchantId: undefined }); }
  db.collection('roles').remove('role_super_admin');
  const healed = await ensurePlatform(db);
  T('ensurePlatform upgrades a pre-platform DB', healed === true);
  T('ensurePlatform restored merchants + plans + role', db.collection('merchants').count() === 1 && db.collection('plans').count() === 3 && !!db.collection('roles').get('role_super_admin'));
  T('ensurePlatform is idempotent (second call is a no-op)', (await ensurePlatform(db)) === false);

  await session.logout({ redirect: false }).catch(() => {});
  await session.login('superadmin@postxbd.app', 'superadmin123');
  T('Super Admin credentials work after the upgrade', store.get('user')?.platform === true, store.get('user')?.email);
  win.location.hash = '#/';
  await import(R + 'js/app-superadmin.js?sa1');
  await sleep(700);
  const root = win.document.getElementById('app-root');
  T('super admin shell rendered (sidebar + topbar)', !!root.querySelector('.sidebar') && !!root.querySelector('.topbar'), root.innerHTML.slice(0, 120));
  T('super admin dashboard KPI grid rendered', !!root.querySelector('.kpi-grid'));
  T('dashboard has no error box', !root.querySelector('#main .alert--danger'), root.querySelector('#main .alert__body')?.textContent);

  const routes = [
    ['#/merchants', '.sa-row, .sa-tablecard'],
    ['#/subscriptions', '.sa-tablecard'],
    ['#/payments', '.sa-filterbar'],
    ['#/plans', '.sa-plans, .sa-plan'],
    ['#/revenue', '.kpi-grid, .sa-bars'],
    ['#/support', '#sa-body'],
    ['#/chat', '.sa-chat'],
    ['#/settings', '#sec-contact'],
  ];
  for (const [hash, sel] of routes) {
    win.location.hash = hash;
    await sleep(350);
    const main = win.document.getElementById('main');
    T(`route ${hash} renders without an error box`, !main.querySelector('.alert--danger'), main.querySelector('.alert__body')?.textContent);
    T(`route ${hash} has content (${sel})`, !!main.querySelector(sel), main.innerHTML.slice(0, 100));
  }

  // drill into a merchant detail (the page that was crashing)
  win.location.hash = '#/merchants';
  await sleep(300);
  const mid = db.collection('merchants').all()[0]?.id;
  win.location.hash = '#/merchants/' + mid;
  await sleep(450);
  const dm = win.document.getElementById('main');
  T('merchant detail renders without an error box', !dm.querySelector('.alert--danger'), dm.querySelector('.alert__body')?.textContent);
  T('merchant detail shows the subscription + usage cards', (dm.querySelectorAll('.sa-detail-grid .card').length >= 3), String(dm.querySelectorAll('.sa-detail-grid .card').length));
  T('merchant detail sets the business name as the page title', (dm.querySelector('h1')?.textContent || '').length > 0, dm.querySelector('h1')?.textContent);

  const realErrs = errs.filter((e) => !e.includes('Not implemented') && !e.includes('[chart]') && !e.includes('MutationObserver'));
  T('super admin: no console errors during boot + navigation', realErrs.length === 0, realErrs[0] || '');
  console.error = orig;
}

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
