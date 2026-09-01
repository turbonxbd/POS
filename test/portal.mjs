/**
 * portal.mjs - the merchant portal: sign in with a merchant account -> panel
 * picker (Admin + Cashier), role-scoped. No shared access code.
 */
import { JSDOM } from 'jsdom';
const dom = new JSDOM(
  '<!doctype html><html><body><div id="portal-card"></div><button id="theme-toggle"></button><span id="portal-version"></span><div class="portal__foot"></div></body></html>',
  { url: 'http://localhost:5173/portal.html', pretendToBeVisual: true },
);
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window); def('document', window.document); def('navigator', window.navigator);
def('location', window.location); def('history', window.history);
globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node;
globalThis.KeyboardEvent = window.KeyboardEvent; globalThis.CustomEvent = window.CustomEvent; globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.matchMedia = globalThis.matchMedia;
def('localStorage', window.localStorage);
def('sessionStorage', window.sessionStorage);
def('addEventListener', window.addEventListener.bind(window));
def('removeEventListener', window.removeEventListener.bind(window));
window.HTMLElement.prototype.animate = function () { return { finished: Promise.resolve() }; };
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
const { session } = await import(R + 'js/core/session.js');
const { hashPassword } = await import(R + 'js/utils/crypto.js');
const { uuid } = await import(R + 'js/utils/id.js');
initMockServer(); db.load(); if (db.isEmpty) await seedDemo(db);

// TX Demo ships owner-only; add a Cashier so the role-scoped picker can be tested
{
  const mid = db.collection('businesses').all()[0].merchantId;
  const branchId = db.collection('branches').all()[0].id;
  const cu = db.collection('users').insert({
    id: uuid(), name: 'Portal Cashier', email: 'portalcashier@txdemo.shop', phone: '',
    passwordHash: await hashPassword('demo1234'), roleId: 'role_cashier', status: 'active',
    merchantId: mid, platform: false, permissionGrants: [], permissionRevokes: [], lastLoginAt: null,
  });
  db.collection('employees').insert({ id: uuid(), merchantId: mid, userId: cu.id, branchIds: [branchId], joinDate: new Date().toISOString() });
}

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
console.error = (...a) => errs.push(a.map(String).join(' '));
const fill = (name, v) => { const el = document.querySelector(`#login-form [name="${name}"]`); el.value = v; };
const doLogin = async (email, pw) => { fill('email', email); fill('password', pw); document.getElementById('login-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true })); await sleep(900); };

await import(R + 'js/app-portal.js');
await sleep(400);
const card = document.getElementById('portal-card');

T('portal shows a merchant sign-in form (no access code)', !!card.querySelector('#login-form') && !card.querySelector('#gate-form'));
T('sign-in form has email + password', !!card.querySelector('#login-form [name=email]') && !!card.querySelector('#login-form [name=password]'));

// forgot-password: link opens a modal that posts /auth/forgot and confirms
T('sign-in form has a "Forgot password" link', !!card.querySelector('#forgot-link'));
{
  card.querySelector('#login-form [name=email]').value = 'admin@txdemo.shop';
  card.querySelector('#forgot-link').click();
  for (let i = 0; i < 20 && !document.querySelector('.modal .js-fp-send'); i++) await sleep(50);
  const send = document.querySelector('.modal .js-fp-send');
  T('forgot-password modal opens with the email prefilled', !!send && document.querySelector('.modal .js-fp-email')?.value === 'admin@txdemo.shop');
  send?.click();
  for (let i = 0; i < 20 && !/request received/i.test(document.querySelector('.modal')?.textContent || ''); i++) await sleep(50);
  T('forgot-password shows a "request received" confirmation', /request received/i.test(document.querySelector('.modal')?.textContent || ''));
  document.querySelector('.modal .js-modal-close')?.click();
  await sleep(50);
  const { db } = await import(R + 'js/core/db.js');
  T('forgot-password raised a Super Admin notification', db.collection('platform_notifications').all().some((n) => n.type === 'password_reset'));
}

await doLogin('admin@txdemo.shop', 'wrong-pw');
T('wrong password shows an error, stays on the form', !!card.querySelector('#login-form') && card.querySelector('#login-err').textContent.length > 0);

await doLogin('admin@txdemo.shop', 'demo1234');
T('correct login -> panel picker', !!card.querySelector('.portal-panels'));
const links = [...card.querySelectorAll('.panel-card')].map((a) => a.getAttribute('href'));
T('owner sees BOTH Admin + Cashier cards', links.includes('admin.html') && links.includes('cashier.html'), links.join(','));
T('picker shows the business name', /TX Demo/.test(card.querySelector('.portal-session')?.textContent || ''));
T('no global "who can sign in" staff dump', !card.querySelector('.portal-accounts'));

// sign out -> back to the form
card.querySelector('#signout').click();
await sleep(200);
T('sign out returns to the sign-in form', !!card.querySelector('#login-form'));

// a cashier-only user only gets the Cashier card
await doLogin('portalcashier@txdemo.shop', 'demo1234');
const links2 = [...card.querySelectorAll('.panel-card')].map((a) => a.getAttribute('href'));
T('cashier-only staff see ONLY the Cashier card', links2.includes('cashier.html') && !links2.includes('admin.html'), links2.join(','));

card.querySelector('#signout').click();
await sleep(200);

// a platform (Super Admin) account has NO way into the portal: bounced to the
// sign-in form with a notice, session dropped, no Super Admin link anywhere
await doLogin('superadmin@postxbd.app', 'superadmin123');
T('platform account cannot reach the portal picker', !card.querySelector('.portal-panels') && !!card.querySelector('#login-form'));
T('platform account is signed out again', !(await session.restore().catch(() => false)));
T('portal shows no Super Admin link/button anywhere', !card.querySelector('a[href*="superadmin"]'));

await session.logout({ redirect: false }).catch(() => {});
T('no console errors', errs.filter((e) => !e.includes('Not implemented') && !e.includes('i18n')).length === 0, errs[0] || '');

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
