/**
 * product-service.js
 */

import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import { withBranch } from './base.js';
import { productSchema } from '../data/schema.js';
import { assertValid } from '../utils/validate.js';

export const productService = {
  getProducts(params = {}) {
    requirePermission('products.view');
    return http.get('/products', { params: withBranch(params) });
  },
  getProductById(id, params = {}) {
    requirePermission('products.view');
    return http.get(`/products/${id}`, { params: withBranch(params) });
  },
  /** Fast POS lookup: exact barcode/sku match, else name search. */
  lookup({ code, q, limit } = {}) {
    return http.get('/products/lookup', { params: withBranch({ code, q, limit }) });
  },
  searchProducts(term, params = {}) {
    requirePermission('products.view');
    return http.get('/products', { params: withBranch({ ...params, search: term }) });
  },
  createProduct(payload) {
    requirePermission('products.create');
    assertValid(payload, productSchema);
    return http.post('/products', withBranch(payload));
  },
  updateProduct(id, payload) {
    requirePermission('products.edit');
    return http.patch(`/products/${id}`, payload);
  },
  archiveProduct(id) {
    requirePermission('products.archive');
    return http.del(`/products/${id}`);
  },
  restoreProduct(id) {
    requirePermission('products.archive');
    return http.post(`/products/${id}/restore`);
  },
  duplicateProduct(id) {
    requirePermission('products.create');
    return http.post(`/products/${id}/duplicate`);
  },
  bulk(action, payload) {
    requirePermission(action === 'import' ? 'products.import' : 'products.edit');
    return http.post('/products/bulk', { action, ...payload });
  },
  exportProducts(params = {}) {
    requirePermission('products.import');
    return http.get('/products', { params: { ...withBranch(params), pageSize: 'all' } });
  },
};

export default productService;
