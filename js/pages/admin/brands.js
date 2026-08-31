/**
 * brands.js
 */
import { resourcePage } from '../shared/resource-page.js';
import { statusBadge } from '../shared/page-kit.js';
import { escapeHtml } from '../../utils/dom.js';
import brandService from '../../services/brand-service.js';

export default async function brandsPage(ctx, mount) {
  resourcePage(mount, {
    title: 'Brands',
    subtitle: 'Manufacturers and product brands carried by your store.',
    entityLabel: 'Brand',
    service: {
      list: (p) => brandService.getBrands(p),
      get: brandService.getBrandById,
      create: brandService.createBrand,
      update: brandService.updateBrand,
      archive: brandService.archiveBrand,
      restore: brandService.restoreBrand,
    },
    perms: { create: 'brands.manage', edit: 'brands.manage', archive: 'brands.manage' },
    filters: [{ key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] }],
    columns: [
      { key: 'name', label: 'Brand', sortable: true, render: (r) => `<strong>${escapeHtml(r.name)}</strong>` },
      { key: 'productCount', label: 'Products', align: 'right', sortable: true },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.archivedAt ? 'archived' : r.status || 'active') },
    ],
    exportColumns: [{ key: 'name', label: 'Name' }, { key: 'productCount', label: 'Products' }, { key: 'status', label: 'Status' }],
    formFields: () => [
      { name: 'name', label: 'Brand name', required: true, colSpan: 'full' },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    toForm: (r) => ({ name: r?.name || '', status: r?.status || 'active', description: r?.description || '' }),
  });
}
