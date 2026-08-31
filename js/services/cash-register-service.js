/**
 * cash-register-service.js
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { withBranch } from './base.js';

export const cashRegisterService = {
  getCurrent(params = {}) {
    return http.get('/cash-register/current', { params: withBranch({ ...params, mine: true }) });
  },
  getSessions(params = {}) {
    requirePermission('register.view');
    return http.get('/cash-register/sessions', { params: withBranch(params) });
  },
  getSessionById(id) {
    requirePermission('register.view');
    return http.get(`/cash-register/sessions/${id}`);
  },
  openRegister(payload) {
    requirePermission('register.operate');
    return http.post('/cash-register/open', withBranch(payload));
  },
  addMovement(sessionId, payload) {
    requirePermission('register.operate');
    return http.post(`/cash-register/sessions/${sessionId}/movements`, payload);
  },
  closeRegister(sessionId, payload) {
    requirePermission('register.operate');
    return http.post(`/cash-register/sessions/${sessionId}/close`, payload);
  },
};

export default cashRegisterService;
