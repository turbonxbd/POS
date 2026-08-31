/**
 * backup-service.js - export / import / reset the local dataset.
 * In 'rest' mode these map to server backup endpoints; the demo also re-seeds
 * client-side because the mock DB lives in the browser.
 */
import http from '../core/http.js';
import config from '../config.js';
import { requirePermission } from '../core/rbac.js';
import db from '../core/db.js';
import bus from '../core/event-bus.js';
import { seedDemo, seedBlank } from '../data/seed.js';

export const backupService = {
  async exportData() {
    requirePermission('backup.manage');
    const data = await http.get('/backup/export');
    return {
      exportedAt: new Date().toISOString(),
      app: config.app.name,
      version: config.app.version,
      data,
    };
  },

  async importData(file, { merge = false } = {}) {
    requirePermission('backup.manage');
    const parsed = typeof file === 'string' ? JSON.parse(file) : file;
    const data = parsed.data || parsed;
    if (!data || !data.collections) throw new Error('That file is not a valid POS TXbd backup.');
    await http.post('/backup/import', { data, merge });
    bus.emit('data:imported');
    return db.stats();
  },

  async stats() {
    return http.get('/backup/stats');
  },

  /** Full wipe + reseed. mode: 'demo' | 'blank'. */
  async reset({ mode = 'demo' } = {}) {
    requirePermission('backup.manage');
    const result = mode === 'blank' ? await seedBlank(db) : await seedDemo(db);
    bus.emit('data:reset', { mode });
    return result;
  },
};

export default backupService;
