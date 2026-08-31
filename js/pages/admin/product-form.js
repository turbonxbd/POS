/**
 * product-form.js - create / edit a product.
 *
 * Clean, sectioned layout:
 *   Product Information · Product Attributes (+ Variants) · Pricing (Purchase / MRP
 *   / Selling) · Branch Stock (per-branch opening quantities) · Stock Summary
 *   (auto total) · Actions (Save Product / Generate Barcode).
 *
 * Branch-level opening quantities are the source of truth: the backend posts one
 * `opening` inventory movement per branch, and Total Stock = the sum. "Generate
 * Barcode" saves the product, then opens the existing Barcode Generator with the
 * product + its total stock pre-loaded (#/barcodes?product=<id>).
 */
import { pageShell } from '../shared/page-kit.js';
import { createForm } from '../../components/form.js';
import { toast } from '../../components/toast.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { blockLoader } from '../../components/skeleton.js';
import money from '../../utils/money.js';
import { uuid, suggestSku, generateEan13 } from '../../utils/id.js';
import { UNITS } from '../../data/schema.js';
import store from '../../core/store.js';
import productService from '../../services/product-service.js';
import categoryService from '../../services/category-service.js';
import brandService from '../../services/brand-service.js';
import supplierService from '../../services/supplier-service.js';
import taxService from '../../services/tax-service.js';
import { mediaService } from '../../services/media-service.js';

