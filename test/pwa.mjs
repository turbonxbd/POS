/**
 * pwa.mjs - installable-app: manifest, service worker shell, install prompt.
 *   node test/pwa.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- manifest ---- */
const manifest = JSON.parse(read('manifest.webmanifest'));
T('manifest is valid JSON with an id', !!manifest.id);
T('start_url is the Portal (the app front door)', manifest.start_url === 'portal.html');
T('display is standalone', manifest.display === 'standalone');
T('name / short_name are POS TXbd', /POS TXbd/.test(manifest.name) && manifest.short_name === 'POS TXbd');
T('has a 192 and a 512 PNG icon', manifest.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png')
  && manifest.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png'));
T('has a maskable icon', manifest.icons.some((i) => /maskable/.test(i.purpose || '')));
T('theme + background colours are set', /^#/.test(manifest.theme_color) && /^#/.test(manifest.background_color));

/* ---- icons exist and are real PNGs ---- */
for (const rel of ['assets/logos/icon-192.png', 'assets/logos/icon-512.png', 'assets/logos/icon-maskable-512.png', 'assets/logos/apple-touch-icon.png']) {
  const buf = readFileSync(join(ROOT, rel));
  T(`${rel} is a PNG`, buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a');
}

/* ---- service worker ---- */
const sw = read('service-worker.js');
T('service worker VERSION is bumped to v6', /VERSION\s*=\s*'pos-txbd-v6'/.test(sw));
T('shell precache includes portal.html', /'portal\.html'/.test(sw));
T('shell precache does NOT include superadmin.html (panel isolation)', !/superadmin\.html/.test(sw));
T('cross-origin requests are passed through', /url\.origin !== self\.location\.origin/.test(sw) && /return;/.test(sw));
T('only static file types are cacheable (no blind API caching)',
  /CACHEABLE\s*=\s*\/\\\.\(\?:css\|js/.test(sw) && /!CACHEABLE\.test\(url\.pathname\)/.test(sw));
T('navigations are network-first', sw.indexOf("request.mode === 'navigate'") < sw.indexOf('caches.match(request)'));

// the cacheable filter must reject an API path and accept a stylesheet
const m = sw.match(/const CACHEABLE = (\/.+\/i);/);
T('CACHEABLE regex literal found', !!m);
if (m) {
  // eslint-disable-next-line no-eval
  const re = eval(m[1]);
  T('API path is not cacheable', re.test('/api/sales') === false && re.test('/sync/changes') === false);
  T('static asset is cacheable', re.test('/css/tokens.css') === true && re.test('/assets/logos/icon-192.png') === true);
}

/* ---- entry-point HTML ---- */
for (const f of ['index.html', 'portal.html', 'admin.html', 'cashier.html', 'login.html']) {
  const html = read(f);
  T(`${f} links the manifest`, /rel="manifest"/.test(html));
  T(`${f} has an apple-touch-icon`, /apple-touch-icon/.test(html));
}
T('superadmin.html does NOT link the manifest (isolation)', !/rel="manifest"/.test(read('superadmin.html')));

/* ---- install prompt module ---- */
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173/portal.html' });
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window);
def('document', window.document);
def('navigator', window.navigator);
def('localStorage', window.localStorage);
def('Event', window.Event);

const { startInstallPrompt } = await import('../js/components/install-prompt.js');
startInstallPrompt();
T('no pill before the browser offers an install', !window.document.querySelector('.install-pill'));

let promptCalled = false;
const evt = new window.Event('beforeinstallprompt');
evt.prompt = () => { promptCalled = true; };
evt.userChoice = Promise.resolve({ outcome: 'dismissed' });
window.dispatchEvent(evt);
await sleep(1400);
const pill = window.document.querySelector('.install-pill');
T('the install pill appears after beforeinstallprompt', !!pill);
T('the pill names the app', /POS TXbd/.test(pill?.textContent || ''));

pill.querySelector('.install-pill__go').click();
await sleep(20);
T('clicking Install opens the browser dialog', promptCalled);
T('the pill is removed after the choice', !window.document.querySelector('.install-pill'));
T('a dismissed OS dialog is remembered', window.localStorage.getItem('posTxbd_install_dismissed_v1') === '1');

// a second beforeinstallprompt must NOT re-nag after a remembered dismissal
const evt2 = new window.Event('beforeinstallprompt');
evt2.prompt = () => {};
evt2.userChoice = Promise.resolve({ outcome: 'accepted' });
window.dispatchEvent(evt2);
await sleep(1400);
T('the pill does not come back once dismissed', !window.document.querySelector('.install-pill'));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
