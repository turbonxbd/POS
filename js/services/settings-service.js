/**
 * settings-service.js
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

export default settingsService;