export default async function productFormPage(ctx, mount) {
  const id = ctx.params.id;
  const isEdit = !!id;
  mount.innerHTML = blockLoader('Loading form…');

  const [product, catTree, brandRes, supRes, taxRes] = await Promise.all([
    isEdit ? productService.getProductById(id, { allBranches: true }) : Promise.resolve(null),
    categoryService.getTree(),
    brandService.getBrands({ pageSize: 'all' }),
    supplierService.getSuppliers({ pageSize: 'all' }).catch(() => ({ data: [] })),
    taxService.getTaxes({ pageSize: 'all' }),
  ]);
  const brands = brandRes.data || brandRes;
  const suppliers = supRes.data || supRes;
  // fixed-amount VAT is a whole-sale fee, not a per-product rate
  const taxes = (taxRes.data || taxRes).filter((t) => t.type !== 'fixed');
  const branches = (store.get('branches') || []).filter((b) => !b.archivedAt);
  const subOptions = (parentId) => {
    const p = catTree.find((c) => c.id === parentId);
    return (p?.children || []).map((c) => ({ value: c.id, label: c.name }));
  };

  let variants = product?.variants ? structuredClone(product.variants) : [];
  let imageId = product?.imageId || null;
  // create mode: editable per-branch opening quantities
  let branchRows = isEdit
    ? []
    : [{ branchId: store.get('activeBranchId') || branches[0]?.id || '', qty: 0 }];

  const shell = pageShell(mount, {
    title: isEdit ? `Edit ${product.name}` : 'New Product',
    breadcrumb: [{ label: 'Products', href: '#/products' }, { label: isEdit ? 'Edit' : 'New' }],
  });

  shell.body.innerHTML = `<div class="form-layout">
    <div class="form-layout__main">
      <div class="card card--pad">
        <div class="form-section-title">Product Information</div>
        <div id="form-info"></div>
      </div>

      <div class="card card--pad">
        <div class="form-section-title">Product Attributes</div>
        <p class="field-hint" style="margin-bottom:var(--sp-3)">Optional. Leave blank for products that do not need colour / size.</p>
        <div id="form-attr"></div>
        <div class="row-between" style="margin:var(--sp-4) 0 var(--sp-2)">
          <div class="form-section-title" style="margin:0">Variants (multi-SKU)</div>
          <button class="btn btn--sm btn--subtle" id="add-variant">${icon('plus', { size: 14 })} Add variant</button>
        </div>
        <p class="field-hint" style="margin-bottom:var(--sp-3)">For products sold as separate SKUs (e.g. shades). Each variant carries its own SKU, barcode, price and opening stock.</p>
        <div id="variants"></div>
      </div>

      <div class="card card--pad">
        <div class="form-section-title">Pricing</div>
        <div id="form-pricing"></div>
      </div>

      <div class="card card--pad">
        <div class="form-section-title">Branch Stock</div>
        <div id="branch-stock"></div>
      </div>

      <div class="card card--pad">
        <div class="form-section-title">Stock Summary</div>
        <dl class="detail-list" id="stock-summary"></dl>
      </div>
    </div>

    <div class="form-layout__side">
      <div class="card card--pad">
        <div class="form-section-title">Image</div>
        <label class="dropzone" id="dz">
          <input type="file" accept="image/*" hidden id="img-input">
          <div id="dz-content"></div>
        </label>
        <button class="btn btn--ghost btn--sm btn--block" id="img-remove" style="margin-top:var(--sp-2)" ${imageId ? '' : 'hidden'}>Remove image</button>
      </div>
      <div class="card card--pad">
        <div class="form-section-title">Pricing preview</div>
        <dl class="detail-list" id="price-preview"></dl>
      </div>
      <div class="form-actions" style="flex-direction:column;align-items:stretch;gap:var(--sp-2)">
        <button class="btn btn--primary btn--block" id="save">${isEdit ? 'Save changes' : 'Save Product'}</button>
        <button class="btn btn--outline btn--block" id="gen-barcode">${icon('barcode', { size: 15 })} Generate Barcode</button>
        <button class="btn btn--ghost btn--block" id="cancel">Cancel</button>
      </div>
    </div>
  </div>`;

  /* ---- image ---- */
  renderImage();
  shell.body.querySelector('#img-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { id: mid } = await mediaService.upload(file);
      imageId = mid;
      renderImage();
    } catch (err) { toast.fromError(err); }
  });
  shell.body.querySelector('#img-remove').addEventListener('click', () => { imageId = null; renderImage(); });
  function renderImage() {
    const url = imageId ? mediaService.getUrl(imageId) : null;
    shell.body.querySelector('#dz-content').innerHTML = url
      ? `<img class="dropzone__preview" src="${url}" alt="">`
      : `${icon('upload', { size: 22 })}<span>Drop an image or click to upload</span><span class="text-xs">Auto-resized · JPG/PNG</span>`;
    shell.body.querySelector('#img-remove').hidden = !url;
  }

  /* ---- Product Information ---- */
  const formInfo = createForm(shell.body.querySelector('#form-info'), {
    hideActions: true,
    fields: [
      { name: 'name', label: 'Product Name', required: true, colSpan: 'full', transform: (v) => v.trim() },
      { name: 'brandId', label: 'Brand', type: 'select', placeholder: 'No brand', options: brands.map((b) => ({ value: b.id, label: b.name })) },
      { name: 'categoryId', label: 'Category', type: 'select', placeholder: 'Uncategorised', options: catTree.map((c) => ({ value: c.id, label: c.name })) },
      { name: 'subcategoryId', label: 'Subcategory', type: 'select', placeholder: '—', options: subOptions(product?.categoryId), when: (v) => subOptions(v.categoryId).length > 0 },
      { name: 'sku', label: 'SKU', placeholder: 'Auto-generated if blank' },
      { name: 'barcode', label: 'Barcode', placeholder: 'Auto-generated if blank' },
      { name: 'unit', label: 'Unit', type: 'select', options: UNITS.map((u) => ({ value: u, label: u })), value: 'pcs' },
      { name: 'supplierId', label: 'Default supplier', type: 'select', placeholder: '—', options: suppliers.map((s) => ({ value: s.id, label: s.name })) },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
      { name: 'trackInventory', label: 'Track inventory for this product', type: 'switch', value: true, colSpan: 'full' },
      { name: 'description', label: 'Description', type: 'textarea', rows: 3, colSpan: 'full' },
    ],
    values: product ? {
      name: product.name, brandId: product.brandId || '', categoryId: product.categoryId || '',
      subcategoryId: product.subcategoryId || '', sku: product.sku, barcode: product.barcode,
      unit: product.unit, supplierId: product.supplierId || '', status: product.status,
      trackInventory: product.trackInventory !== false, description: product.description,
    } : {},
    onChange: (name, value) => {
      if (name === 'categoryId') formInfo.setOptions('subcategoryId', subOptions(value));
    },
  });

  /* ---- Product Attributes ---- */
  const formAttr = createForm(shell.body.querySelector('#form-attr'), {
    hideActions: true,
    fields: [
      { name: 'color', label: 'Color', placeholder: 'e.g. Ruby Red' },
      { name: 'size', label: 'Size', placeholder: 'e.g. 30 ml' },
      { name: 'variant', label: 'Variant / Option', placeholder: 'e.g. Matte' },
    ],
    values: {
      color: product?.attributes?.color || '',
      size: product?.attributes?.size || '',
      variant: product?.attributes?.variant || '',
    },
  });

  /* ---- Pricing ---- */
  const formPricing = createForm(shell.body.querySelector('#form-pricing'), {
    hideActions: true,
    fields: [
      { name: 'costPrice', label: 'Purchase Price', type: 'money', required: true, hint: 'What you paid for the product' },
      { name: 'mrp', label: 'MRP', type: 'money', hint: 'Maximum Retail Price — the highest displayed price' },
      { name: 'sellingPrice', label: 'Selling Price', type: 'money', required: true, hint: 'The actual price customers pay' },
      { name: 'wholesalePrice', label: 'Wholesale price', type: 'money' },
      { name: 'discountPrice', label: 'Discount price', type: 'money', hint: 'Optional promo price used at the POS' },
      { name: 'taxId', label: 'Tax / VAT', type: 'select', placeholder: 'No tax', options: taxes.map((t) => ({ value: t.id, label: `${t.name} (${t.rate}%)` })), hint: 'Fixed-amount VAT is set in Discount & VAT and applies to every sale.' },
      { name: 'minStock', label: 'Minimum stock level', type: 'number', min: 0, value: 0 },
      { name: 'maxStock', label: 'Maximum stock level', type: 'number', min: 0, value: 0 },
    ],
    values: product ? {
      costPrice: product.costPrice, mrp: product.mrp ?? '', sellingPrice: product.sellingPrice,
      wholesalePrice: product.wholesalePrice, discountPrice: product.discountPrice ?? '',
      taxId: product.taxId || '', minStock: product.minStock, maxStock: product.maxStock,
    } : {},
    onChange: () => updatePricePreview(),
  });
  updatePricePreview();

  function updatePricePreview() {
    const v = formPricing.raw();
    const cost = v.costPrice || 0;
    const sell = v.sellingPrice || 0;
    const mrp = v.mrp || 0;
    const margin = sell ? Math.round(((sell - cost) / sell) * 100) : 0;
    const tax = taxes.find((t) => t.id === v.taxId);
    const withTax = tax && !tax.inclusive ? sell + money.percent(sell, tax.rate) : sell;
    shell.body.querySelector('#price-preview').innerHTML = `
      ${mrp > sell ? `<div class="detail-list__row"><dt>MRP</dt><dd><s class="muted">${money.format(mrp)}</s></dd></div>` : ''}
      <div class="detail-list__row"><dt>Selling</dt><dd class="strong">${money.format(sell)}</dd></div>
      <div class="detail-list__row"><dt>Margin</dt><dd>${margin}%</dd></div>
      <div class="detail-list__row"><dt>Profit / unit</dt><dd>${money.format(sell - cost)}</dd></div>
      <div class="detail-list__row"><dt>Price + tax</dt><dd>${money.format(withTax)}</dd></div>`;
  }

  /* ---- Branch Stock ---- */
  renderBranchStock();
  function renderBranchStock() {
    const host = shell.body.querySelector('#branch-stock');
    if (isEdit) {
      const rows = product.branchStock || [];
      host.innerHTML = `<p class="field-hint" style="margin-bottom:var(--sp-3)">Current stock per branch. To change it, use
        <a href="#/stock-adjustments">Inventory → Stock Adjustments</a> or receive a purchase — stock stays in sync with sales &amp; returns.</p>
        <div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>Branch</th><th class="num">Stock</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${escapeHtml(r.branchName)}</td><td class="num">${r.qty}</td></tr>`).join('')
            || '<tr><td colspan="2" class="muted">No stock records yet.</td></tr>'}</tbody>
        </table></div>`;
      renderStockSummary();
      return;
    }
    host.innerHTML = `
      <p class="field-hint" style="margin-bottom:var(--sp-3)">Select each branch that stocks this product and its opening quantity. The total is calculated automatically.</p>
      <div id="branch-rows" class="stack" style="--stack-gap:var(--sp-2)"></div>
      <button class="btn btn--sm btn--subtle" id="add-branch" style="margin-top:var(--sp-3)">${icon('plus', { size: 14 })} Add Another Branch</button>`;
    drawBranchRows();
    host.querySelector('#add-branch').addEventListener('click', () => {
      const used = new Set(branchRows.map((r) => r.branchId));
      const next = branches.find((b) => !used.has(b.id)) || branches[0];
      if (!next) return toast.warning('No more branches available.');
      branchRows.push({ branchId: next.id, qty: 0 });
      drawBranchRows();
      renderStockSummary();
    });
  }

  function drawBranchRows() {
    const host = shell.body.querySelector('#branch-rows');
    if (!host) return;
    host.innerHTML = branchRows.map((row, i) => {
      const used = new Set(branchRows.filter((_, j) => j !== i).map((r) => r.branchId));
      return `<div class="repeat-row" data-i="${i}" style="display:flex;gap:var(--sp-2);align-items:flex-end">
        <label class="field" style="flex:1"><span class="label">Branch</span>
          <select class="select js-b-branch">
            ${branches.map((b) => `<option value="${b.id}" ${b.id === row.branchId ? 'selected' : ''} ${used.has(b.id) ? 'disabled' : ''}>${escapeHtml(b.name)}</option>`).join('')}
          </select></label>
        <label class="field" style="width:130px"><span class="label">Stock Quantity</span>
          <input class="input js-b-qty" type="number" min="0" step="1" value="${row.qty}"></label>
        ${branchRows.length > 1 ? `<button class="btn btn--icon btn--ghost js-b-rm" style="color:var(--danger-fg)" aria-label="Remove">${icon('trash', { size: 14 })}</button>` : ''}
      </div>`;
    }).join('');
    host.querySelectorAll('.repeat-row').forEach((el) => {
      const i = Number(el.dataset.i);
      el.querySelector('.js-b-branch').addEventListener('change', (e) => {
        const val = e.target.value;
        if (branchRows.some((r, j) => j !== i && r.branchId === val)) {
          // merge into the existing row instead of duplicating
          const target = branchRows.find((r, j) => j !== i && r.branchId === val);
          target.qty = (Number(target.qty) || 0) + (Number(branchRows[i].qty) || 0);
          branchRows.splice(i, 1);
          toast.info('Branch already added — quantities merged.');
        } else {
          branchRows[i].branchId = val;
        }
        drawBranchRows();
        renderStockSummary();
      });
      el.querySelector('.js-b-qty').addEventListener('input', (e) => {
        branchRows[i].qty = Math.max(0, Math.trunc(Number(e.target.value) || 0));
        renderStockSummary();
      });
      el.querySelector('.js-b-rm')?.addEventListener('click', () => {
        branchRows.splice(i, 1);
        drawBranchRows();
        renderStockSummary();
      });
    });
  }

  function totalOpening() {
    if (isEdit) return (product.branchStock || []).reduce((s, r) => s + r.qty, 0);
    if (variants.length) return variants.reduce((s, v) => s + (Number(v.openingStock) || 0), 0);
    return branchRows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  }

  function renderStockSummary() {
    const total = totalOpening();
    const lines = [];
    if (!isEdit && !variants.length) {
      branchRows.forEach((r) => {
        const b = branches.find((x) => x.id === r.branchId);
        lines.push(`<div class="detail-list__row"><dt>${escapeHtml(b?.name || '—')}</dt><dd>${Number(r.qty) || 0}</dd></div>`);
      });
    }
    shell.body.querySelector('#stock-summary').innerHTML = `
      ${lines.join('')}
      <div class="detail-list__row" style="border-top:1px solid var(--border);margin-top:var(--sp-2);padding-top:var(--sp-2)">
        <dt class="strong">Total Initial Stock</dt><dd class="strong">${total} ${escapeHtml(formInfo.raw().unit || 'pcs')}</dd>
      </div>`;
  }
  renderStockSummary();

  /* ---- Variants ---- */
  function renderVariants() {
    const host = shell.body.querySelector('#variants');
    if (!variants.length) {
      host.innerHTML = '<p class="muted text-sm">No variants — this is a single product.</p>';
      renderStockSummary();
      return;
    }
    host.innerHTML = variants.map((v, i) => `<div class="repeat-row" data-i="${i}">
        <div class="field-grid">
          <label class="field"><span class="label">Name</span><input class="input js-v" data-k="name" value="${escapeHtml(v.name || '')}" placeholder="e.g. Ruby / Large"></label>
          <label class="field"><span class="label">SKU</span><input class="input js-v" data-k="sku" value="${escapeHtml(v.sku || '')}"></label>
          <label class="field"><span class="label">Barcode</span><input class="input js-v" data-k="barcode" value="${escapeHtml(v.barcode || '')}"></label>
          <label class="field"><span class="label">Cost</span><input class="input js-v" data-k="costPrice" type="number" step="0.01" value="${money.toMajor(v.costPrice || 0)}"></label>
          <label class="field"><span class="label">Selling</span><input class="input js-v" data-k="sellingPrice" type="number" step="0.01" value="${money.toMajor(v.sellingPrice || 0)}"></label>
          ${!isEdit ? `<label class="field"><span class="label">Opening stock</span><input class="input js-v" data-k="openingStock" type="number" min="0" value="${v.openingStock || 0}"></label>` : ''}
        </div>
        <button class="btn btn--sm btn--ghost js-rm-v" style="align-self:flex-start;color:var(--danger-fg)">${icon('trash', { size: 13 })} Remove</button>
      </div>`).join('');
    host.querySelectorAll('.repeat-row').forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelectorAll('.js-v').forEach((inp) => inp.addEventListener('input', () => {
        const k = inp.dataset.k;
        variants[i][k] = ['costPrice', 'sellingPrice'].includes(k) ? money.toMinor(inp.value) : (k === 'openingStock' ? Number(inp.value) : inp.value);
        if (k === 'openingStock') renderStockSummary();
      }));
      row.querySelector('.js-rm-v').addEventListener('click', () => { variants.splice(i, 1); renderVariants(); });
    });
    renderStockSummary();
  }
  renderVariants();
  shell.body.querySelector('#add-variant').addEventListener('click', () => {
    const name = formInfo.raw().name || 'Product';
    variants.push({ id: uuid(), name: '', options: {}, sku: suggestSku(name, ['V' + (variants.length + 1)]), barcode: generateEan13(Date.now() + variants.length), costPrice: formPricing.raw().costPrice || 0, sellingPrice: formPricing.raw().sellingPrice || 0, minStock: formPricing.raw().minStock || 0, openingStock: 0 });
    renderVariants();
  });

  /* ---- save ---- */
  shell.body.querySelector('#cancel').addEventListener('click', () => history.back());
  shell.body.querySelector('#save').addEventListener('click', () => save({ thenBarcode: false }));
  shell.body.querySelector('#gen-barcode').addEventListener('click', () => save({ thenBarcode: true }));

  function validateForm() {
    let ok = formInfo.validate();
    ok = formPricing.validate() && ok;
    if (!isEdit && !variants.length) {
      const seen = new Set();
      for (const r of branchRows) {
        if (!r.branchId) { toast.error('Select a branch for every Branch Stock row.'); ok = false; break; }
        if (seen.has(r.branchId)) { toast.error('The same branch is listed twice.'); ok = false; break; }
        seen.add(r.branchId);
        if (!Number.isInteger(Number(r.qty)) || Number(r.qty) < 0) { toast.error('Branch quantity must be a whole number (0 or more).'); ok = false; break; }
      }
    }
    return ok;
  }

  function collect() {
    const info = formInfo.getValues();
    const pricing = formPricing.getValues();
    const attr = formAttr.getValues();
    return {
      ...info,
      costPrice: pricing.costPrice,
      sellingPrice: pricing.sellingPrice,
      mrp: pricing.mrp === '' || pricing.mrp == null ? undefined : pricing.mrp,
      wholesalePrice: pricing.wholesalePrice || 0,
      discountPrice: pricing.discountPrice === '' || pricing.discountPrice == null ? null : pricing.discountPrice,
      taxId: pricing.taxId || '',
      minStock: pricing.minStock || 0,
      maxStock: pricing.maxStock || 0,
      attributes: { color: attr.color, size: attr.size, variant: attr.variant },
      imageId,
      variants: variants.map((vr) => ({ ...vr })),
      hasVariants: variants.length > 0,
      branchStock: isEdit || variants.length
        ? undefined
        : branchRows.filter((r) => r.branchId).map((r) => ({ branchId: r.branchId, qty: Math.max(0, Math.trunc(Number(r.qty) || 0)) })),
    };
  }

  async function save({ thenBarcode }) {
    if (!validateForm()) return;
    const btn = shell.body.querySelector(thenBarcode ? '#gen-barcode' : '#save');
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner--invert"></span> Saving…';
    try {
      const payload = collect();
      const saved = isEdit
        ? await productService.updateProduct(id, payload)
        : await productService.createProduct(payload);
      toast.success(isEdit ? 'Product updated' : 'Product created');
      if (thenBarcode) {
        const total = saved.totalStockAllBranches ?? saved.stock ?? totalOpening();
        location.hash = `#/barcodes?product=${saved.id}&qty=${total}`;
      } else {
        location.hash = `#/products/${saved.id}`;
      }
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = label;
      if (err.data?.errors) {
        Object.entries(err.data.errors).forEach(([f, m]) => {
          formInfo.setError(f, m);
          formPricing.setError(f, m);
        });
        toast.error('Please fix the highlighted fields.');
      } else {
        toast.fromError(err);
      }
    }
  }
}
