/**
 * mock/router.js - minimal method+path router for the mock backend, plus
 * shared response helpers and list-query utilities (search / filter / sort /
 * paginate) so every collection endpoint behaves consistently.
 */

import { HttpError } from '../http.js';
import { getActor, isPlatformActor } from './context.js';

export function ok(data, status = 200) {
  return { status, data };
}
export function created(data) {
  return { status: 201, data };
}
export function noContent() {
  return { status: 204, data: null };
}
export function fail(status, message, extra) {
  return { status, data: { message, ...(extra || {}) } };
}

export function badRequest(message, errors) {
  throw new HttpError(422, message || 'Validation failed', { message, errors });
}
export function notFound(what = 'Resource') {
  throw new HttpError(404, `${what} not found`, { message: `${what} not found` });
}
export function conflict(message) {
  throw new HttpError(409, message, { message });
}

export class MockRouter {
  #routes = [];

  register(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/\/+$/, '')
          .replace(/\//g, '\\/')
          .replace(/:(\w+)/g, (_, k) => {
            keys.push(k);
            return '([^\\/]+)';
          }) +
        '\\/?$',
    );
    this.#routes.push({ method: method.toUpperCase(), regex, keys, handler });
    return this;
  }

  get(p, h) { return this.register('GET', p, h); }
  post(p, h) { return this.register('POST', p, h); }
  put(p, h) { return this.register('PUT', p, h); }
  patch(p, h) { return this.register('PATCH', p, h); }
  del(p, h) { return this.register('DELETE', p, h); }

  async handle({ method, path, query, body }) {
    const clean = path.split('?')[0].replace(/\/+$/, '') || '/';

    // Defence in depth: every /platform/* endpoint is Super-Admin-only, enforced
    // here regardless of whether an individual handler also checks. A merchant
    // (or unauthenticated) caller can never reach platform data through the API.
    if (clean.startsWith('/platform/')) {
      if (!getActor()) {
        throw new HttpError(401, 'Not authenticated', { message: 'Not authenticated' });
      }
      if (!isPlatformActor()) {
        throw new HttpError(403, 'Super Admin access required', { message: 'Super Admin access required' });
      }
    }

    for (const route of this.#routes) {
      if (route.method !== method.toUpperCase()) continue;
      const m = route.regex.exec(clean);
      if (!m) continue;
      const params = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const result = await route.handler({ params, query: query || {}, body: body ?? null, method, path: clean });
      return result || noContent();
    }
    throw new HttpError(404, `No mock route for ${method} ${clean}`, {
      message: `Endpoint ${method} ${clean} is not available`,
    });
  }
}

/* --------------------------------------------------------- list utilities */

/**
 * applyListQuery(rows, query, options)
 *  query: { search, sort, dir, page, pageSize, ...filters }
 *  options: { searchable: ['name','sku'], filters: { status:'status', ... },
 *            computed: { total: row => ... }, defaultSort }
 * returns { data, page, pageSize, total, totalPages, sort, dir }
 */
export function applyListQuery(rows, query = {}, options = {}) {
  let list = rows.slice();
  const {
    searchable = [],
    filters = {},
    sortable = null,
    defaultSort = 'createdAt',
    defaultDir = 'desc',
    accessors = {},
  } = options;

  // text search
  const q = String(query.search || query.q || '').trim().toLowerCase();
  if (q && searchable.length) {
    list = list.filter((row) =>
      searchable.some((field) => {
        const val = accessors[field] ? accessors[field](row) : row[field];
        return String(val ?? '').toLowerCase().includes(q);
      }),
    );
  }

  // equality / set filters
  for (const [param, field] of Object.entries(filters)) {
    const raw = query[param];
    if (raw == null || raw === '' || raw === 'all') continue;
    const values = String(raw).split(',');
    list = list.filter((row) => {
      const val = accessors[field] ? accessors[field](row) : row[field];
      return values.includes(String(val));
    });
  }

  // date range on a field
  if (options.dateField && (query.from || query.to)) {
    const from = query.from ? new Date(query.from).getTime() : -Infinity;
    const to = query.to ? new Date(query.to).getTime() : Infinity;
    list = list.filter((row) => {
      const t = new Date(row[options.dateField]).getTime();
      return t >= from && t <= to;
    });
  }

  const total = list.length;

  // sort
  let sort = query.sort || defaultSort;
  if (sortable && !sortable.includes(sort)) sort = defaultSort;
  const dir = (query.dir || defaultDir) === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const av = accessors[sort] ? accessors[sort](a) : a[sort];
    const bv = accessors[sort] ? accessors[sort](b) : b[sort];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
  });

  // paginate
  const pageSize = query.pageSize === 'all' ? total || 1 : Math.max(1, Number(query.pageSize) || 20);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number(query.page) || 1), totalPages);
  const data = list.slice((page - 1) * pageSize, page * pageSize);

  const out = { data, page, pageSize, total, totalPages, sort, dir: dir === 1 ? 'asc' : 'desc' };
  // `summarize(fullFilteredList)` lets a list endpoint return stat-strip figures
  // computed over the WHOLE filtered set, not just the current page.
  if (typeof options.summarize === 'function') out.summary = options.summarize(list);
  return out;
}
