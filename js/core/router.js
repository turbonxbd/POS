/**
 * router.js - hash-based client router.
 *
 * Routes are registered with a path pattern ('/products/:id'), an async
 * handler that returns/renders a view, and optional { permission, title }.
 * A route guard denies navigation when the current user lacks the permission
 * and the router renders a 403 view instead - navigation is not merely hidden.
 */

import bus from './event-bus.js';
import config from '../config.js';

export class Router {
  #routes = [];
  #outlet = null;
  #notFound = null;
  #forbidden = null;
  #guard = null;
  #current = null;
  #beforeEach = [];

  constructor({ outlet } = {}) {
    this.#outlet = outlet || null;
  }

  setOutlet(el) {
    this.#outlet = el;
    return this;
  }

  /** guard: (route) => true | false ; used for permission checks */
  setGuard(fn) {
    this.#guard = fn;
    return this;
  }

  setNotFound(handler) {
    this.#notFound = handler;
    return this;
  }
  setForbidden(handler) {
    this.#forbidden = handler;
    return this;
  }
  beforeEach(fn) {
    this.#beforeEach.push(fn);
    return this;
  }

  add(path, handler, meta = {}) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        path
          .replace(/\//g, '\\/')
          .replace(/:(\w+)/g, (_, k) => {
            keys.push(k);
            return '([^\\/]+)';
          })
          .replace(/\*/g, '.*') +
        '$',
    );
    this.#routes.push({ path, regex, keys, handler, meta });
    return this;
  }

  match(pathname) {
    for (const route of this.#routes) {
      const m = route.regex.exec(pathname);
      if (m) {
        const params = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route, params };
      }
    }
    return null;
  }

  current() {
    return this.#current;
  }

  parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [pathname, queryStr = ''] = raw.split('?');
    const query = Object.fromEntries(new URLSearchParams(queryStr));
    return { pathname: pathname || '/', query, hash: raw };
  }

  navigate(to, { replace = false } = {}) {
    const target = to.startsWith('#') ? to : '#' + to;
    if (replace) location.replace(target);
    else location.hash = target;
  }

  async resolve() {
    const { pathname, query } = this.parseHash();
    const matched = this.match(pathname);

    const ctx = { pathname, query, params: matched?.params || {}, meta: matched?.route.meta || {} };

    for (const fn of this.#beforeEach) {
      const res = await fn(ctx);
      if (res === false) return;
      if (typeof res === 'string') {
        this.navigate(res, { replace: true });
        return;
      }
    }

    if (!matched) {
      this.#renderView(this.#notFound, ctx, 'Not found');
      return;
    }

    if (matched.route.meta.permission && this.#guard && !this.#guard(matched.route)) {
      bus.emit('router:forbidden', ctx);
      this.#renderView(this.#forbidden, ctx, 'Access denied');
      return;
    }

    this.#current = { ...ctx, path: matched.route.path };
    bus.emit('router:before', this.#current);
    document.title = matched.route.meta.title
      ? `${matched.route.meta.title} · ${config.app.name}`
      : config.app.name;
    try {
      await this.#renderView(matched.route.handler, ctx);
      bus.emit('router:after', this.#current);
    } catch (err) {
      console.error('[router] view error', err);
      bus.emit('router:error', { ctx, err });
      if (this.#outlet) {
        this.#outlet.innerHTML = `<div class="page"><div class="alert alert--danger"><div class="alert__body"><div class="alert__title">This page failed to load</div>${escapeText(
          err.message,
        )}</div></div></div>`;
      }
    }
  }

  async #renderView(handler, ctx, fallbackTitle) {
    if (!handler) {
      if (this.#outlet) this.#outlet.innerHTML = `<div class="page"><h1>${fallbackTitle || 'Not found'}</h1></div>`;
      return;
    }
    const result = await handler(ctx, this.#outlet);
    if (this.#outlet && result != null && result !== this.#outlet) {
      if (typeof result === 'string') this.#outlet.innerHTML = result;
      else if (result instanceof Node) this.#outlet.replaceChildren(result);
    }
    this.#outlet?.scrollTo?.({ top: 0 });
  }

  start() {
    addEventListener('hashchange', () => this.resolve());
    this.resolve();
    return this;
  }
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

export default Router;
