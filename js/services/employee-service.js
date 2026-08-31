/**
 * employee-service.js - employees, roles & permissions.
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';

export const employeeService = {
  getEmployees: (params = {}) => {
    requirePermission('employees.view');
    return http.get('/employees', { params });
  },
  getEmployeeById: (id) => {
    requirePermission('employees.view');
    return http.get(`/employees/${id}`);
  },
  createEmployee: (payload) => {
    requirePermission('employees.manage');
    return http.post('/employees', payload);
  },
  updateEmployee: (id, payload) => {
    requirePermission('employees.manage');
    return http.patch(`/employees/${id}`, payload);
  },
  deactivateEmployee: (id) => {
    requirePermission('employees.manage');
    return http.del(`/employees/${id}`);
  },
  restoreEmployee: (id) => {
    requirePermission('employees.manage');
    return http.post(`/employees/${id}/restore`);
  },

  getRoles: () => http.get('/roles'),
  createRole: (payload) => {
    requirePermission('roles.manage');
    return http.post('/roles', payload);
  },
  updateRole: (id, payload) => {
    requirePermission('roles.manage');
    return http.patch(`/roles/${id}`, payload);
  },
  deleteRole: (id) => {
    requirePermission('roles.manage');
    return http.del(`/roles/${id}`);
  },
};

export default employeeService;
