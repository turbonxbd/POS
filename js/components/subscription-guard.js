/**
 * subscription-guard.js - the merchant-panel banner + lock-out screen driven by
 * store.get('access') (from /auth/me orgContext). Soft gate: past-due / pending
 * shows a dismissible-free banner; expired / suspended / cancelled replaces the
 * panel body with a "pay to continue" screen.
 */
import store from '../core/store.js';
import bus from '../core/event-bus.js';
import { icon } from './icons.js';
import { escapeHtml } from '../utils/dom.js';
import money from '../utils/money.js';

const QUIET = new Set(['active', 'platform', 'none', undefined, null]);

function access() {
  return store.get('access') || null;
}

function bannerHtml(a, { payHref }) {
  const due = a.dueAmount ? ` <strong>${money.format(a.dueAmount)} due.</strong>` : '';
  return `
    <div class="sub-banner sub-banner--${a.state}">
      <span class="sub-banner__icon">${icon(a.blocked ? 'alert-triangle' : 'alert-circle', { size: 16 })}</span>
      <span class="sub-banner__text">${escapeHtml(a.reason || 'Your subscription needs attention.')}${due}</span>
      ${payHref ? `<a class="btn btn--sm btn--primary" href="${payHref}">Manage billing</a>` : ''}
    </div>`;
}

function blockHtml(a, { payHref, portalHref }) {
  return `
    <div class="sub-block">
      <div class="sub-block__card">
        <span class="sub-block__icon">${icon('alert-triangle', { size: 26 })}</span>
        <h1>Subscription needs attention</h1>
        <p>${escapeHtml(a.reason || 'Your POS TXbd subscription is not active.')}</p>
        ${a.dueAmount ? `<p class="sub-block__due">Amount due: <strong>${money.format(a.dueAmount)}</strong></p>` : ''}
        <div class="sub-block__actions">
          ${payHref ? `<a class="btn btn--primary btn--lg" href="${payHref}">Go to billing &amp; pay</a>` : ''}
          ${portalHref ? `<a class="btn btn--ghost btn--lg" href="${portalHref}">Back to portal</a>` : ''}
        </div>
        <p class="sub-block__foot">Already paid? It can take a short while for POS TXbd to confirm it.</p>
      </div>
    </div>`;
}

/**
 * Mount the guard into a panel shell.
 *   opts.bannerBefore : element the banner is inserted before (usually #main)
 *   opts.contentEl    : the element hidden / overlaid when access is blocked
 *   opts.payHref      : where "Manage billing" / "pay" links go (admin: '#/billing')
 *   opts.portalHref   : optional "back to portal" link (cashier)
 */
export function mountSubscriptionGuard(opts) {
  const { bannerBefore, contentEl, payHref = null, portalHref = null, allowRoutes = ['#/billing'] } = opts;
  let bannerEl = null;
  let blockEl = null;

  const onAllowedRoute = () => allowRoutes.some((r) => (location.hash || '#/').startsWith(r));

  function apply() {
    const a = access();
    // clear previous
    bannerEl?.remove(); bannerEl = null;
    blockEl?.remove(); blockEl = null;
    if (contentEl) contentEl.hidden = false;

    if (!a || QUIET.has(a.state)) return;

    if (a.blocked && contentEl && !onAllowedRoute()) {
      contentEl.hidden = true;
      blockEl = document.createElement('div');
      blockEl.innerHTML = blockHtml(a, { payHref, portalHref });
      blockEl = blockEl.firstElementChild;
      contentEl.parentElement.insertBefore(blockEl, contentEl);
    } else {
      bannerEl = document.createElement('div');
      bannerEl.innerHTML = bannerHtml(a, { payHref });
      bannerEl = bannerEl.firstElementChild;
      (bannerBefore || contentEl).parentElement.insertBefore(bannerEl, bannerBefore || contentEl);
    }
  }

  apply();
  bus.on('auth:changed', apply);
  bus.on('subscription:changed', apply);
  window.addEventListener('hashchange', apply);
  return { refresh: apply };
}

export default mountSubscriptionGuard;
