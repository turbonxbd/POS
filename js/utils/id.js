/**
 * id.js - identifier generation.
 * - uuid(): RFC-4122 v4 (crypto-backed) for entity primary keys & idempotency.
 * - shortId(): compact human-referable code.
 * - sequence formatting helpers for invoice / document numbers.
 */

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback (older browsers)
  const buf = new Uint8Array(16);
  (crypto || window.crypto).getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = [...buf].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion

export function shortId(len = 8) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Zero-pad a running number: pad(7, 5) -> "00007" */
export function pad(num, width = 5) {
  return String(num).padStart(width, '0');
}

/**
 * Format a document number from a template.
 * tokens: {PREFIX} {BR} {YYYY} {YY} {MM} {DD} {SEQ}
 */
export function formatDocNo(template, { prefix = '', branchCode = '', seq = 1, seqWidth = 5, date = new Date() } = {}) {
  const y = date.getFullYear();
  return template
    .replace('{PREFIX}', prefix)
    .replace('{BR}', branchCode)
    .replace('{YYYY}', String(y))
    .replace('{YY}', String(y).slice(-2))
    .replace('{MM}', pad(date.getMonth() + 1, 2))
    .replace('{DD}', pad(date.getDate(), 2))
    .replace('{SEQ}', pad(seq, seqWidth))
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Deterministic SKU suggestion from a name + optional variant tokens. */
export function suggestSku(name, tokens = []) {
  const base = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((w) => w.slice(0, 3))
    .join('-');
  const tail = tokens
    .filter(Boolean)
    .map((t) => String(t).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))
    .join('-');
  return [base || 'ITEM', tail, shortId(4)].filter(Boolean).join('-');
}

/**
 * EAN-13 barcode generator with valid check digit.
 * Uses a "200" internal prefix range (reserved for in-store use).
 */
export function generateEan13(seed) {
  // 9-digit body after the "200" in-store prefix. Use the LEAST-significant
  // digits of the seed (they actually vary between calls) mixed with entropy,
  // so two products created seconds apart never collide.
  const rnd = Math.floor(Math.random() * 1e9);
  let n;
  if (seed != null && Number.isFinite(+seed)) {
    const s = String(Math.abs(Math.trunc(+seed))).replace(/\D/g, '');
    n = (s.slice(-6) + String(rnd).padStart(9, '0').slice(-3)).slice(-9);
  } else {
    n = String(rnd).padStart(9, '0');
  }
  let base = '200' + n.padStart(9, '0').slice(0, 9);
  base = base.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

export function isValidEan13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}
