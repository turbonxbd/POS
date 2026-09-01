/**
 * settings-service.js - the merchant's Settings document (business, POS,
 * inventory, receipt/print, notifications, security).
 *
 * getSettings() is cached; the cache is refreshed on our own save AND dropped
 * when another tab or the server changes the settings row (cross-tab `storage`
 * event in mock mode, the /sync/changes poll in rest mode), so every panel -
 * cashier included - picks up a new print layout automatically, no reload.
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import bus from '../core/event-bus.js';

let cache = null;

export const settingsService = {
  async getSettings({ fresh = false } = {}) {
    if (cache && !fresh) return cache;
    cache = await http.get('/settings');
    return cache;
  },
  async updateSettings(patch) {
    requirePermission('settings.manage');
    cache = await http.put('/settings', patch);
    bus.emit('settings:changed', cache);
    return cache;
  },
  invalidate() {
    cache = null;
  },
};

// A change that came from OUTSIDE this tab (another tab's save, or the server).
// `db:external-change` never fires for our own writes, so no feedback loop.
bus.on('db:external-change', (names) => {
  const list = Array.isArray(names) ? names : names ? [names] : [];
  if (!list.includes('settings')) return;
  cache = null;
  settingsService.getSettings({ fresh: true })
    .then((s) => bus.emit('settings:changed', s))
    .catch(() => { /* offline - next getSettings() will refetch */ });
});

export default settingsService;
