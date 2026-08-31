/**
 * billing-service.js - the merchant's own subscription & payments.
 * Talks to /billing/* which is tenant-scoped server-side.
 */
import http from '../core/http.js';

export const billingService = {
  summary: () => http.get('/billing/summary'),
  pay: (body) => http.post('/billing/pay', body),
  requestBranch: (body) => http.post('/billing/branch-request', body),
  cancelPayment: (id) => http.post(`/billing/payments/${id}/cancel`),
};

export default billingService;
