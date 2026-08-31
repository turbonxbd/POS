/**
 * money.js - reliable currency math.
 *
 * RULE: money is stored and computed as INTEGER MINOR UNITS (e.g. paisa).
 * Never do floating-point arithmetic on financial values. All helpers here take
 * and return integers except `toMajor`/`format` which are display-only.
 *
 * A "Money" in this codebase is simply a JS integer (number) of minor units.
 */

import config from '../config.js';

const MINOR = config.locale.currencyMinorUnits;
const FACTOR = Math.pow(10, MINOR);

/** Parse a user/major-unit value ("1,250.50" or 1250.5) -> integer minor units. */
export function toMinor(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') {
    return Math.round(value * FACTOR);
  }
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * FACTOR);
}

/** Integer minor units -> major-unit number (for inputs / calc display only). */
export function toMajor(minor) {
  return (Number(minor) || 0) / FACTOR;
}

export const zero = 0;

export function add(...vals) {
  return vals.reduce((s, v) => s + Math.trunc(v || 0), 0);
}

export function sub(a, b) {
  return Math.trunc(a || 0) - Math.trunc(b || 0);
}

/** Multiply money by a plain quantity/number, banker-safe rounding to integer. */
export function mul(minor, factor) {
  return Math.round((Math.trunc(minor || 0) * Number(factor || 0)));
}

/** money * (percent/100), rounded half-up. */
export function percent(minor, pct) {
  return Math.round((Math.trunc(minor || 0) * Number(pct || 0)) / 100);
}

/** Divide money into `n` parts whose sum exactly equals the original. */
export function allocate(minor, n) {
  const total = Math.trunc(minor || 0);
  const count = Math.max(1, Math.trunc(n));
  const base = Math.trunc(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < Math.abs(remainder) ? Math.sign(remainder) : 0));
}

/**
 * Split a total across weighted line items so the parts sum to the total
 * (largest-remainder method). Used to distribute a cart-level discount across
 * lines for accurate per-line tax + reporting.
 */
export function distribute(total, weights) {
  const t = Math.trunc(total || 0);
  const sumW = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (sumW <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (t * Math.max(0, w)) / sumW);
  const floored = raw.map((r) => Math.floor(r));
  let left = t - floored.reduce((s, v) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && left > 0; k++, left--) floored[order[k].i] += 1;
  return floored;
}

export function clampNonNegative(minor) {
  return Math.max(0, Math.trunc(minor || 0));
}

export function eq(a, b) {
  return Math.trunc(a || 0) === Math.trunc(b || 0);
}

/**
 * Display format: 1234500 -> "৳ 12,345" ; 1234567 -> "৳ 12,345.67".
 * The fractional part (poisha) is hidden when it is zero and shown only when a
 * value actually has poisha - calculations always run on the full integer.
 * Pass `forceFraction: true` for contexts that need a fixed 2-dp column.
 */
export function format(minor, { withSymbol = true, symbol = config.locale.currencySymbol, forceFraction = false } = {}) {
  const neg = (minor || 0) < 0;
  const abs = Math.abs(Math.trunc(minor || 0));
  const major = Math.trunc(abs / FACTOR);
  const fracVal = abs % FACTOR;
  const frac = String(fracVal).padStart(MINOR, '0');
  const grouped = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = MINOR > 0 && (forceFraction || fracVal !== 0) ? `${grouped}.${frac}` : grouped;
  return `${neg ? '-' : ''}${withSymbol ? symbol + ' ' : ''}${body}`;
}

/** Plain numeric string without symbol/grouping ("12345.67") for CSV/inputs. */
export function toPlain(minor) {
  const abs = Math.abs(Math.trunc(minor || 0));
  const sign = (minor || 0) < 0 ? '-' : '';
  if (MINOR === 0) return sign + String(abs);
  return `${sign}${Math.trunc(abs / FACTOR)}.${String(abs % FACTOR).padStart(MINOR, '0')}`;
}

export default {
  toMinor, toMajor, zero, add, sub, mul, percent, allocate, distribute,
  clampNonNegative, eq, format, toPlain,
};
