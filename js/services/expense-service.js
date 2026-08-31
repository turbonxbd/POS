/**
 * expense-service.js
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { withBranch } from './base.js';
import { expenseSchema } from '../data/schema.js';
import { assertValid } from '../utils/validate.js';

export const expenseService = {
  getExpenses: (params = {}) => {
    requirePermission('expenses.view');
    return http.get('/expenses', { params: withBranch(params) });
  },
  getCategories: () => http.get('/expense-categories'),
  createExpense: (payload) => {
    requirePermission('expenses.manage');
    assertValid(payload, expenseSchema);
    return http.post('/expenses', withBranch(payload));
  },
  updateExpense: (id, payload) => {
    requirePermission('expenses.manage');
    return http.patch(`/expenses/${id}`, payload);
  },
  deleteExpense: (id) => {
    requirePermission('expenses.manage');
    return http.del(`/expenses/${id}?hard=true`);
  },
};

export default expenseService;
