/**
 * kit.js - shared helpers for the Super Admin (platform) pages.
 */
import { escapeHtml } from '../../utils/dom.js';
import money from '../../utils/money.js';
import { icon } from '../../components/icons.js';
import bus from '../../core/event-bus.js';

export const fmtMoney = (v) => money.format(v || 0);
export const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const fmtDateTime = (v) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const STATUS_TONE = {
  active: 'success', trialing: 'info', pending: 'warning', expired: 'danger',
  cancelled: 'danger', suspended: 'danger', none: 'muted', open: 'warning', answered: 'info', closed: 'muted',
};
export function badge(label, tone) {
  const t = tone || STATUS_TONE[label] || 'muted';
  return `<span class="sa-badge sa-badge--${t}">${escapeHtml(String(label || '—'))}</span>`;
}

/** Standard page scaffold. Returns { root, body, setActions }. */
export function page(mount, { title, subtitle, back }) {
  mount.innerHTML = `
    <div class="page sa-page">
      ${back ? `<a class="sa-back" href="#${back.href}">${icon('chevron-left', { size: 15 })} ${escapeHtml(back.label)}</a>` : ''}
      <div class="page-header">
        <div class="page-header__title">
          <h1>${escapeHtml(title)}</h1>
          <p${subtitle ? '' : ' hidden'}>${escapeHtml(subtitle || '')}</p>
        </div>
        <div class="page-header__actions" id="sa-actions"></div>
      </div>
      <div id="sa-body"></div>
    </div>`;
  const actionsEl = mount.querySelector('#sa-actions');
  const root = mount.querySelector('.sa-page');
  return {
    root,
    body: mount.querySelector('#sa-body'),
    setTitle(text) { root.querySelector('h1').textContent = text; },
    setSubtitle(text) {
      const el = root.querySelector('.page-header__title p');
      el.textContent = text || '';
      el.hidden = !text;
    },
    setActions(list) {
      actionsEl.innerHTML = '';
      (list || []).forEach((a) => {
        const b = document.createElement('button');
        b.className = `btn ${a.variant ? 'btn--' + a.variant : 'btn--primary'}`;
        b.innerHTML = `${a.icon ? icon(a.icon, { size: 15 }) : ''}${escapeHtml(a.label)}`;
        b.addEventListener('click', a.onClick);
        actionsEl.appendChild(b);
      });
    },
  };
}

export function tableCard({ head, rows, empty = 'Nothing here yet.' }) {
  return `<div class="card sa-tablecard">
    <div class="table-wrap"><table class="table">
      <thead><tr>${head.map((h) => `<th${h.num ? ' class="num"' : ''}>${escapeHtml(h.label ?? h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="sa-empty">${escapeHtml(empty)}</td></tr>`}</tbody>
    </table></div>
  </div>`;
}

// True only while a liveRefresh re-render is in flight, so `loading()` can keep
// the current view on screen instead of flashing a spinner over live data.
let _refreshing = false;

export function loading(body) {
  if (_refreshing && body?.children?.length && !body.querySelector('.loading-block')) return;
  body.innerHTML = `<div class="loading-block"><span class="spinner"></span></div>`;
}

const _liveByMount = new WeakMap();

/**
 * Re-run `fn` whenever platform data changes (this tab or another), while the
 * page is still mounted and no modal is open. Debounced. Only one live
 * subscription per mount - calling again (e.g. a page that re-invokes itself)
 * replaces the previous one. Self-cleans once the mount is detached.
 */
export function liveRefresh(anchorEl, fn, delay = 900) {
  if (!anchorEl) return () => {};
  _liveByMount.get(anchorEl)?.();
  let t = null;
  const off = bus.on('db:changed', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!anchorEl.isConnected) { off(); _liveByMount.delete(anchorEl); return; }
      if (document.querySelector('.overlay')) return;
      if (document.visibilityState === 'hidden') return;
      _refreshing = true;
      Promise.resolve().then(fn).finally(() => { _refreshing = false; });
    }, delay);
  });
  _liveByMount.set(anchorEl, off);
  return off;
}

export function errorBox(body, err) {
  body.innerHTML = `<div class="alert alert--danger"><div class="alert__body">${escapeHtml(err?.data?.message || err?.message || 'Failed to load.')}</div></div>`;
}
