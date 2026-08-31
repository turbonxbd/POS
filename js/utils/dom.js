/**
 * dom.js - tiny DOM toolkit (no framework).
 * - h(): hyperscript element creation with safe text handling.
 * - html: tagged template that ESCAPES interpolations by default (XSS-safe).
 * - use `raw()` to opt a trusted fragment out of escaping.
 * - $ / $$ / on (delegation) / clear / mount helpers.
 */

export function $(sel, root = document) {
  return root.querySelector(sel);
}
export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

const RAW = Symbol('raw-html');
export function raw(str) {
  return { [RAW]: String(str == null ? '' : str) };
}
export function isRaw(v) {
  return v && typeof v === 'object' && RAW in v;
}

/**
 * html`` - build an HTML string with automatic escaping of interpolations.
 * Arrays are joined; raw() values pass through untouched.
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += serialize(values[i]) + strings[i + 1];
  }
  return out;
}
function serialize(v) {
  if (v == null || v === false) return '';
  if (isRaw(v)) return v[RAW];
  if (Array.isArray(v)) return v.map(serialize).join('');
  return escapeHtml(v);
}

/**
 * h('div.card#id', { onClick, dataset, attrs }, ...children)
 * children: strings (text nodes), Nodes, or arrays thereof.
 */
export function h(tagSpec, props = {}, ...children) {
  const [tag, ...rest] = tagSpec.split(/(?=[.#])/);
  const el = document.createElement(tag || 'div');
  for (const token of rest) {
    if (token[0] === '.') el.classList.add(token.slice(1));
    else if (token[0] === '#') el.id = token.slice(1);
  }
  for (const [key, val] of Object.entries(props || {})) {
    if (val == null || val === false) continue;
    if (key === 'class' || key === 'className') el.className += (el.className ? ' ' : '') + val;
    else if (key === 'dataset') Object.assign(el.dataset, val);
    else if (key === 'style' && typeof val === 'object') Object.assign(el.style, val);
    else if (key === 'html') el.innerHTML = val; // caller responsible; prefer text
    else if (key === 'text') el.textContent = val;
    else if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === 'ref' && typeof val === 'function') val(el);
    else if (val === true) el.setAttribute(key, '');
    else el.setAttribute(key, val);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;
    if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

/** Parse an HTML string into a DocumentFragment (string must be trusted/escaped). */
export function fragment(htmlStr) {
  const tpl = document.createElement('template');
  tpl.innerHTML = htmlStr;
  return tpl.content;
}

/** Replace the contents of `root` with `content` (string | Node | Fragment). */
export function render(root, content) {
  root.replaceChildren();
  if (content == null) return root;
  if (typeof content === 'string') root.append(fragment(content));
  else root.append(content);
  return root;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function mount(root, node) {
  root.appendChild(node);
  return node;
}

/** Event delegation: on(list, 'click', '.js-edit', (ev, matchedEl) => {}) */
export function on(root, type, selector, handler, opts) {
  const listener = (ev) => {
    const target = ev.target.closest(selector);
    if (target && root.contains(target)) handler(ev, target);
  };
  root.addEventListener(type, listener, opts);
  return () => root.removeEventListener(type, listener, opts);
}

/** Toggle a class and return the new state. */
export function toggleClass(el, cls, force) {
  return el.classList.toggle(cls, force);
}

/** Focus trap for modals/drawers. Returns a release() fn. */
export function trapFocus(container) {
  const selector =
    'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function handle(e) {
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll(selector)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  container.addEventListener('keydown', handle);
  return () => container.removeEventListener('keydown', handle);
}

/** Position an absolutely-positioned popover near an anchor, kept in viewport. */
export function positionPopover(popover, anchor, { align = 'start', gap = 6 } = {}) {
  const a = anchor.getBoundingClientRect();
  const p = popover.getBoundingClientRect();
  let top = a.bottom + gap;
  let left = align === 'end' ? a.right - p.width : a.left;
  if (top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - gap);
  if (left + p.width > window.innerWidth - 8) left = window.innerWidth - p.width - 8;
  if (left < 8) left = 8;
  popover.style.position = 'fixed';
  popover.style.top = `${Math.round(top)}px`;
  popover.style.left = `${Math.round(left)}px`;
}
