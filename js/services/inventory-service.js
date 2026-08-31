/**
 * inventory-service.js - stock levels, ledger, adjustments, transfers, valuation.
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { withBranch } from './base.js';

export const inventoryService = {
  getInventory(params = {}) {
    requirePermission('inventory.view');
    return http.get('/inventory', { params: withBranch(params) });
  },
  getStockMovements(params = {}) {
    requirePermission('inventory.view');
    return http.get('/inventory/movements', { params: withBranch(params) });
  },
  getAdjustments(params = {}) {
    requirePermission('inventory.view');
    return http.get('/inventory/adjustments', { params: withBranch(params) });
  },
  adjustStock(payload) {
    requirePermission('inventory.adjust');
    return http.post('/inventory/adjustments', withBranch(payload));
  },
  getTransfers(params = {}) {
    requirePermission('inventory.view');
    return http.get('/inventory/transfers', { params });
  },
  transferStock(payload) {
    requirePermission('inventory.transfer');
    return http.post('/inventory/transfers', payload);
  },
  getValuation(params = {}) {
    requirePermission('inventory.valuation');
    return http.get('/inventory/valuation', { params: withBranch(params) });
  },
};

export default inventoryService;
