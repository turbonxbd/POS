/**
 * categories.js
 */
import { resourcePage } from '../shared/resource-page.js';
import { statusBadge } from '../shared/page-kit.js';
import { escapeHtml } from '../../utils/dom.js';
import categoryService from '../../services/category-service.js';

export default async function categoriesPage(ctx, mount) {
  let parents = [];
  try {
    const res = await categoryService.getCategories({ pageSize: 'all' });
    parents = (res.data || res).filter((c) => !c.parentId);
  } catch { /* handled by table */ }

  resourcePage(mount, {
    title: 'Categories',
    subtitle: 'Organise your catalog. Archiving keeps historical product links intact.',
    entityLabel: 'Category',
    service: {
      list: (p) => categoryService.getCategories(p),
      get: categoryService.getCategoryById,
      create: categoryService.createCategory,
      update: categoryService.updateCategory,
      archive: categoryService.archiveCategory,
      restore: categoryService.restoreCategory,
    },
    perms: { create: 'categories.manage', edit: 'categories.manage', archive: 'categories.manage' },
    filters: [
      { key: 'parentId', label: 'Type', options: [{ value: '', label: 'Top-level & subcategories' }], allowAll: false },
      { key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] },
    ],
    columns: [
      { key: 'name', label: 'Name', sortable: true, render: (r) => `<strong>${escapeHtml(r.name)}</strong>${r.parentName ? `<br><span class="muted text-xs">↳ under ${escapeHtml(r.parentName)}</span>` : ''}` },
      { key: 'productCount', label: 'Products', align: 'right', sortable: true },
      { key: 'order', label: 'Order', align: 'right', sortable: true },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.archivedAt ? 'archived' : r.status || 'active') },
    ],
    exportColumns: [
      { key: 'name', label: 'Name' }, { key: 'parentName', label: 'Parent' },
      { key: 'productCount', label: 'Products' }, { key: 'order', label: 'Order' }, { key: 'status', label: 'Status' },
    ],
    formFields: () => [
      { name: 'name', label: 'Category name', required: true, colSpan: 'full' },
      { name: 'parentId', label: 'Parent category', type: 'select', placeholder: 'None (top level)', options: parents.map((p) => ({ value: p.id, label: p.name })) },
      { name: 'order', label: 'Display order', type: 'number', value: 0 },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    toForm: (r) => ({ name: r?.name || '', parentId: r?.parentId || '', order: r?.order || 0, status: r?.status || 'active', description: r?.description || '' }),
  });
}
