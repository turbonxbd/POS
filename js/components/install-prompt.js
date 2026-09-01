/**
 * install-prompt.js - the "Install POS TXbd" affordance.
 *
 * Chrome/Edge/Android fire `beforeinstallprompt` when the app is installable. We
 * stash that event and show ONE quiet pill; tapping it opens the real browser
 * install dialog. The pill never appears when:
 *   - the app is already running installed (display-mode: standalone),
 *   - the user has installed it before (`appinstalled` was seen), or
 *   - the user dismissed the pill once (remembered in localStorage).
 *
 * Call startInstallPrompt() from the entry points that are real "front doors"
 * (Live site, Portal, Login) — never from inside a panel.
 */

const DISMISS_KEY = 'posTxbd_install_dismissed_v1';
const INSTALLED_KEY = 'posTxbd_installed_v1';

let deferredEvent = null;
let pill = null;
let wired = false;

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: window-controls-overlay)').matches
      || window.navigator.standalone === true;
  } catch { return false; }
}

function alreadyHandled() {
  return isStandalone() || ls.get(INSTALLED_KEY) === '1' || ls.get(DISMISS_KEY) === '1';
}

function removePill() {
  if (pill) { pill.remove(); pill = null; }
}

function showPill() {
  if (pill || alreadyHandled() || !deferredEvent) return;
  pill = document.createElement('div');
  pill.className = 'install-pill';
  pill.setAttribute('role', 'dialog');
  pill.setAttribute('aria-label', 'Install POS TXbd');
  pill.innerHTML = `
    <span class="install-pill__mark" aria-hidden="true">
      <img src="assets/logos/icon-192.png" alt="" width="28" height="28">
    </span>
    <span class="install-pill__text">Install <strong>POS TXbd</strong> as an app</span>
    <button type="button" class="btn btn--primary btn--sm install-pill__go">Install</button>
    <button type="button" class="install-pill__x" aria-label="Not now">&times;</button>`;

  pill.querySelector('.install-pill__go').addEventListener('click', async () => {
    const evt = deferredEvent;
    if (!evt) { removePill(); return; }
    deferredEvent = null;
    try {
      evt.prompt();
      const choice = await evt.userChoice;
      if (choice && choice.outcome === 'accepted') ls.set(INSTALLED_KEY, '1');
      else ls.set(DISMISS_KEY, '1'); // declined the OS dialog — don't nag again
    } catch { /* dialog already consumed */ }
    removePill();
  });

  pill.querySelector('.install-pill__x').addEventListener('click', () => {
    ls.set(DISMISS_KEY, '1');
    removePill();
  });

  (document.body || document.documentElement).appendChild(pill);
}

export function startInstallPrompt() {
  if (wired || typeof window === 'undefined' || !window.addEventListener) return;
  wired = true;
  if (isStandalone()) ls.set(INSTALLED_KEY, '1');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep the mini-infobar away; we show our own
    deferredEvent = e;
    if (!alreadyHandled()) setTimeout(showPill, 1200); // let the page settle first
  });

  window.addEventListener('appinstalled', () => {
    ls.set(INSTALLED_KEY, '1');
    deferredEvent = null;
    removePill();
  });
}

export default startInstallPrompt;
