/**
 * net-guard.js - full-screen "No Internet" block.
 *
 * The moment the device goes offline a fixed overlay covers the whole app and
 * locks it — nothing behind it is clickable or scrollable, on every panel. It
 * clears itself the instant the connection is confirmed back (the browser's
 * `online` event only means "a network is attached", so we verify with a real
 * request before unlocking, and keep re-checking while offline in case that
 * event is missed).
 *
 * Started once from core/boot.js, so all five panels + the login screen get it.
 */
import store from '../core/store.js';
import bus from '../core/event-bus.js';
import { icon } from './icons.js';

// Same-origin, always deployed, tiny — reachable in both the mock and rest builds.
const pingUrl = () => new URL('assets/logos/favicon.svg', document.baseURI).href + `?_=${Date.now()}`;
const RECHECK_MS = 4000;
const PING_TIMEOUT_MS = 3500;

let overlay = null;
let recheckTimer = null;
let started = false;

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
  el.querySelector('.net-guard__retry').addEventListener('click', () => verify().then((ok) => ok && hide()));
  return el;
}

/** Is the internet actually reachable right now? */
async function reachable() {
  if (navigator.onLine === false) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT_MS);
    await fetch(pingUrl(), { method: 'HEAD', cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

function show() {
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

async function verify() {
  const ok = await reachable();
  if (!ok && !overlay) show();
  return ok;
}

export function startNetGuard() {
  if (started || typeof window === 'undefined' || !window.addEventListener) return;
  started = true;
  window.addEventListener('offline', show);
  window.addEventListener('online', () => verify().then((ok) => ok && hide()));
  // Started already offline (page loaded from cache with no connection).
  if (navigator.onLine === false) show();
}

export default startNetGuard;
