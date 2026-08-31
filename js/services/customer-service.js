/**
 * customer-service.js
 */
import http from '../core/http.js';
import { crudService } from './base.js';
import { requirePermission } from '../core/rbac.js';
import { customerSchema } from '../data/schema.js';

const crud = crudService('/customers', {
  perms: { view: 'customers.view', create: 'customers.create', edit: 'customers.edit', archive: 'customers.edit' },
  schema: customerSchema,
});

export const customerService = {
  getCustomers: (params = {}) => {
    requirePermission('customers.view');
    return http.get('/customers', { params });
  },
  getCustomerById: crud.get,
  searchCustomers: (term) => {
    requirePermission('customers.view');
    return http.get('/customers', { params: { search: term, pageSize: 10 } });
  },
  createCustomer: crud.create,
  updateCustomer: crud.update,
  archiveCustomer: crud.archive,
  restoreCustomer: crud.restore,
  getHistory: (id) => {
    requirePermission('customers.view');
    return http.get(`/customers/${id}/history`);
  },
  adjustBalance: (id, payload) => {
    requirePermission('customers.balance');
    return http.post(`/customers/${id}/balance`, payload);
  },
};

export default customerService;
