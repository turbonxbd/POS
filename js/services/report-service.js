/**
 * report-service.js - dashboard + all report types.
 * Every report is computed by js/core/mock/report-lib.js so the numbers match
 * the dashboard cards that drill into them.
 */
import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { withBranch } from './base.js';

const FINANCIAL = new Set(['profit', 'daily-closing']);

export const reportService = {
  getDashboard(params = {}) {
    requirePermission('dashboard.view');
    return http.get('/dashboard', { params: withBranch(params) });
  },
  getReport(type, params = {}) {
    requirePermission('reports.view');
    if (FINANCIAL.has(type)) requirePermission('reports.financial');
    return http.get(`/reports/${type}`, { params: withBranch(params) });
  },
};

/**
 * Report catalogue. `entity` tells the report page what a row drills into:
 *   sale | product | customer | none
 * `filters` are the filter controls the report page renders.
 */
export const REPORT_TYPES = [
  { type: 'sales', label: 'Sales Report', icon: 'receipt', entity: 'sale', dated: true, filters: ['search', 'cashier', 'payment', 'status'] },
  { type: 'cash', label: 'Cash Payments', icon: 'banknote', entity: 'sale', dated: true, filters: ['search', 'cashier'] },
  { type: 'epayments', label: 'E-Payments', icon: 'smartphone', entity: 'sale', dated: true, filters: ['search', 'method'] },
  { type: 'payments', label: 'Payment Methods', icon: 'credit-card', entity: 'none', dated: true, filters: [] },
  { type: 'discounts', label: 'Discount Report', icon: 'percent', entity: 'sale', dated: true, filters: ['search'] },
  { type: 'returns', label: 'Returns & Refunds', icon: 'undo', entity: 'sale', dated: true, filters: ['search'] },
  { type: 'receivables', label: 'Outstanding / Due', icon: 'wallet', entity: 'customer', dated: false, filters: ['search', 'status'] },
  { type: 'customers-served', label: 'Customers Served', icon: 'users', entity: 'customer', dated: true, filters: ['search'] },
  { type: 'products-sold', label: 'Products Sold', icon: 'box', entity: 'product', dated: true, filters: ['search', 'sort'] },
  { type: 'product-performance', label: 'Product Performance', icon: 'trending-up', entity: 'product', dated: true, filters: ['search', 'sort'] },
  { type: 'category-performance', label: 'Category Performance', icon: 'layers', entity: 'none', dated: true, filters: [] },
  { type: 'profit', label: 'Profit Analysis', icon: 'dollar-sign', entity: 'none', dated: true, filters: [], perm: 'reports.financial' },
  { type: 'purchases', label: 'Purchase Report', icon: 'truck', entity: 'none', dated: true, filters: ['search', 'supplier', 'status'] },
  { type: 'inventory-valuation', label: 'Inventory Valuation', icon: 'warehouse', entity: 'product', dated: false, filters: ['search'] },
  { type: 'stock-movement', label: 'Stock Movement', icon: 'sliders', entity: 'none', dated: true, filters: ['search'] },
  { type: 'expenses', label: 'Expense Report', icon: 'wallet', entity: 'none', dated: true, filters: ['search', 'category'] },
  { type: 'cashier', label: 'Cashier Performance', icon: 'user', entity: 'none', dated: true, filters: [] },
  { type: 'customers', label: 'Customer Report', icon: 'users', entity: 'customer', dated: false, filters: ['search'] },
  { type: 'suppliers', label: 'Supplier Report', icon: 'building', entity: 'none', dated: false, filters: ['search'] },
  { type: 'tax', label: 'Tax / VAT Report', icon: 'percent', entity: 'none', dated: true, filters: [] },
  { type: 'daily-closing', label: 'Daily Closing', icon: 'calendar', entity: 'none', dated: true, filters: [], perm: 'reports.financial' },
];

export function reportMeta(type) {
  return REPORT_TYPES.find((r) => r.type === type) || null;
}

export default reportService;
