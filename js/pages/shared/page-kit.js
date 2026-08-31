/**
 * page-kit.js - shared building blocks for admin pages.
 */
import { icon } from '../../components/icons.js';
import { escapeHtml, html } from '../../utils/dom.js';
import { statusMeta } from '../../utils/format.js';
import money from '../../utils/money.js';
import { can } from '../../core/rbac.js';

/** Standard page scaffold: returns { el, body, setActions }. */
export function pageShell(mount, { title, subtitle, actions = [], breadcrumb = [] } = {}) {
  mount.innerHTML = `
    <div class="page">
      ${breadcrumb.length ? `<nav class="breadcrumb">${breadcrumb
        .map((b, i) => (b.href ? `<a href="${escapeHtml(b.href)}">${escapeHtml(b.label)}</a>` : `<span>${escapeHtml(b.label)}</span>`) + (i < breadcrumb.length - 1 ? icon('chevron-right', { size: 13 }) : ''))
        .join('')}</nav>` : ''}
      <div class="page-header">
        <div class="page-header__title">
          <h1>${escapeHtml(title)}</h1>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <div class="page-header__actions" id="page-actions"></div>
      </div>
      <div id="page-body"></div>
    </div>`;
  const actionsEl = mount.querySelector('#page-actions');
  const body = mount.querySelector('#page-body');
  setActions(actionsEl, actions);
  return {
    el: mount.querySelector('.page'),
    body,
    setActions: (a) => setActions(actionsEl, a),
    setSubtitle: (s) => {
      const p = mount.querySelector('.page-header__title p');
      if (p) p.textContent = s;
    },
  };
}

function setActions(el, actions) {
  el.innerHTML = '';
  actions.filter((a) => !a.permission || can(a.permission)).forEach((a) => {
    const btn = document.createElement(a.href ? 'a' : 'button');
    btn.className = `btn ${a.variant ? 'btn--' + a.variant : ''}`;
    if (a.href) btn.href = a.href;
    btn.innerHTML = `${a.icon ? icon(a.icon, { size: 16 }) : ''}${escapeHtml(a.label)}`;
    if (a.onClick) btn.addEventListener('click', a.onClick);
    el.appendChild(btn);
  });
}

/** Status badge HTML. */
export function statusBadge(status) {
  const m = statusMeta(status);
  return `<span class="badge badge--${m.variant} badge--dot">${escapeHtml(m.label)}</span>`;
}

export function moneyCell(minor, { strong = false } = {}) {
  return `<span class="pos-amount ${strong ? 'strong' : ''}">${money.format(minor)}</span>`;
}

export function pill(text, variant = 'neutral') {
  return `<span class="badge badge--${variant}">${escapeHtml(text)}</span>`;
}

/** A KPI strip above a table. */
export function statStrip(items) {
  return `<div class="stat-strip" style="margin-bottom:var(--sp-4)">
    ${items.map((i) => `<div class="stat-strip__item"><div class="label">${escapeHtml(i.label)}</div><div class="value">${i.value}</div></div>`).join('')}
  </div>`;
}

export function card(title, bodyHtml, { actions = '' } = {}) {
  return `<div class="card">
    ${title ? `<div class="card__header"><h3>${escapeHtml(title)}</h3>${actions}</div>` : ''}
    <div class="card__body">${bodyHtml}</div>
  </div>`;
}

export { html };
