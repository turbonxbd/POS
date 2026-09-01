/**
 * net-guard.mjs - the full-screen "No Internet" block.
 *   node test/net-guard.mjs
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:5173/admin.html' });
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window);
def('document', window.document);
def('navigator', window.navigator);
def('location', window.location);
def('localStorage', window.localStorage);
def('CustomEvent', window.CustomEvent);
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// reachable() pings assets/logos/favicon.svg — control it from the test
let reachableNow = true;
globalThis.fetch = async () => {
  if (!reachableNow) throw new Error('offline');
  return { ok: true, status: 200 };
};

const { startNetGuard } = await import('../js/components/net-guard.js');
const { default: store } = await import('../js/core/store.js');

startNetGuard();
T('boots with no overlay while online', !document.querySelector('.net-guard'));

// go offline
reachableNow = false;
window.dispatchEvent(new window.Event('offline'));
await sleep(20);
T('offline event shows the "No Internet" block immediately', !!document.querySelector('.net-guard'));
T('the block carries an accessible alertdialog role', document.querySelector('.net-guard')?.getAttribute('role') === 'alertdialog');
T('the document is locked while offline', document.documentElement.classList.contains('net-guard-lock'));
T('store.online is false while offline', store.get('online') === false);

// a spurious online event while still unreachable must NOT unlock
window.dispatchEvent(new window.Event('online'));
await sleep(30);
T('an online event is ignored until the connection is actually reachable', !!document.querySelector('.net-guard'));

// connection really restored
reachableNow = true;
window.dispatchEvent(new window.Event('online'));
await sleep(30);
T('the block disappears once the connection is verified back', !document.querySelector('.net-guard'));
T('the document is unlocked again', !document.documentElement.classList.contains('net-guard-lock'));
T('store.online is true again', store.get('online') === true);

// the periodic re-check clears it even with no online event
reachableNow = false;
window.dispatchEvent(new window.Event('offline'));
await sleep(20);
T('offline again re-shows the block', !!document.querySelector('.net-guard'));
reachableNow = true;
await sleep(4200); // RECHECK_MS is 4000
T('the background re-check clears the block without an online event', !document.querySelector('.net-guard'));

// the proactive watch blocks even when NO `offline` event fires (Wi-Fi stays
// "connected" but the internet is gone) - after MISSES_TO_BLOCK misses
const { _watchTick } = await import('../js/components/net-guard.js');
reachableNow = false;
await _watchTick();
T('one silent probe miss does not blank the app yet', !document.querySelector('.net-guard'));
await _watchTick();
T('a second silent miss blocks the app with no offline event', !!document.querySelector('.net-guard'));
reachableNow = true;
await sleep(4200);
T('recovers once the connection is back', !document.querySelector('.net-guard'));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
