/**
 * drawer.js - side sheet for detail views / filters. Same lifecycle as modal.
 */
import { icon } from './icons.js';
import { escapeHtml, trapFocus } from '../utils/dom.js';

export function openDrawer({ title = '', body = '', footer = null, side = 'right', width, onClose } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer-overlay';

  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.dataset.side = side;
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  if (width) drawer.style.setProperty('--drawer-w', typeof width === 'number' ? `${width}px` : width);
  drawer.innerHTML = `
    <div class="drawer__header">
      <h3>${escapeHtml(title)}</h3>
      <button class="modal__close js-drawer-close" aria-label="Close">${icon('x', { size: 18 })}</button>
    </div>
    <div class="drawer__body js-drawer-body"></div>
    <div class="drawer__footer js-drawer-footer" hidden></div>`;

  const bodyEl = drawer.querySelector('.js-drawer-body');
  const footerEl = drawer.querySelector('.js-drawer-footer');
  const ctx = { close, el: drawer, $: (s) => drawer.querySelector(s), $$: (s) => [...drawer.querySelectorAll(s)] };
  set(bodyEl, typeof body === 'function' ? body(ctx) : body);
  if (footer) {
    footerEl.hidden = false;
    set(footerEl, typeof footer === 'function' ? footer(ctx) : footer);
  }

  document.body.append(overlay, drawer);
  document.body.style.overflow = 'hidden';
  const prevFocus = document.activeElement;
  requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
  });
  const releaseTrap = trapFocus(drawer);

  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', () => close());
  drawer.querySelector('.js-drawer-close').addEventListener('click', () => close());

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    releaseTrap();
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('is-open');
    drawer.classList.remove('is-open');
    setTimeout(() => {
      overlay.remove();
      drawer.remove();
      document.body.style.overflow = '';
      prevFocus?.focus?.();
      onClose?.(result);
    }, 320);
  }
  ctx.setBody = (c) => set(bodyEl, c);
  ctx.setFooter = (c) => {
    footerEl.hidden = false;
    set(footerEl, c);
  };
  return ctx;
}

function set(el, content) {
  if (content == null) return;
  if (content instanceof Node) el.replaceChildren(content);
  else el.innerHTML = String(content);
}
