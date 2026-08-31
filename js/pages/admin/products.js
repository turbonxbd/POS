/**
 * products.js - product catalog list.
 */
import { pageShell, statusBadge, moneyCell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { confirmDialog } from '../../components/confirm.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { exportCsv, parseCsv, readFileAsText } from '../../utils/csv.js';
import money from '../../utils/money.js';
import productService from '../../services/product-service.js';
import categoryService from '../../services/category-service.js';
import brandService from '../../services/brand-service.js';
import { mediaService } from '../../services/media-service.js';
import { can } from '../../core/rbac.js';

export default async function productsPage(ctx, mount) {
  const [catRes, brandRes] = await Promise.all([
    categoryService.getCategories({ pageSize: 'all' }).catch(() => ({ data: [] })),
    brandService.getBrands({ pageSize: 'all' }).catch(() => ({ data: [] })),
  ]);
  const categories = catRes.data || catRes;
  const brands = brandRes.data || brandRes;

  const shell = pageShell(mount, {
    title: 'Products',
    subtitle: 'Your sellable catalog. Archived products keep all sales history.',
    actions: [
      can('products.import') && { label: 'Import', icon: 'upload', variant: 'outline', onClick: importCsv },
      can('products.import') && { label: 'Export', icon: 'download', variant: 'outline', onClick: exportAll },
      can('products.create') && { label: 'New Product', icon: 'plus', variant: 'primary', href: '#/products/new' },
    ].filter(Boolean),
  });

  const table = createDataTable(shell.body, {
    columns: [
      {
        key: 'name', label: 'Product', sortable: true, render: (r) => {
          const img = r.imageId ? mediaService.getUrl(r.imageId) : null;
          return `<div class="cell-product">
            ${img ? `<img class="thumb" src="${img}" alt="">` : `<div class="thumb thumb-placeholder">${escapeHtml((r.name || '?')[0])}</div>`}
            <div class="cell-product__meta"><strong>${escapeHtml(r.name)}</strong><span>${escapeHtml(r.sku)}${r.hasVariants ? ` · ${r.variants.length} variants` : ''}</span></div>
          </div>`;
        },
      },
      { key: 'categoryName', label: 'Category', render: (r) => escapeHtml(r.categoryName || '—') },
      { key: 'brandName', label: 'Brand', render: (r) => escapeHtml(r.brandName || '—') },
      { key: 'sellingPrice', label: 'Price', align: 'right', sortable: true, render: (r) => moneyCell(r.discountPrice ?? r.sellingPrice) },
      { key: 'stock', label: 'Stock', align: 'right', sortable: true, render: (r) => r.trackInventory === false ? '<span class="muted">∞</span>' : `<span class="tabular">${r.stock}</span>` },
      { key: 'computedStatus', label: 'Status', render: (r) => statusBadge(r.computedStatus) },
    ],
    filters: [
      { key: 'categoryId', label: 'Category', options: categories.filter((c) => !c.parentId).map((c) => ({ value: c.id, label: c.name })) },
      { key: 'brandId', label: 'Brand', options: brands.map((b) => ({ value: b.id, label: b.name })) },
      { key: 'status', label: 'Status', options: [
        { value: 'active', label: 'Active' }, { value: 'low_stock', label: 'Low stock' },
        { value: 'out_of_stock', label: 'Out of stock' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' },
      ] },
    ],
    searchPlaceholder: 'Search name, SKU or barcode…',
    selectable: can('products.edit'),
    initial: { search: ctx.query.search || '' },
    emptyState: {
      icon: 'box', title: 'No products yet',
      message: 'Add your first product or import a CSV to get started.',
      action: can('products.create') ? { label: 'New Product', icon: 'plus', onClick: () => (location.hash = '#/products/new') } : null,
    },
    fetcher: (params) => productService.getProducts({ ...params, includeArchived: params.status === 'archived' ? 'true' : undefined }),
    onRowClick: (row) => (location.hash = `#/products/${row.id}`),
    rowActions: (row) => {
      const a = [{ label: 'View', icon: 'eye', onClick: () => (location.hash = `#/products/${row.id}`) }];
      if (can('products.edit') && !row.archivedAt) a.push({ label: 'Edit', icon: 'edit', onClick: () => (location.hash = `#/products/${row.id}/edit`) });
      if (can('barcode.manage') && !row.archivedAt) a.push({ label: 'Barcode', icon: 'barcode', onClick: () => (location.hash = `#/barcodes?product=${row.id}`) });
      if (can('products.create')) a.push({ label: 'Duplicate', icon: 'copy', onClick: () => duplicate(row) });
      if (can('products.archive')) {
        if (row.archivedAt) a.push({ label: 'Restore', icon: 'rotate-ccw', onClick: () => restore(row) });
        else a.push({ label: 'Archive', icon: 'trash', danger: true, onClick: () => archive(row) });
      }
      return a;
    },
    bulkActions: () => [
      { label: 'Archive', danger: true, onClick: (ids) => bulk('archive', ids) },
      { label: 'Restore', onClick: (ids) => bulk('restore', ids) },
    ],
  });

  async function archive(row) {
    const ok = await confirmDialog({
      title: `Archive "${row.name}"?`,
      message: 'It will be removed from the POS and active lists. All past invoices that include it stay valid, and you can restore it any time.',
      confirmLabel: 'Archive', danger: true,
    });
    if (!ok) return;
    try {
      await productService.archiveProduct(row.id);
      toast.success('Product archived');
      table.reload();
    } catch (e) { toast.fromError(e); }
  }
  async function restore(row) {
    await productService.restoreProduct(row.id);
    toast.success('Product restored');
    table.reload();
  }
  async function duplicate(row) {
    const copy = await productService.duplicateProduct(row.id);
    toast.success('Product duplicated');
    location.hash = `#/products/${copy.id}/edit`;
  }
  async function bulk(action, ids) {
    if (action === 'archive' && !(await confirmDialog({ title: `Archive ${ids.length} products?`, danger: true, confirmLabel: 'Archive' }))) return;
    await productService.bulk(action, { ids });
    toast.success(`${ids.length} products ${action}d`);
    table.clearSelection();
    table.reload();
  }

  async function exportAll() {
    const res = await productService.exportProducts({ includeArchived: 'true' });
    exportCsv(`products-${new Date().toISOString().slice(0, 10)}`, res.data || [], [
      { key: 'name', label: 'name' }, { key: 'sku', label: 'sku' }, { key: 'barcode', label: 'barcode' },
      { key: 'categoryName', label: 'category' }, { key: 'brandName', label: 'brand' }, { key: 'unit', label: 'unit' },
      { key: 'costPrice', label: 'costPrice', value: (r) => money.toPlain(r.costPrice) },
      { key: 'sellingPrice', label: 'sellingPrice', value: (r) => money.toPlain(r.sellingPrice) },
      { key: 'stock', label: 'currentStock' }, { key: 'minStock', label: 'minStock' },
      { key: 'computedStatus', label: 'status' },
    ]);
    toast.success('Products exported');
  }

  function importCsv() {
    const m = openModal({
      title: 'Import Products (CSV)', size: 'md',
      body: `<p class="text-sm muted">Upload a CSV with headers: <code>name, sku, barcode, costPrice, sellingPrice, unit, minStock, openingStock</code>. Existing SKUs are skipped.</p>
        <label class="dropzone" style="margin-top:var(--sp-3)">
          <input type="file" accept=".csv,text/csv" class="js-file" hidden>
          <span>Click to choose a CSV file</span>
        </label>
        <div class="js-preview" style="margin-top:var(--sp-3)"></div>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--primary js-do" disabled>Import</button>`,
    });
    let rows = [];
    m.$('.js-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        rows = parseCsv(await readFileAsText(file));
        m.$('.js-preview').innerHTML = `<div class="alert alert--info"><div class="alert__body">${rows.length} rows detected. First: <strong>${escapeHtml(rows[0]?.name || '—')}</strong></div></div>`;
        m.$('.js-do').disabled = rows.length === 0;
      } catch (err) {
        m.$('.js-preview').innerHTML = `<div class="alert alert--danger"><div class="alert__body">${escapeHtml(err.message)}</div></div>`;
      }
    });
    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-do').addEventListener('click', async () => {
      m.setBusy(true);
      try {
        const items = rows.map((r) => ({
          name: r.name, sku: r.sku || undefined, barcode: r.barcode || undefined, unit: r.unit || 'pcs',
          costPrice: money.toMinor(r.costPrice || 0), sellingPrice: money.toMinor(r.sellingPrice || r.price || 0),
          minStock: Number(r.minStock) || 0, openingStock: Number(r.openingStock) || 0,
        }));
        const res = await productService.bulk('import', { items });
        m.close();
        toast.success(`Imported ${res.affected} products`);
        table.reload();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }
}
