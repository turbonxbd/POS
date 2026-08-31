/* eslint-env serviceworker */
/**
 * service-worker.js - offline shell caching (§34).
 *
 * Strategy:
 *  - App shell (HTML/CSS/JS/icons): stale-while-revalidate so the POS opens
 *    instantly and updates in the background.
 *  - Navigation requests: network-first with cached fallback (so a reload while
 *    offline still opens the terminal).
 *  - API calls (mock mode has none; rest mode /api or config.baseUrl): never
 *    cached here — offline writes are handled by js/core/sync-queue.js, which
 *    queues sales with an idempotency key and replays them on reconnect. The SW
 *    never returns stale API data, so it can't overwrite newer server records.
 */

const VERSION = 'pos-txbd-v5';
const SHELL_CACHE = `${VERSION}-shell`;

// Relative paths — the app runs unchanged from a domain root or a sub-path.
const SHELL_ASSETS = [
  'index.html', 'portal.html', 'login.html', 'admin.html', 'cashier.html', 'superadmin.html',
  'manifest.webmanifest',
  'css/reset.css', 'css/tokens.css', 'css/base.css', 'css/components.css',
  'css/layout.css', 'css/admin.css', 'css/cashier.css', 'css/responsive.css',
  'css/print.css', 'css/portal.css', 'css/live.css', 'css/superadmin.css',
  'js/config.js', 'js/core/i18n.js', 'js/data/i18n-bn.js', 'js/components/lang-switch.js',
  'js/app-live.js', 'js/app-portal.js', 'js/app-login.js', 'js/app-admin.js', 'js/app-cashier.js', 'js/app-superadmin.js',
  'assets/logos/favicon.svg', 'assets/logos/afia-mark.svg', 'assets/logos/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {})).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return /\/api\//.test(url.pathname) || url.pathname.endsWith('/v1') || /\/(sales|products|inventory|purchases)(\/|$)/.test(url.pathname) && url.origin !== location.origin;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never intercept cross-origin API traffic or dynamic data endpoints.
  if (url.origin !== self.location.origin || isApiRequest(url)) return;

  // Navigation: network-first, fall back to cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('index.html'))),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Allow the app to trigger an immediate update.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
