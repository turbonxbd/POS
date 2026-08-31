/**
 * category-service.js
 */
import http from '../core/http.js';
import { crudService } from './base.js';
import { requirePermission } from '../core/rbac.js';
import { categorySchema } from '../data/schema.js';

const crud = crudService('/categories', {
  perms: { view: 'products.view', create: 'categories.manage', edit: 'categories.manage', archive: 'categories.manage' },
  schema: categorySchema,
});

export const categoryService = {
  getCategories(params = {}) {
    return http.get('/categories', { params });
  },
  getTree() {
    return http.get('/categories', { params: { pageSize: 'all' } }).then((res) => {
      const rows = res.data || res;
      const parents = rows.filter((c) => !c.parentId).sort((a, b) => a.order - b.order);
      return parents.map((p) => ({ ...p, children: rows.filter((c) => c.parentId === p.id).sort((a, b) => a.order - b.order) }));
    });
  },
  getCategoryById: crud.get,
  createCategory: crud.create,
  updateCategory: crud.update,
  archiveCategory: crud.archive,
  restoreCategory: crud.restore,
  reorder(ids) {
    requirePermission('categories.manage');
    return Promise.all(ids.map((id, i) => http.patch(`/categories/${id}`, { order: i + 1 })));
  },
};

export default categoryService;
