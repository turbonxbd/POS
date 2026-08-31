/**
 * i18n.js - whole-interface translation without touching every source string.
 *
 * How it works: the UI is built from English template strings. After each
 * render we walk the DOM and swap visible text (and placeholder / title /
 * aria-label / data-tooltip attributes) against a Bangla dictionary keyed by the
 * English source. Unknown strings (product names, customer names, invoice
 * numbers, …) are left exactly as-is, so data is never mistranslated.
 *
 * A MutationObserver keeps modals, drawers, toasts and lazily-rendered tables
 * translated. The choice persists in localStorage and is re-applied on boot.
 */

import config from '../config.js';
import bus from './event-bus.js';
import { BN } from '../data/i18n-bn.js';

const PREF_KEY = config.storage.prefsKey;
export const LANGS = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'bn', label: 'বাংলা', short: 'বাং' },
];

let lang = 'en';
let dict = {};
let patterns = [];
let observer = null;
let scheduled = null;

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'CANVAS', 'SVG', 'PRE', 'TEXTAREA']);
const SKIP_CLASS = /\b(pos-amount|mono|tabular|barcode-svg|no-i18n)\b/;
const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tooltip', 'alt'];

/* ------------------------------------------------------------- lookup */

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** Translate one already-collapsed string. Returns null if no translation. */
function lookup(key) {
  if (!key) return null;
  if (dict[key] != null) return dict[key];
  const lower = key.toLowerCase();
  if (dict[lower] != null) return dict[lower];
  for (const [re, repl] of patterns) {
    if (re.test(key)) return key.replace(re, repl);
  }
  return null;
}

/** Public: translate a bare string (for JS that builds strings dynamically). */
export function t(s) {
  if (lang === 'en' || s == null) return s;
  const str = String(s);
  const hit = lookup(collapse(str));
  return hit == null ? str : hit;
}

export function getLang() {
  return lang;
}

/* ------------------------------------------------------------- DOM walk */

function translateTextNode(node) {
  const raw = node.nodeValue;
  if (!raw || !raw.trim()) return;
  // remember the original English once
  if (node.__i18n === undefined) node.__i18n = raw;
  const source = node.__i18n;

  if (lang === 'en') {
    if (node.nodeValue !== source) node.nodeValue = source;
    return;
  }
  const lead = source.match(/^\s*/)[0];
  const trail = source.match(/\s*$/)[0];
  const hit = lookup(collapse(source));
  const next = hit == null ? source : lead + hit + trail;
  if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttrs(el) {
  for (const attr of ATTRS) {
    if (!el.hasAttribute(attr)) continue;
    const store = (el.__i18nAttr ||= {});
    if (store[attr] === undefined) store[attr] = el.getAttribute(attr);
    const source = store[attr];
    if (!source || !source.trim()) continue;
    if (lang === 'en') {
      if (el.getAttribute(attr) !== source) el.setAttribute(attr, source);
      continue;
    }
    const hit = lookup(collapse(source));
    if (hit != null && el.getAttribute(attr) !== hit) el.setAttribute(attr, hit);
  }
}

function shouldSkip(el) {
  if (!el || SKIP_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute?.('data-no-i18n')) return true;
  const cls = el.getAttribute?.('class');
  return cls && SKIP_CLASS.test(cls);
}

export function translateTree(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) return translateTextNode(root);
  if (shouldSkip(root)) return;
  if (root.nodeType === Node.ELEMENT_NODE) translateAttrs(root);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return shouldSkip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) translateTextNode(n);
    else translateAttrs(n);
  }
}

/* ------------------------------------------------------------- observer */

function scheduleTranslate(nodes) {
  if (scheduled) return;
  scheduled = requestAnimationFrame(() => {
    scheduled = null;
    nodes.forEach((node) => {
      try {
        translateTree(node);
      } catch { /* ignore transient DOM */ }
    });
    nodes.clear();
  });
}

function startObserver() {
  if (observer) return;
  const pending = new Set();
  observer = new MutationObserver((mutations) => {
    if (lang === 'en') return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) pending.add(node);
      }
      if (m.type === 'characterData') pending.add(m.target);
      // a script re-set placeholder / title / aria-label imperatively
      if (m.type === 'attributes' && m.target) pending.add(m.target);
    }
    if (pending.size) scheduleTranslate(pending);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
}

/* ------------------------------------------------------------- apply */

let lastTitleOut = null;
/** Translate the document <title>, keeping the original for restore. */
function translateTitle() {
  const el = document.querySelector('title');
  if (!el) return;
  const cur = el.textContent;
  // the router rewrites the title on every route — if it doesn't match what we
  // last produced, the router just set a fresh English source.
  if (cur !== lastTitleOut) el.__i18n = cur;
  const src = el.__i18n || cur;
  if (lang === 'en') {
    if (cur !== src) el.textContent = src;
    lastTitleOut = src;
    return;
  }
  const next = src.replace(/^([^·|—-]+?)(\s*[·|—-].*)?$/, (whole, head, tail) => {
    const hit = lookup(collapse(head));
    return (hit == null ? head.trim() : hit) + (tail || '');
  });
  if (cur !== next) el.textContent = next;
  lastTitleOut = next;
}

export function applyLang(next) {
  lang = LANGS.some((l) => l.code === next) ? next : 'en';
  document.documentElement.setAttribute('lang', lang);
  document.documentElement.classList.toggle('lang-bn', lang === 'bn');
  try {
    const prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    prefs.lang = lang;
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch { /* storage disabled */ }
  translateTree(document.body);
  translateTitle();
  bus.emit('lang:changed', lang);
}

export function toggleLang() {
  applyLang(lang === 'bn' ? 'en' : 'bn');
}

export function initI18n() {
  dict = BN.strings || {};
  patterns = (BN.patterns || []).map(([re, repl]) => [re instanceof RegExp ? re : new RegExp(re), repl]);
  let saved = 'en';
  try {
    saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}').lang || 'en';
  } catch { /* ignore */ }
  startObserver();
  applyLang(saved);
  bus.on('router:after', () => {
    if (lang === 'en') return;
    translateTree(document.body);
    translateTitle();
  });
  bus.on('lang:changed', () => translateTitle());
}

export default { t, applyLang, toggleLang, getLang, initI18n, translateTree, LANGS };
