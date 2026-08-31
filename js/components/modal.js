/**
 * modal.js - accessible modal dialog.
 *
 * openModal({ title, subtitle, body, size, footer, onClose, closeOnBackdrop })
 *   body / footer: HTML string OR Node OR (ctx) => string|Node
 *   returns { close, el, setBusy, setBody, setFooter }
 * Focus is trapped; ESC and backdrop close; body scroll locked; returns focus.
 */
import { icon } from './icons.js';
import { escapeHtml, trapFocus } from '../utils/dom.js';

const stack = [];

export function openModal(opts = {}) {
  const {
    title = '', subtitle = '', body = '', footer = null, size = 'md',
    closeOnBackdrop = true, closeOnEsc = true, onClose, dismissible = true,
  } = opts;

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.setAttribute('role', 'presentation');

  const modal = document.createElement('div');
  modal.className = `modal modal--${size}`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  if (title) modal.setAttribute('aria-label', title);

  modal.innerHTML = `
    ${title || dismissible ? `
    <div class="modal__header">
      <div>
        ${title ? `<h2>${escapeHtml(title)}</h2>` : ''}
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${dismissible ? `<button class="modal__close js-modal-close" aria-label="Close dialog">${icon('x', { size: 18 })}</button>` : ''}
    </div>` : ''}
    <div class="modal__body js-modal-body"></div>
    <div class="modal__footer js-modal-footer" hidden></div>`;

  overlay.appendChild(modal);

  const ctx = { close, el: modal, overlay };
  const bodyEl = modal.querySelector('.js-modal-body');
  const footerEl = modal.querySelector('.js-modal-footer');

  setContent(bodyEl, typeof body === 'function' ? body(ctx) : body);
  if (footer) {
    footerEl.hidden = false;
    setContent(footerEl, typeof footer === 'function' ? footer(ctx) : footer);
  }

  const prevFocus = document.activeElement;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => overlay.classList.add('is-open'));

  const releaseTrap = trapFocus(modal);
  const firstField = modal.querySelector('input,select,textarea,button:not(.js-modal-close)');
  setTimeout(() => (firstField || modal.querySelector('.js-modal-close') || modal).focus?.(), 60);

  function onKey(e) {
    if (e.key === 'Escape' && closeOnEsc && dismissible && stack[stack.length - 1] === ctx) {
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay && closeOnBackdrop && dismissible) close();
  });
  modal.querySelector('.js-modal-close')?.addEventListener('click', () => close());

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    releaseTrap();
    document.removeEventListener('keydown', onKey, true);
    overlay.classList.remove('is-open');
    const idx = stack.indexOf(ctx);
    if (idx >= 0) stack.splice(idx, 1);
    setTimeout(() => {
      overlay.remove();
      if (!stack.length) document.body.style.overflow = '';
      prevFocus?.focus?.();
    }, 200);
    onClose?.(result);
  }

  ctx.setBusy = (busy) => {
    modal.querySelectorAll('button, input, select, textarea').forEach((n) => (n.disabled = !!busy));
    modal.style.pointerEvents = busy ? 'none' : '';
    modal.style.opacity = busy ? '0.7' : '';
  };
  ctx.setBody = (content) => setContent(bodyEl, content);
  ctx.setFooter = (content) => {
    footerEl.hidden = false;
    setContent(footerEl, content);
  };
  ctx.$ = (sel) => modal.querySelector(sel);
  ctx.$$ = (sel) => [...modal.querySelectorAll(sel)];

  stack.push(ctx);
  return ctx;
}

function setContent(el, content) {
  if (content == null) return;
  if (content instanceof Node) el.replaceChildren(content);
  else el.innerHTML = String(content);
}

export function closeAllModals() {
  [...stack].forEach((m) => m.close());
}
