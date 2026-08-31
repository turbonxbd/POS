/**
 * purchase-service.js - purchases, receiving, purchase returns.
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { withBranch } from './base.js';

export const purchaseService = {
  getPurchases(params = {}) {
    requirePermission('purchases.view');
    return http.get('/purchases', { params: withBranch(params) });
  },
  getPurchaseById(id) {
    requirePermission('purchases.view');
    return http.get(`/purchases/${id}`);
  },
  createPurchase(payload) {
    requirePermission('purchases.create');
    return http.post('/purchases', withBranch(payload));
  },
  updatePurchase(id, payload) {
    requirePermission('purchases.edit');
    return http.patch(`/purchases/${id}`, payload);
  },
  receivePurchase(id, lines) {
    requirePermission('purchases.receive');
    return http.post(`/purchases/${id}/receive`, { lines });
  },
  cancelPurchase(id) {
    requirePermission('purchases.edit');
    return http.post(`/purchases/${id}/cancel`);
  },
  returnPurchase(id, payload) {
    requirePermission('purchases.return');
    return http.post(`/purchases/${id}/returns`, payload);
  },
  getPurchaseReturns(params = {}) {
    requirePermission('purchases.view');
    return http.get('/purchase-returns', { params });
  },
};

export default purchaseService;
