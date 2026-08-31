/**
 * format.js - display formatting for non-money values.
 */

import config from '../config.js';

const LOCALE = config.locale.default;

export function num(v, { decimals = 0 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export function compactNum(v) {
  const n = Number(v) || 0;
  return new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function pct(v, decimals = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0%';
  return `${n.toFixed(decimals).replace(/\.0+$/, '')}%`;
}

export function qty(v) {
  const n = Number(v) || 0;
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

export function titleCase(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
}

export function truncate(s, len = 40) {
  s = String(s || '');
  return s.length > len ? s.slice(0, len - 1) + '…' : s;
}

export function phone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('01')) {
    return `${digits.slice(0, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return p || '—';
}

export function fileSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = b / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

/** Return a stable HSL color for a string (category tags, avatars). */
export function stringColor(str) {
  let hash = 0;
  for (let i = 0; i < String(str).length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 62% 45%)`;
}

const STATUS_MAP = {
  active: { label: 'Active', variant: 'success' },
  inactive: { label: 'Inactive', variant: 'neutral' },
  archived: { label: 'Archived', variant: 'neutral' },
  draft: { label: 'Draft', variant: 'neutral' },
  ordered: { label: 'Ordered', variant: 'info' },
  received: { label: 'Received', variant: 'success' },
  partial: { label: 'Partially Received', variant: 'warning' },
  partially_received: { label: 'Partially Received', variant: 'warning' },
  cancelled: { label: 'Cancelled', variant: 'danger' },
  completed: { label: 'Completed', variant: 'success' },
  paid: { label: 'Paid', variant: 'success' },
  unpaid: { label: 'Unpaid', variant: 'danger' },
  due: { label: 'Due', variant: 'warning' },
  refunded: { label: 'Refunded', variant: 'danger' },
  partially_refunded: { label: 'Partially Refunded', variant: 'warning' },
  held: { label: 'Held', variant: 'warning' },
  open: { label: 'Open', variant: 'success' },
  closed: { label: 'Closed', variant: 'neutral' },
  in_stock: { label: 'In Stock', variant: 'success' },
  low_stock: { label: 'Low Stock', variant: 'warning' },
  out_of_stock: { label: 'Out of Stock', variant: 'danger' },
  pending: { label: 'Pending', variant: 'warning' },
  synced: { label: 'Synced', variant: 'success' },
  queued: { label: 'Queued', variant: 'warning' },
  conflict: { label: 'Conflict', variant: 'danger' },
};

export function statusMeta(status) {
  return STATUS_MAP[status] || { label: titleCase(status || 'Unknown'), variant: 'neutral' };
}
