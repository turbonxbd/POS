/**
 * platform-service.js - Super Admin (platform) API + the public plans feed.
 * Every /platform/* call is gated server-side on a platform actor.
 */
import http from '../core/http.js';

export const platformService = {
  /* plans (Super Admin manages; the Live panel reads /plans) */
  publicPlans: () => http.get('/plans'),
  plans: () => http.get('/platform/plans'),
  createPlan: (body) => http.post('/platform/plans', body),
  updatePlan: (id, body) => http.patch(`/platform/plans/${id}`, body),
  archivePlan: (id) => http.del(`/platform/plans/${id}`),

  /* dashboard */
  dashboard: () => http.get('/platform/dashboard'),

  /* approvals inbox */
  approvals: () => http.get('/platform/approvals'),
  approveMerchant: (id) => http.post(`/platform/approvals/${id}/approve`),
  rejectMerchant: (id, reason) => http.post(`/platform/approvals/${id}/reject`, { reason }),

  /* merchants */
  merchants: (params = {}) => http.get('/platform/merchants', { params }),
  merchant: (id) => http.get(`/platform/merchants/${id}`),
  createMerchant: (body) => http.post('/platform/merchants', body),
  updateMerchant: (id, body) => http.patch(`/platform/merchants/${id}`, body),

  /* subscriptions + billing */
  subscriptions: (params = {}) => http.get('/platform/subscriptions', { params }),
  updateSubscription: (id, body) => http.patch(`/platform/subscriptions/${id}`, body),
  payments: (params = {}) => http.get('/platform/subscription-payments', { params }),
  recordPayment: (body) => http.post('/platform/subscription-payments', body),
  updatePayment: (id, body) => http.patch(`/platform/subscription-payments/${id}`, body),
  revenue: () => http.get('/platform/revenue'),

  /* platform settings (contact / billing / gateway) - single source of truth */
  publicSettings: () => http.get('/public-settings'),
  settings: () => http.get('/platform/settings'),
  updateSettings: (body) => http.patch('/platform/settings', body),

  /* support */
  support: (params = {}) => http.get('/platform/support', { params }),
  replySupport: (id, text) => http.post(`/platform/support/${id}/reply`, { text }),
  setSupportStatus: (id, status) => http.patch(`/platform/support/${id}`, { status }),

  // server-side backups (rest deployment only)
  backups: () => http.get('/platform/backups'),
  runBackup: () => http.post('/platform/backups/run'),
  deleteBackup: (file) => http.del(`/platform/backups?file=${encodeURIComponent(file)}`),
};

export default platformService;
