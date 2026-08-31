/**
 * audit-service.js - read-only access to the immutable audit log.
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';

export const auditService = {
  getLogs(params = {}) {
    requirePermission('audit.view');
    return http.get('/audit-logs', { params });
  },
};

export const AUDIT_ENTITIES = ['product', 'category', 'brand', 'sale', 'sale_return', 'purchase', 'purchase_return', 'stock_adjustment', 'customer', 'supplier', 'employee', 'role', 'branch', 'settings', 'expense', 'register_session', 'user', 'subscription'];
export const AUDIT_ACTIONS = ['create', 'update', 'archive', 'delete', 'restore', 'login', 'logout', 'sale', 'refund', 'receive', 'adjust', 'transfer', 'settings'];

export default auditService;
