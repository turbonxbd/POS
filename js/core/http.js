/**
 * http.js - the ONLY transport the service layer knows about.
 *
 * mode 'mock'  -> dispatches to mock-server.js (in-process, localStorage-backed)
 * mode 'rest'  -> real fetch() to config.api.baseUrl with credentials + CSRF
 *
 * Services call http.get('/products', { params }) etc. and never change when the
 * backend is swapped in. Errors are normalised to HttpError { status, message,
 * data } so the UI can render consistent error / retry states.
 */

import config from '../config.js';
import { sleep } from '../utils/debounce.js';
import bus from './event-bus.js';

export class HttpError extends Error {
  constructor(status, message, data) {
    super(message || `Request failed (${status})`);
    this.name = 'HttpError';
    this.status = status;
    this.data = data || null;
  }
}

let mockHandler = null;
/** mock-server registers itself here to avoid a circular import at module load. */
export function registerMockHandler(fn) {
  mockHandler = fn;
}

function buildQuery(params) {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => usp.append(k, item));
    else usp.append(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

let inFlight = 0;
function begin() {
  if (inFlight++ === 0) bus.emit('http:busy', true);
}
function end() {
  if (--inFlight <= 0) {
    inFlight = 0;
    bus.emit('http:busy', false);
  }
}

async function request(method, path, { params, body, headers, signal } = {}) {
  begin();
  try {
    if (config.api.mode === 'mock') {
      return await mockRequest(method, path, { params, body });
    }
    return await restRequest(method, path, { params, body, headers, signal });
  } finally {
    end();
  }
}

async function mockRequest(method, path, { params, body }) {
  if (!mockHandler) throw new HttpError(500, 'Mock server not initialised');
  if (config.api.mockLatencyMs) {
    await sleep(config.api.mockLatencyMs + Math.random() * config.api.mockLatencyMs * 0.4);
  }
  let result;
  try {
    result = await mockHandler({ method, path, query: params || {}, body: body ?? null });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err && err.status && err.name && /Error$/.test(err.name)) {
      throw new HttpError(err.status, err.message, err.errors || err.data || null);
    }
    console.error('[http:mock] unhandled error', err);
    throw new HttpError(500, err?.message || 'Internal error');
  }
  const { status = 200, data = null } = result || {};
  if (status >= 400) throw new HttpError(status, data?.message || 'Request failed', data);
  return data;
}

async function restRequest(method, path, { params, body, headers, signal }) {
  const url = config.api.baseUrl + path + buildQuery(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.api.timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      credentials: config.api.withCredentials ? 'include' : 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...readCsrf(),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal || controller.signal,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw new HttpError(res.status, data?.message || res.statusText, data);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new HttpError(408, 'The request timed out');
    if (err instanceof HttpError) throw err;
    throw new HttpError(0, 'Network connection lost', null);
  } finally {
    clearTimeout(timer);
  }
}

function readCsrf() {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? { [config.api.csrfHeader]: decodeURIComponent(m[1]) } : {};
}
function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export const http = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),
  raw: request,
};

export default http;
