/**
 * empty-state.js
 */
import { icon } from './icons.js';
import { escapeHtml } from '../utils/dom.js';

export function renderEmptyState({ icon: ic = 'inbox', title = 'Nothing here', message = '', action = null } = {}) {
  return `<div class="empty-state">
    <div class="empty-state__icon">${icon(ic, { size: 26 })}</div>
    <h3>${escapeHtml(title)}</h3>
    ${message ? `<p>${escapeHtml(message)}</p>` : ''}
    ${action ? `<button class="btn btn--primary js-empty-action">${action.icon ? icon(action.icon, { size: 16 }) : ''}${escapeHtml(action.label)}</button>` : ''}
  </div>`;
}

export function emptyStateEl(opts) {
  const wrap = document.createElement('div');
  wrap.innerHTML = renderEmptyState(opts);
  const el = wrap.firstElementChild;
  if (opts.action) el.querySelector('.js-empty-action')?.addEventListener('click', opts.action.onClick);
  return el;
}

export default renderEmptyState;
