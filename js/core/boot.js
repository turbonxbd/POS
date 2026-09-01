/**
 * boot.js - shared startup used by every entry point (login/admin/cashier).
 * Initialises the mock backend, ensures the local DB has data, applies the
 * saved theme, registers the service worker, and starts the sync queue.
 */

import config from '../config.js';
import db from './db.js';
import store from './store.js';
import bus from './event-bus.js';
import { initMockServer } from './mock-server.js';
import syncQueue from './sync-queue.js';
import { seedDemo, ensurePlatform } from '../data/seed.js';
import { initI18n } from './i18n.js';

/* ---- theme ---- */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  store.set({ theme });
  store.persistPrefs(['theme']);
  bus.emit('theme:changed', theme);
}

export function toggleTheme() {
  const cur = store.get('theme');
  const isDark = cur === 'dark' || (cur === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  applyTheme(isDark ? 'light' : 'dark');
}

/* ---- boot ---- */
let booted = null;

export function boot({ seedIfEmpty = true } = {}) {
  if (booted) return booted;
  booted = (async () => {
    applyTheme(store.get('theme') || 'system');
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (store.get('theme') === 'system') bus.emit('theme:changed', 'system');
    });

    if (config.api.mode === 'mock') {
      initMockServer();
      db.load();
      db.startCrossTabSync(); // adopt writes from other tabs (cashier <-> admin)
      // Self-heal: reseed if the store is empty OR was left incomplete by an
      // interrupted load (missing the core collections).
      const incomplete =
        !db.isEmpty &&
        (db.collection('users').count() === 0 ||
          db.collection('products').count() === 0 ||
          db.collection('roles').count() === 0);
      if (seedIfEmpty && (db.isEmpty || incomplete)) {
        if (incomplete) {
          console.warn('[boot] local data was incomplete - reseeding');
          db.reset();
        }
        await seedDemo(db);
        console.info('[boot] seeded demo dataset');
      } else if (!db.isEmpty) {
        await syncSystemRolePermissions();
        // Upgrade a DB seeded before the 5-panel platform: adds the merchant
        // row, plans + the Super Admin account if they are missing. No-op once
        // done, touches no existing data.
        if (await ensurePlatform(db)) console.info('[boot] upgraded local data for the 5-panel platform');
      }
    }

    syncQueue.start();
    if (config.api.mode === 'mock') {
      import('./backup-auto.js').then((m) => m.startAutoBackup()).catch(() => {});
    }
    registerServiceWorker();
    try {
      initI18n();
    } catch (err) {
      console.warn('[boot] i18n init failed', err);
    }
    // Full-screen "No Internet" block, on every panel.
    import('../components/net-guard.js').then((m) => m.startNetGuard()).catch(() => {});
    // Cross-device real-time: poll the server for what changed (rest mode only —
    // in mock the storage event already syncs the one browser).
    if (config.api.mode === 'rest') {
      import('./sync-poll.js').then((m) => m.startSyncPoll()).catch(() => {});
    }

    store.set({ bootReady: true });
    return true;
  })();
  return booted;
}

/**
 * Non-destructive: keep each system role's name/description/permissions in sync
 * with its preset (e.g. "Business Owner" -> "Branch Owner"), without touching
 * custom roles or removing anything.
 */
async function syncSystemRolePermissions() {
  try {
    const { ROLE_PRESETS } = await import('../data/permissions.js');
    const roles = db.collection('roles');
    let changed = 0;
    for (const preset of ROLE_PRESETS) {
      if (!preset.system) continue;
      const row = roles.get(preset.id)
        || roles.all().find((r) => r.system && (r.name === preset.name || r.id === preset.id));
      if (!row) continue;
      const patch = {};
      const merged = [...new Set([...(row.permissions || []), ...preset.permissions])];
      if (merged.length !== (row.permissions || []).length) patch.permissions = merged;
      if (row.name !== preset.name) patch.name = preset.name;
      if (preset.description && row.description !== preset.description) patch.description = preset.description;
      if (Object.keys(patch).length) { roles.update(row.id, patch); changed++; }
    }
    if (changed) console.info(`[boot] synced ${changed} system role(s)`);
  } catch (err) {
    console.warn('[boot] role sync skipped', err);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;

  if (!config.features.pwa) {
    // PWA disabled: make sure no stale worker keeps serving old cached modules.
    const hadController = !!navigator.serviceWorker.controller;
    Promise.all([
      navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister()))),
      window.caches ? caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))) : Promise.resolve(),
    ]).then(() => {
      // A worker was still serving this page from cache. Reload once (guarded)
      // so the browser fetches every module fresh from the server.
      if (hadController && !sessionStorage.getItem('afia_sw_flushed')) {
        sessionStorage.setItem('afia_sw_flushed', '1');
        location.reload();
      }
    });
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then((reg) => watchForUpdate(reg))
      .catch((err) => console.warn('[boot] service worker registration failed', err));
  });

  // When the fresh worker takes control, reload once so every module matches it.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

/**
 * Tell the user when a new build is waiting — never swap it in silently (a
 * mid-sale reload would be hostile, and the SW only touches static shell files
 * so merchant data is never involved).
 */
function watchForUpdate(reg) {
  const offer = (worker) => {
    import('../components/toast.js').then(({ toast }) => {
      toast.info('A new version of POS TXbd is ready.', {
        duration: 0,
        title: 'Update available',
        action: { label: 'Reload now', onClick: () => worker.postMessage('skipWaiting') },
      });
    });
  };

  if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);

  reg.addEventListener('updatefound', () => {
    const fresh = reg.installing;
    if (!fresh) return;
    fresh.addEventListener('statechange', () => {
      if (fresh.state === 'installed' && navigator.serviceWorker.controller) offer(fresh);
    });
  });
}

/* ---- global quota warning ---- */
bus.on('db:quota-exceeded', () => {
  import('../components/toast.js').then(({ toast }) =>
    toast.error('Local storage is full. Export a backup and reset demo data from Settings → Backup.', { duration: 9000 }),
  );
});

export default boot;
