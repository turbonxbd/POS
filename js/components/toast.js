/**
 * toast.js - transient notifications. toast.success('Saved'), toast.error(msg).
 */
import { icon } from './icons.js';
import { escapeHtml } from '../utils/dom.js';

let region;
function ensureRegion() {
  if (region && document.body.contains(region)) return region;
  region = document.createElement('div');
  region.className = 'toast-region';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  document.body.appendChild(region);
  return region;
}

const ICONS = { success: 'check-circle', error: 'alert-circle', warning: 'alert-triangle', info: 'info' };

function show(type, message, { title, duration = 4200, action } = {}) {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `
    <span class="toast__icon">${icon(ICONS[type] || 'info')}</span>
    <div class="toast__body">
      ${title ? `<div class="toast__title">${escapeHtml(title)}</div>` : ''}
      <div class="toast__msg">${escapeHtml(message)}</div>
      ${action ? `<button class="btn btn--ghost btn--sm js-toast-action" style="margin-top:6px;padding:0;height:auto;color:var(--accent-text)">${escapeHtml(action.label)}</button>` : ''}
    </div>
    <button class="toast__close" aria-label="Dismiss">${icon('x', { size: 14 })}</button>`;

  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.toast__close').addEventListener('click', close);
  if (action) {
    el.querySelector('.js-toast-action').addEventListener('click', () => {
      action.onClick?.();
      close();
    });
  }
  ensureRegion().appendChild(el);
  if (duration) setTimeout(close, duration);
  return { close };
}

export const toast = {
  success: (m, o) => show('success', m, o),
  error: (m, o) => show('error', m, { duration: 6000, ...o }),
  warning: (m, o) => show('warning', m, o),
  info: (m, o) => show('info', m, o),
  /** Convenience: pretty-print an error object. */
  fromError(err, fallback = 'Something went wrong') {
    const msg = err?.data?.message || err?.message || fallback;
    return show('error', msg, { duration: 6000 });
  },
};

export default toast;
