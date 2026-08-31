/**
 * branch-service.js
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';

export const branchService = {
  getBranches: (params = {}) => http.get('/branches', { params }),
  createBranch: (payload) => {
    requirePermission('branches.manage');
    return http.post('/branches', payload);
  },
  updateBranch: (id, payload) => {
    requirePermission('branches.manage');
    return http.patch(`/branches/${id}`, payload);
  },
  archiveBranch: (id) => {
    requirePermission('branches.manage');
    return http.del(`/branches/${id}`);
  },
};

export default branchService;
