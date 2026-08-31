/**
 * dropdown.js - floating menu anchored to a trigger element.
 * openMenu(anchorEl, [{ label, icon, danger, disabled, onSelect }], { align })
 */
import { icon as renderIcon } from './icons.js';
import { escapeHtml, positionPopover } from '../utils/dom.js';

let openEl = null;

export function openMenu(anchor, items, { align = 'end' } = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items
    .map((it, i) => {
      if (it.separator) return '<div class="menu__sep"></div>';
      if (it.label && it.header) return `<div class="menu__label">${escapeHtml(it.label)}</div>`;
      return `<button class="menu__item ${it.danger ? 'menu__item--danger' : ''}" role="menuitem" data-i="${i}" ${it.disabled ? 'disabled style="opacity:.45;pointer-events:none"' : ''}>
        ${it.icon ? renderIcon(it.icon, { size: 16 }) : ''}<span>${escapeHtml(it.label)}</span>
      </button>`;
    })
    .join('');

  document.body.appendChild(menu);
  positionPopover(menu, anchor, { align });
  requestAnimationFrame(() => menu.classList.add('is-open'));
  openEl = menu;

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.menu__item');
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    closeMenu();
    item?.onSelect?.();
  });

  setTimeout(() => {
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
  }, 0);

  function outside(e) {
    if (!menu.contains(e.target) && e.target !== anchor) closeMenu();
  }
  function onKey(e) {
    if (e.key === 'Escape') closeMenu();
  }
  menu._cleanup = () => {
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
  };
  const first = menu.querySelector('.menu__item:not([disabled])');
  first?.focus();
  return { close: closeMenu };
}

export function closeMenu() {
  if (!openEl) return;
  openEl._cleanup?.();
  openEl.classList.remove('is-open');
  const el = openEl;
  openEl = null;
  setTimeout(() => el.remove(), 120);
}

/**
 * attachMenu(triggerEl, () => items) - convenience for a persistent trigger.
 */
export function attachMenu(trigger, itemsFn, opts) {
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openEl) {
      closeMenu();
      return;
    }
    openMenu(trigger, itemsFn(), opts);
  });
}
