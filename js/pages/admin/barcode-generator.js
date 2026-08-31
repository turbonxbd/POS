/**
 * barcode-generator.js - build a queue of products and print barcode pages.
 *
 * ONE barcode = ONE page (js/pages/shared/barcode-label.js). Page size, content
 * and the "show MRP + selling price" option all come from Settings -> Print ->
 * Barcode. Deep link: #/barcodes?product=<id>&qty=<n> pre-loads that product
 * with its total branch stock as the barcode quantity (still editable).
 */
import { pageShell } from '../shared/page-kit.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce } from '../../utils/debounce.js';
import { toast } from '../../components/toast.js';
import { printHtml } from '../../utils/print.js';
import money from '../../utils/money.js';
import productService from '../../services/product-service.js';
import barcodeService from '../../services/barcode-service.js';
import settingsService from '../../services/settings-service.js';
import { barcodeConfig, resolveSize } from '../../core/print-config.js';
import { buildBarcodePages, buildSingleLabel } from '../shared/barcode-label.js';
import bus from '../../core/event-bus.js';

export default async function barcodeGeneratorPage(ctx, mount) {
  let settings = await settingsService.getSettings();
  const queue = []; // { productId?, name, sku, barcode, sellingPrice, mrp, costPrice, qty, availableStock? }

  const shell = pageShell(mount, {
    title: 'Barcode Generator',
    subtitle: 'Add products, set how many barcodes to print, then print one barcode per page.',
    actions: [
      { label: 'Generate blank codes', icon: 'barcode', variant: 'outline', onClick: genBlank },
      { label: 'Print', icon: 'print', variant: 'primary', onClick: printPages },
    ],
  });

  shell.body.innerHTML = `
    <div class="form-layout">
      <div class="form-layout__main">
        <div class="card card--pad">
          <div class="input-search"><span class="input-search__icon">${icon('search', { size: 16 })}</span>
            <input class="input js-search" placeholder="Search a product to add…" autocomplete="off"></div>
          <div class="js-results stack" style="--stack-gap:2px;margin-top:var(--sp-2)"></div>
        </div>
        <div class="card card--pad">
          <div class="form-section-title">Print queue</div>
          <div class="js-queue"></div>
          <div class="js-totals" style="margin-top:var(--sp-3)"></div>
        </div>
      </div>
      <div class="form-layout__side">
        <div class="card card--pad">
          <div class="form-section-title">Label preview</div>
          <div class="js-page-meta muted text-sm" style="margin-bottom:var(--sp-2)"></div>
          <div class="js-preview" style="text-align:center;overflow:auto"></div>
          <a class="btn btn--ghost btn--sm" href="#/settings?section=print" style="margin-top:var(--sp-3)">${icon('settings', { size: 14 })} Barcode print settings</a>
        </div>
      </div>
    </div>`;

  const $ = (s) => shell.body.querySelector(s);

  /* ---- deep link: pre-load a product ---- */
  if (ctx.query?.product) {
    try {
      const p = await productService.getProductById(ctx.query.product, { allBranches: true });
      const avail = p.totalStockAllBranches ?? p.stock ?? 0;
      const wanted = ctx.query.qty != null && ctx.query.qty !== '' ? Math.max(0, Math.trunc(Number(ctx.query.qty))) : avail;
      queue.push({
        productId: p.id, name: p.name, sku: p.sku, barcode: p.barcode,
        sellingPrice: p.sellingPrice, mrp: p.mrp ?? 0, costPrice: p.costPrice,
        brandName: p.brandName || "", attributes: p.attributes || {},
        availableStock: avail, qty: Math.max(1, wanted || 1),
      });
    } catch (err) {
      toast.error(err?.data?.message || 'Could not load that product.');
    }
  }

  /* ---- search + add ---- */
  const search = debounce(async () => {
    const term = $('.js-search').value.trim();
    if (!term) { $('.js-results').innerHTML = ''; return; }
    const res = await productService.getProducts({ search: term, pageSize: 10, status: 'all' });
    $('.js-results').innerHTML = (res.data || []).map((p) => `<button class="btn btn--ghost js-add" data-id="${p.id}" style="justify-content:space-between">
      <span>${escapeHtml(p.name)}</span><span class="muted mono">${escapeHtml(p.barcode)}</span></button>`).join('');
    $('.js-results').querySelectorAll('.js-add').forEach((b) => b.addEventListener('click', async () => {
      const listed = res.data.find((x) => x.id === b.dataset.id);
      const existing = queue.find((q) => q.barcode === listed.barcode);
      if (existing) {
        existing.qty += 1;
      } else {
        let avail = listed.stock ?? 0;
        try {
          const full = await productService.getProductById(listed.id, { allBranches: true });
          avail = full.totalStockAllBranches ?? full.stock ?? avail;
          queue.push({ productId: full.id, name: full.name, sku: full.sku, barcode: full.barcode, sellingPrice: full.sellingPrice, mrp: full.mrp ?? 0, costPrice: full.costPrice, brandName: full.brandName || "", attributes: full.attributes || {}, availableStock: avail, qty: Math.max(1, avail || 1) });
        } catch {
          queue.push({ productId: listed.id, name: listed.name, sku: listed.sku, barcode: listed.barcode, sellingPrice: listed.sellingPrice, mrp: listed.mrp ?? 0, costPrice: listed.costPrice, brandName: listed.brandName || "", attributes: listed.attributes || {}, availableStock: avail, qty: Math.max(1, avail || 1) });
        }
      }
      $('.js-search').value = '';
      $('.js-results').innerHTML = '';
      renderQueue();
    }));
  }, 220);
  $('.js-search').addEventListener('input', search);

  /* ---- queue ---- */
  function renderQueue() {
    const host = $('.js-queue');
    if (!queue.length) {
      host.innerHTML = '<p class="muted text-sm">Search a product above, or open this page from a product\'s <strong>Barcode</strong> action / <strong>Generate Barcode</strong> on the product form.</p>';
      renderTotals();
      renderPreview();
      return;
    }
    host.innerHTML = `<div class="table-wrap"><table class="table table--compact">
      <thead><tr><th>Product</th><th>Barcode</th><th class="num">Available</th><th class="num">Barcodes to generate</th><th></th></tr></thead>
      <tbody>${queue.map((q, i) => `<tr data-i="${i}">
        <td>${escapeHtml(q.name)}${q.mrp > q.sellingPrice ? `<br><span class="muted text-xs"><s>${money.format(q.mrp)}</s> ${money.format(q.sellingPrice)}</span>` : ''}</td>
        <td class="mono">${escapeHtml(q.barcode)}</td>
        <td class="num">${q.availableStock != null ? q.availableStock : '—'}</td>
        <td class="num"><input class="input js-qty" type="number" min="1" step="1" value="${q.qty}" style="width:90px;text-align:right"></td>
        <td class="num"><button class="btn btn--icon btn--ghost btn--sm js-rm" aria-label="Remove">${icon('x', { size: 14 })}</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
    host.querySelectorAll('tr[data-i]').forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('.js-qty').addEventListener('input', (e) => {
        queue[i].qty = Math.max(1, Math.trunc(Number(e.target.value) || 1));
        renderTotals();
      });
      tr.querySelector('.js-rm').addEventListener('click', () => { queue.splice(i, 1); renderQueue(); });
    });
    renderTotals();
    renderPreview();
  }

  function renderTotals() {
    const avail = queue.reduce((s, q) => s + (q.availableStock || 0), 0);
    const toGen = queue.reduce((s, q) => s + Math.max(1, Number(q.qty) || 1), 0);
    $('.js-totals').innerHTML = queue.length
      ? `<div class="stat-strip">
          <div class="stat-strip__item"><div class="label">Available Initial Stock</div><div class="value">${avail}</div></div>
          <div class="stat-strip__item"><div class="label">Barcodes to Generate</div><div class="value">${toGen}</div></div>
        </div>
        ${toGen !== avail && avail > 0 ? `<p class="field-hint" style="margin-top:var(--sp-2)">You are generating <strong>${toGen}</strong> barcode${toGen === 1 ? '' : 's'} — the available stock is <strong>${avail}</strong>. Adjust the quantity above if this is not intended.</p>` : ''}`
      : '';
  }

  function renderPreview() {
    const cfg = barcodeConfig(settings);
    const sz = resolveSize(cfg);
    const total = queue.reduce((s, q) => s + Math.max(1, Number(q.qty) || 1), 0);
    $('.js-page-meta').textContent = `${sz.w}${sz.unit} × ${sz.h}${sz.unit} · one barcode per page · ${total} page${total === 1 ? '' : 's'}`;
    const sample = queue[0] || { name: 'Sample Product', sku: 'SKU-000', barcode: '8901234500011', sellingPrice: 45000, mrp: 52000, costPrice: 26000 };
    $('.js-preview').innerHTML = buildSingleLabel(sample, { settings });
  }

  function genBlank() {
    const codes = barcodeService.generateLocal(12);
    codes.forEach((c) => queue.push({ name: 'New label', sku: '', barcode: c, sellingPrice: 0, mrp: 0, costPrice: 0, availableStock: null, qty: 1 }));
    renderQueue();
    toast.success('12 blank codes generated');
  }

  function printPages() {
    if (!queue.length) return toast.warning('Add a product first.');
    printHtml(buildBarcodePages(queue, { settings }));
  }

  const off = bus.on('settings:changed', (next) => { settings = next; renderQueue(); });
  bus.once('router:before', () => off());

  renderQueue();
}
