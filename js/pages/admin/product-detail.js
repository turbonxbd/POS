/**
 * product-detail.js - product overview: pricing, stock across branches, and
 * recent inventory movements.
 */
import { pageShell, statusBadge, statStrip } from '../shared/page-kit.js';
import { createTabs } from '../../components/tabs.js';
import { blockLoader } from '../../components/skeleton.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { renderBarcode } from '../../components/barcode.js';
import { fmtDateTime } from '../../utils/date.js';
import money from '../../utils/money.js';
import { titleCase } from '../../utils/format.js';
import productService from '../../services/product-service.js';
import inventoryService from '../../services/inventory-service.js';
import { mediaService } from '../../services/media-service.js';
import { can } from '../../core/rbac.js';
import store from '../../core/store.js';

export default async function productDetailPage(ctx, mount) {
  mount.innerHTML = blockLoader('Loading product…');
  let product;
  try {
    product = await productService.getProductById(ctx.params.id);
  } catch (err) {
    mount.innerHTML = `<div class="page"><div class="alert alert--danger"><div class="alert__body">${escapeHtml(err.message)}</div></div></div>`;
    return;
  }

  const attrRows = (a) => ['color', 'size', 'variant']
    .filter((k) => a && a[k])
    .map((k) => `<div class="detail-list__row"><dt>${k[0].toUpperCase() + k.slice(1)}</dt><dd>${escapeHtml(a[k])}</dd></div>`)
    .join('');

  const img = product.imageId ? mediaService.getUrl(product.imageId) : null;
  const shell = pageShell(mount, {
    title: product.name,
    breadcrumb: [{ label: 'Products', href: '#/products' }, { label: product.name }],
    actions: [
      can('products.edit') && !product.archivedAt && { label: 'Edit', icon: 'edit', variant: 'primary', href: `#/products/${product.id}/edit` },
      can('barcode.manage') && { label: 'Barcode', icon: 'barcode', variant: 'outline', href: `#/barcodes?product=${product.id}` },
    ].filter(Boolean),
  });

  shell.body.innerHTML = `<div class="form-layout">
    <div class="form-layout__main">
      <div class="card card--pad">
        <div class="row" style="gap:var(--sp-4);align-items:flex-start">
          ${img ? `<img class="thumb thumb--lg" style="width:96px;height:96px" src="${img}" alt="">` : `<div class="thumb thumb--lg thumb-placeholder" style="width:96px;height:96px;font-size:2rem">${escapeHtml(product.name[0])}</div>`}
          <div class="grow">
            <div class="row" style="gap:var(--sp-2)">${statusBadge(product.computedStatus)} ${product.archivedAt ? statusBadge('archived') : ''}</div>
            <h2 style="margin-top:var(--sp-2)">${escapeHtml(product.name)}</h2>
            <p class="muted">${escapeHtml(product.description || 'No description')}</p>
          </div>
        </div>
      </div>
      <div id="tabs"></div>
    </div>
    <div class="form-layout__side">
      <div class="card card--pad">
        <dl class="detail-list">
          <div class="detail-list__row"><dt>SKU</dt><dd class="mono">${escapeHtml(product.sku)}</dd></div>
          <div class="detail-list__row"><dt>Barcode</dt><dd class="mono">${escapeHtml(product.barcode)}</dd></div>
          <div class="detail-list__row"><dt>Category</dt><dd>${escapeHtml(product.categoryName || '—')}${product.subcategoryName ? ' / ' + escapeHtml(product.subcategoryName) : ''}</dd></div>
          <div class="detail-list__row"><dt>Brand</dt><dd>${escapeHtml(product.brandName || '—')}</dd></div>
          <div class="detail-list__row"><dt>Supplier</dt><dd>${escapeHtml(product.supplierName || '—')}</dd></div>
          <div class="detail-list__row"><dt>Unit</dt><dd>${escapeHtml(product.unit)}</dd></div>
          ${attrRows(product.attributes)}
        </dl>
      </div>
      <div class="card card--pad">
        <div class="form-section-title">Pricing</div>
        <dl class="detail-list">
          <div class="detail-list__row"><dt>Purchase</dt><dd>${money.format(product.costPrice)}</dd></div>
          ${product.mrp ? `<div class="detail-list__row"><dt>MRP</dt><dd><s class="muted">${money.format(product.mrp)}</s></dd></div>` : ''}
          <div class="detail-list__row"><dt>Selling</dt><dd class="strong">${money.format(product.sellingPrice)}</dd></div>
          ${product.discountPrice ? `<div class="detail-list__row"><dt>Discount</dt><dd>${money.format(product.discountPrice)}</dd></div>` : ''}
          <div class="detail-list__row"><dt>Wholesale</dt><dd>${money.format(product.wholesalePrice)}</dd></div>
          <div class="detail-list__row"><dt>Margin</dt><dd>${product.sellingPrice ? Math.round(((product.sellingPrice - product.costPrice) / product.sellingPrice) * 100) : 0}%</dd></div>
        </dl>
      </div>
      <div class="card card--pad" style="text-align:center">
        <div class="form-section-title">Barcode</div>
        <div id="bc"></div>
      </div>
    </div>
  </div>`;

  shell.body.querySelector('#bc').innerHTML = renderBarcode(product.barcode, { height: 50, moduleWidth: 1.6 });

  createTabs(shell.body.querySelector('#tabs'), {
    tabs: [
      { id: 'stock', label: 'Stock', render: (el) => renderStock(el) },
      { id: 'movements', label: 'Movements', render: (el) => renderMovements(el) },
      product.variants?.length && { id: 'variants', label: `Variants (${product.variants.length})`, render: (el) => renderVariantsTab(el) },
    ].filter(Boolean),
  });

  async function renderStock(el) {
    el.innerHTML = blockLoader('Loading stock…');
    const branches = store.get('branches') || [];
    const rows = [];
    for (const b of branches) {
      const res = await inventoryService.getInventory({ branchId: b.id, product: product.id, pageSize: 'all' }).catch(() => ({ data: [] }));
      (res.data || []).forEach((r) => rows.push({ branch: b.name, ...r }));
    }
    el.innerHTML = `${statStrip([
      { label: 'Total on hand', value: rows.reduce((s, r) => s + r.quantity, 0) },
      { label: 'Stock value', value: money.format(rows.reduce((s, r) => s + r.stockValue, 0)) },
      { label: 'Branches stocked', value: rows.filter((r) => r.quantity > 0).length },
    ])}
    <div class="table-wrap"><table class="table table--compact">
      <thead><tr><th>Branch</th><th>Variant</th><th class="num">On hand</th><th class="num">Available</th><th class="num">Min</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${escapeHtml(r.branch)}</td><td>${escapeHtml(r.variantLabel || '—')}</td>
        <td class="num">${r.quantity}</td><td class="num">${r.available}</td><td class="num">${r.minStock}</td><td>${statusBadge(r.status)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No stock records.</td></tr>'}</tbody>
    </table></div>`;
  }

  async function renderMovements(el) {
    el.innerHTML = blockLoader('Loading movements…');
    const res = await inventoryService.getStockMovements({ product: product.id, pageSize: 50 }).catch(() => ({ data: [] }));
    const rows = res.data || [];
    el.innerHTML = rows.length ? `<div class="table-wrap"><table class="table table--compact">
      <thead><tr><th>Date</th><th>Type</th><th class="num">Change</th><th class="num">Balance</th><th>Reference</th><th>User</th></tr></thead>
      <tbody>${rows.map((t) => `<tr>
        <td>${fmtDateTime(t.at)}</td>
        <td><span class="badge badge--${t.qtyDelta > 0 ? 'success' : 'danger'}">${titleCase(t.type)}</span></td>
        <td class="num" style="color:var(--${t.qtyDelta > 0 ? 'success' : 'danger'}-fg)">${t.qtyDelta > 0 ? '+' : ''}${t.qtyDelta}</td>
        <td class="num">${t.balanceAfter}</td>
        <td class="mono text-xs">${escapeHtml(t.note || t.refId || '—')}</td>
        <td>${escapeHtml(t.userName || '—')}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><h3>No movements yet</h3></div>';
  }

  function renderVariantsTab(el) {
    el.innerHTML = `<div class="table-wrap"><table class="table table--compact">
      <thead><tr><th>Variant</th><th>SKU</th><th>Barcode</th><th class="num">Cost</th><th class="num">Selling</th><th class="num">Stock</th></tr></thead>
      <tbody>${product.variants.map((v) => {
        const st = product.variantStock?.find((x) => x.id === v.id)?.stock ?? 0;
        return `<tr><td><strong>${escapeHtml(v.name || '—')}</strong></td><td class="mono">${escapeHtml(v.sku)}</td>
        <td class="mono">${escapeHtml(v.barcode)}</td><td class="num">${money.format(v.costPrice)}</td>
        <td class="num">${money.format(v.sellingPrice)}</td><td class="num">${st}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }
}

