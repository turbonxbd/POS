/**
 * supplier-service.js
 */
import http from '../core/http.js';
import { crudService } from './base.js';
import { requirePermission } from '../core/rbac.js';
import { supplierSchema } from '../data/schema.js';

const crud = crudService('/suppliers', {
  perms: { view: 'purchases.view', create: 'suppliers.manage', edit: 'suppliers.manage', archive: 'suppliers.manage' },
  schema: supplierSchema,
});

export const supplierService = {
  getSuppliers: (params = {}) => {
    requirePermission('purchases.view');
    return http.get('/suppliers', { params });
  },
  getSupplierById: crud.get,
  createSupplier: crud.create,
  updateSupplier: crud.update,
  archiveSupplier: crud.archive,
  restoreSupplier: crud.restore,
  getStatement: (id) => {
    requirePermission('purchases.view');
    return http.get(`/suppliers/${id}/statement`);
  },
  recordPayment: (id, payload) => {
    requirePermission('suppliers.manage');
    return http.post(`/suppliers/${id}/payments`, payload);
  },
};

export default supplierService;
