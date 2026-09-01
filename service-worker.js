/* eslint-env serviceworker */
/**
 * service-worker.js - installable-app shell cache.
 *
 * Strategy:
 *  - Navigations (the .html entry points): network-first, fall back to the
 *    cached shell so the app still opens with no connection.
 *  - Static assets (css / js / fonts / icons / manifest): stale-while-revalidate
 *    so the app opens instantly and the newest files land in the background.
 *  - EVERYTHING ELSE (any API / data call — /api/*, /sync/*, /auth/*, cross
 *    origin): not touched. The SW never returns stale server data, so it can
 *    never overwrite a newer record; offline writes are the sync-queue's job.
 *
 * Bump VERSION on every deploy — activate() drops all older caches, and the app
 * shows a "new version" prompt when a fresh worker is waiting.
 */

// v7: print pipeline overhaul - @page A4-fallback fix, orientation remap to the
// printer's convention, die-cut label gap, fitReceiptPage, cross-tab settings
// freshness. Installed apps MUST drop the old cache to pick these up.
const VERSION = 'pos-txbd-v7';
const SHELL_CACHE = `${VERSION}-shell`;

// Enough of the boot chain to open offline; lazy page modules cache on first use.
const SHELL_ASSETS = [
  'portal.html', 'index.html', 'login.html', 'admin.html', 'cashier.html',
  'manifest.webmanifest',
  'css/reset.css', 'css/tokens.css', 'css/base.css', 'css/components.css',
  'css/layout.css', 'css/admin.css', 'css/cashier.css', 'css/responsive.css',
  'css/print.css', 'css/portal.css', 'css/live.css', 'css/superadmin.css',
  'js/config.js', 'js/core/boot.js', 'js/core/db.js', 'js/core/store.js',
  'js/core/event-bus.js', 'js/core/http.js', 'js/core/session.js', 'js/core/router.js',
  'js/core/i18n.js', 'js/data/i18n-bn.js', 'js/components/lang-switch.js',
  'js/components/net-guard.js', 'js/core/sync-poll.js', 'js/core/sync-queue.js',
  // print pipeline - kept in the shell so it is always current in the installed app
  'js/core/print-config.js', 'js/utils/print.js',
  'js/pages/shared/receipt.js', 'js/pages/shared/barcode-label.js',
  'js/services/settings-service.js',
  'js/app-live.js', 'js/app-portal.js', 'js/app-login.js', 'js/app-admin.js', 'js/app-cashier.js',
  'assets/logos/favicon.svg', 'assets/logos/icon.svg',
  'assets/logos/icon-192.png', 'assets/logos/icon-512.png', 'assets/logos/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only these are safe to cache; anything else is a passthrough.
const CACHEABLE = /\.(?:css|js|mjs|json|webmanifest|svg|png|jpe?g|gif|ico|woff2?)$/i;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('portal.html') || caches.match('index.html'))),
    );
    return;
  }

  if (!CACHEABLE.test(url.pathname)) return; // API / data / anything dynamic — leave it alone

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

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
