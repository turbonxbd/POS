/**
 * net-guard.js - full-screen "No Internet" block.
 *
 * The instant the device goes offline a fixed overlay covers the whole app and
 * locks it - nothing behind it is clickable or scrollable, on every panel. It
 * clears itself the moment the connection is confirmed back.
 *
 * Two triggers, because the browser's `offline` event is not reliable (it often
 * does NOT fire when Wi-Fi stays "connected" but the internet is gone):
 *   1. the `offline` event  -> block immediately (best case)
 *   2. a periodic probe     -> block after a couple of missed round-trips
 * The probe is a HEAD request with a cache-buster, so it is a real network hit
 * and never a cached 200 from the service worker.
 *
 * Started once from core/boot.js, so all five panels + the login screen get it.
 */
import store from '../core/store.js';
import bus from '../core/event-bus.js';
import { icon } from './icons.js';

// Same-origin, always deployed, tiny. `?_=` busts every cache layer; HEAD is
// never intercepted by the service worker (it only handles GET).
const pingUrl = () => new URL('assets/logos/favicon.svg', document.baseURI).href + `?_=${Date.now()}`;
const RECHECK_MS = 4000; // while blocked: how often to test for the connection coming back
const WATCH_MS = 12000; // while running: proactive connectivity probe
const PING_TIMEOUT_MS = 4000;
const MISSES_TO_BLOCK = 2; // consecutive silent probe failures before blocking

let overlay = null;
let recheckTimer = null;
let watchTimer = null;
let started = false;
let misses = 0;

function render() {
  const el = document.createElement('div');
  el.className = 'net-guard';
  el.setAttribute('role', 'alertdialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'No internet connection');
  el.innerHTML = `
    <div class="net-guard__card">
      <span class="net-guard__icon" aria-hidden="true">${icon('alert-triangle', { size: 30 })}</span>
      <h2>No internet connection</h2>
      <p>You're offline. The system is locked until the connection comes back —
         anything you do right now would not be saved.</p>
      <div class="net-guard__status"><span class="net-guard__dot"></span> Waiting for the connection…</div>
      <button type="button" class="btn btn--outline btn--sm net-guard__retry">Check again</button>
    </div>`;
  el.querySelector('.net-guard__retry').addEventListener('click', () => verify());
  return el;
}

/** Is the internet actually reachable right now? */
async function reachable() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT_MS);
    const res = await fetch(pingUrl(), { method: 'HEAD', cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    return !!res && (res.ok || res.status === 0 || res.type === 'opaque');
  } catch {
    return false;
  }
}

function show() {
  misses = 0;
  if (overlay) return;
  overlay = render();
  (document.body || document.documentElement).appendChild(overlay);
  document.documentElement.classList.add('net-guard-lock');
  if (store.get('online') !== false) store.set({ online: false });
  bus.emit('net:offline');
  scheduleRecheck();
}

function hide() {
  clearTimeout(recheckTimer);
  recheckTimer = null;
  misses = 0;
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  document.documentElement.classList.remove('net-guard-lock');
  if (store.get('online') !== true) store.set({ online: true });
  bus.emit('net:online');
}

function scheduleRecheck() {
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(async () => {
    if (await reachable()) hide();
    else scheduleRecheck();
  }, RECHECK_MS);
}

/** Force a check now: block if unreachable, clear if reachable. */
async function verify() {
  const ok = await reachable();
  if (!ok && !overlay) show();
  else if (ok && overlay) hide();
  return ok;
}

/**
 * Background watch - the safety net for an internet drop that fires no
 * `offline` event. Needs MISSES_TO_BLOCK consecutive failures so a single
 * flaky request never blanks the whole app.
 */
async function watchTick() {
  if (overlay) return; // scheduleRecheck already owns the recovery path
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (await reachable()) { misses = 0; return; }
  misses += 1;
  if (misses >= MISSES_TO_BLOCK) show();
}

function startWatch() {
  clearInterval(watchTimer);
  watchTimer = setInterval(watchTick, WATCH_MS);
  watchTimer?.unref?.(); // don't keep a Node test process alive
}

/** One background-watch iteration - exported for tests. */
export const _watchTick = watchTick;

export function startNetGuard() {
  if (started || typeof window === 'undefined' || !window.addEventListener) return;
  started = true;
  window.addEventListener('offline', show);
  window.addEventListener('online', () => verify());
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') verify();
    });
  }
  startWatch();
  // Started already offline (page loaded from cache with no connection).
  if (navigator.onLine === false) show();
}

export function stopNetGuard() {
  clearInterval(watchTimer);
  clearTimeout(recheckTimer);
  watchTimer = null;
  started = false;
}

export default startNetGuard;
