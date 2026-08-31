/**
 * purchase-form.js - create a purchase order (multi-line).
 */
import { pageShell } from '../shared/page-kit.js';
import { blockLoader } from '../../components/skeleton.js';
import { toast } from '../../components/toast.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce } from '../../utils/debounce.js';
import money from '../../utils/money.js';
import purchaseService from '../../services/purchase-service.js';
import supplierService from '../../services/supplier-service.js';
import productService from '../../services/product-service.js';

export default async function purchaseFormPage(ctx, mount) {
  mount.innerHTML = blockLoader('Loading…');
  const supRes = await supplierService.getSuppliers({ pageSize: 'all' });
  const suppliers = supRes.data || supRes;

  const lines = [];
  let paidTotal = 0;

  const shell = pageShell(mount, {
    title: 'New Purchase',
    breadcrumb: [{ label: 'Purchases', href: '#/purchases' }, { label: 'New' }],
  });

  shell.body.innerHTML = `<div class="form-layout">
    <div class="form-layout__main">
      <div class="card card--pad">
        <div class="field-grid">
          <label class="field"><span class="label">Supplier <span class="req">*</span></span>
            <select class="select js-supplier"><option value="">Select supplier…</option>${suppliers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}</select></label>
          <label class="field"><span class="label">Supplier invoice ref</span><input class="input js-invref"></label>
          <label class="field"><span class="label">Expected date</span><input class="input js-expected" type="date"></label>
          <label class="field"><span class="label">Save as</span>
            <select class="select js-status"><option value="ordered">Ordered</option><option value="draft">Draft</option></select></label>
        </div>
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Note</span><textarea class="textarea js-note" rows="2"></textarea></label>
      </div>
      <div class="card card--pad">
        <div class="form-section-title">Items</div>
        <div class="input-search" style="margin:var(--sp-2) 0">
          <span class="input-search__icon">${icon('search', { size: 16 })}</span>
          <input class="input js-search" placeholder="Search product to add…" autocomplete="off">
        </div>
        <div class="js-results stack" style="--stack-gap:2px"></div>
        <div class="js-lines" style="margin-top:var(--sp-3)"></div>
      </div>
    </div>
    <div class="form-layout__side">
      <div class="card card--pad">
        <div class="form-section-title">Summary</div>
        <dl class="detail-list js-summary"></dl>
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Amount paid now</span>
          <input class="input js-paid" type="number" step="0.01" min="0" value="0"></label>
      </div>
      <div class="form-actions">
        <button class="btn btn--ghost" id="cancel">Cancel</button>
        <button class="btn btn--primary" id="save" disabled>Create Purchase</button>
      </div>
    </div>
  </div>`;

  const $ = (s) => shell.body.querySelector(s);
  const results = $('.js-results');

  const search = debounce(async () => {
    const term = $('.js-search').value.trim();
    if (!term) { results.innerHTML = ''; return; }
    const res = await productService.getProducts({ search: term, pageSize: 8, status: 'all' });
    results.innerHTML = (res.data || []).map((p) => `<button class="btn btn--ghost js-add" data-id="${p.id}" style="justify-content:space-between">
      <span>${escapeHtml(p.name)}</span><span class="muted">cost ${money.format(p.costPrice)}</span></button>`).join('');
    results.querySelectorAll('.js-add').forEach((b) => b.addEventListener('click', () => {
      const p = res.data.find((x) => x.id === b.dataset.id);
      if (lines.some((l) => l.productId === p.id)) return;
      lines.push({ productId: p.id, variantId: p.variants?.[0]?.id || null, name: p.name, qty: 1, unitCost: p.costPrice, discountType: null, discountValue: 0, taxRate: 0 });
      $('.js-search').value = '';
      results.innerHTML = '';
      renderLines();
    }));
  }, 220);
  $('.js-search').addEventListener('input', search);

  function renderLines() {
    const host = $('.js-lines');
    host.innerHTML = lines.length ? `<table class="table table--compact"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Line total</th><th></th></tr></thead>
      <tbody>${lines.map((l, i) => `<tr data-i="${i}">
        <td>${escapeHtml(l.name)}</td>
        <td class="num"><input class="input js-q" type="number" min="1" value="${l.qty}" style="width:70px;text-align:right"></td>
        <td class="num"><input class="input js-c" type="number" step="0.01" min="0" value="${money.toMajor(l.unitCost)}" style="width:100px;text-align:right"></td>
        <td class="num">${money.format(l.qty * l.unitCost)}</td>
        <td class="num"><button class="btn btn--icon btn--ghost btn--sm js-rm">${icon('x', { size: 14 })}</button></td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted text-sm">Add at least one product.</p>';
    host.querySelectorAll('tr[data-i]').forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('.js-q').addEventListener('input', (e) => { lines[i].qty = Math.max(1, Math.trunc(Number(e.target.value) || 1)); renderLines(); });
      tr.querySelector('.js-c').addEventListener('input', (e) => { lines[i].unitCost = money.toMinor(e.target.value); renderLines(); });
      tr.querySelector('.js-rm').addEventListener('click', () => { lines.splice(i, 1); renderLines(); });
    });
    renderSummary();
  }

  function renderSummary() {
    const subtotal = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    paidTotal = money.toMinor($('.js-paid').value);
    $('.js-summary').innerHTML = `
      <div class="detail-list__row"><dt>Items</dt><dd>${lines.length}</dd></div>
      <div class="detail-list__row"><dt>Units</dt><dd>${lines.reduce((s, l) => s + l.qty, 0)}</dd></div>
      <div class="detail-list__row"><dt>Subtotal</dt><dd>${money.format(subtotal)}</dd></div>
      <div class="detail-list__row"><dt>Total</dt><dd class="strong">${money.format(subtotal)}</dd></div>
      <div class="detail-list__row"><dt>Due</dt><dd>${money.format(Math.max(0, subtotal - paidTotal))}</dd></div>`;
    $('#save').disabled = !lines.length || !$('.js-supplier').value;
  }
  $('.js-paid').addEventListener('input', renderSummary);
  $('.js-supplier').addEventListener('change', renderSummary);
  renderLines();

  $('#cancel').addEventListener('click', () => history.back());
  $('#save').addEventListener('click', async () => {
    const btn = $('#save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner--invert"></span> Creating…';
    try {
      const purchase = await purchaseService.createPurchase({
        supplierId: $('.js-supplier').value,
        invoiceRef: $('.js-invref').value,
        expectedAt: $('.js-expected').value || null,
        status: $('.js-status').value,
        note: $('.js-note').value,
        paidTotal: money.toMinor($('.js-paid').value),
        lines: lines.map((l) => ({ ...l })),
      });
      toast.success('Purchase created');
      location.hash = `#/purchases/${purchase.id}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Create Purchase';
      toast.fromError(err);
    }
  });
}
