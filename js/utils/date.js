/**
 * date.js - date range + formatting helpers (locale/timezone aware where practical).
 * All timestamps in the data layer are ISO 8601 strings (UTC).
 */

import config from '../config.js';

const LOCALE = config.locale.default;

export function now() {
  return new Date().toISOString();
}

export function parse(v) {
  // Always return a fresh Date so startOf*/endOf*/addDays never mutate the caller's value.
  if (v instanceof Date) return new Date(v.getTime());
  return new Date(v);
}

export function startOfDay(d = new Date()) {
  const x = parse(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function endOfDay(d = new Date()) {
  const x = parse(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
export function addDays(d, n) {
  const x = parse(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function startOfWeek(d = new Date()) {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - day);
  return x;
}
export function startOfMonth(d = new Date()) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}
export function startOfYear(d = new Date()) {
  const x = startOfDay(d);
  x.setMonth(0, 1);
  return x;
}

/**
 * Resolve a named preset to a {from, to} ISO range.
 * Presets: today, yesterday, this_week, last_week, this_month, last_month,
 *          this_year, last_7, last_30, all
 */
export function resolveRange(preset, custom) {
  const t = new Date();
  const wrap = (from, to) => ({ from: from.toISOString(), to: to.toISOString() });
  switch (preset) {
    case 'today':
      return wrap(startOfDay(t), endOfDay(t));
    case 'yesterday': {
      const y = addDays(t, -1);
      return wrap(startOfDay(y), endOfDay(y));
    }
    case 'this_week':
      return wrap(startOfWeek(t), endOfDay(t));
    case 'last_week': {
      const s = addDays(startOfWeek(t), -7);
      return wrap(s, endOfDay(addDays(s, 6)));
    }
    case 'this_month':
      return wrap(startOfMonth(t), endOfDay(t));
    case 'last_month': {
      const s = startOfMonth(t);
      s.setMonth(s.getMonth() - 1);
      const e = startOfMonth(t);
      e.setMilliseconds(-1);
      return wrap(s, e);
    }
    case 'this_year':
      return wrap(startOfYear(t), endOfDay(t));
    case 'last_7':
      return wrap(startOfDay(addDays(t, -6)), endOfDay(t));
    case 'last_30':
      return wrap(startOfDay(addDays(t, -29)), endOfDay(t));
    case 'custom':
      return {
        from: custom?.from ? startOfDay(custom.from).toISOString() : startOfMonth(t).toISOString(),
        to: custom?.to ? endOfDay(custom.to).toISOString() : endOfDay(t).toISOString(),
      };
    case 'all':
    default:
      return wrap(new Date(0), endOfDay(addDays(t, 1)));
  }
}

export const RANGE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'last_week', label: 'Last Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'custom', label: 'Custom Range' },
];

export function inRange(iso, range) {
  const t = parse(iso).getTime();
  return t >= parse(range.from).getTime() && t <= parse(range.to).getTime();
}

export function fmtDate(v, opts = { year: 'numeric', month: 'short', day: '2-digit' }) {
  if (!v) return '—';
  return new Intl.DateTimeFormat(LOCALE, opts).format(parse(v));
}
export function fmtTime(v) {
  if (!v) return '—';
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' }).format(parse(v));
}
export function fmtDateTime(v) {
  if (!v) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(parse(v));
}

export function fmtRelative(v) {
  if (!v) return '—';
  const diff = Date.now() - parse(v).getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const units = [
    ['year', 31536e6], ['month', 2592e6], ['week', 6048e5],
    ['day', 864e5], ['hour', 36e5], ['minute', 6e4], ['second', 1e3],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') return rtf.format(Math.round(-diff / ms), unit);
  }
  return 'just now';
}

/** Group timestamps into evenly spaced buckets for time-series charts. */
export function bucketDates(range, granularity = 'day') {
  const from = startOfDay(range.from);
  const to = parse(range.to);
  const buckets = [];
  const cur = new Date(from);
  const step = () => {
    if (granularity === 'month') cur.setMonth(cur.getMonth() + 1);
    else if (granularity === 'week') cur.setDate(cur.getDate() + 7);
    else if (granularity === 'hour') cur.setHours(cur.getHours() + 1);
    else cur.setDate(cur.getDate() + 1);
  };
  let guard = 0;
  while (cur <= to && guard++ < 5000) {
    buckets.push(new Date(cur));
    step();
  }
  return buckets;
}

export function isoDateKey(v) {
  return parse(v).toISOString().slice(0, 10);
}
