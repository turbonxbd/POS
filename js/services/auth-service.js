/**
 * auth-service.js - authentication API surface.
 * Swap the bodies for real endpoints and nothing else in the app changes.
 */

import http from '../core/http.js';

export const authService = {
  login(email, password) {
    return http.post('/auth/login', { email, password });
  },
  me() {
    return http.get('/auth/me');
  },
  logout() {
    return http.post('/auth/logout');
  },
  changePassword(currentPassword, newPassword) {
    return http.post('/auth/change-password', { currentPassword, newPassword });
  },
};

export default authService;
