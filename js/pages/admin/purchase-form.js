/**
 * purchase-form.js - create or edit a purchase order (multi-line).
 * Edit is allowed while the PO is still a draft or ordered (not received/cancelled).
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
  const editId = ctx.params.id || null;
  const [supRes, existing] = await Promise.all([
    supplierService.getSuppliers({ pageSize: 'all' }),
    editId ? purchaseService.getPurchaseById(editId).catch(() => null) : Promise.resolve(null),
  ]);
  const suppliers = supRes.data || supRes;

  if (editId && !existing) {
    pageShell(mount, { title: 'Purchase' }).body.innerHTML = '<div class="card"><div class="alert alert--danger"><div class="alert__body">Purchase not found.</div></div></div>';
    return;
  }
  if (existing && ['received', 'cancelled', 'partially_received'].includes(existing.status)) {
    location.hash = `#/purchases/${editId}`;
    toast.warning('A received or cancelled purchase can no longer be edited.');
    return;
  }

  const lines = (existing?.lines || []).map((l) => ({
    id: l.id, productId: l.productId, variantId: l.variantId || null, name: l.name || l.productName || l.productId,
    qty: l.qty, unitCost: l.unitCost, discountType: l.discountType || null, discountValue: l.discountValue || 0, taxRate: l.taxRate || 0,
  }));
  let paidTotal = existing?.paidTotal || 0;
  let freight = existing?.freightTotal || 0;

  const shell = pageShell(mount, {
    title: editId ? `Edit ${existing.reference}` : 'New Purchase',
    breadcrumb: [{ label: 'Purchases', href: '#/purchases' }, { label: editId ? existing.reference : 'New' }],
  });

  shell.body.innerHTML = `<div class="form-layout">
    <div class="form-layout__main">
      <div class="card card--pad">
        <div class="field-grid">
          <label class="field"><span class="label">Supplier <span class="req">*</span></span>
            <select class="select js-supplier"><option value="">Select supplier…</option>${suppliers.map((s) => `<option value="${s.id}" ${existing?.supplierId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}</select></label>
          <label class="field"><span class="label">Supplier invoice ref</span><input class="input js-invref" value="${escapeHtml(existing?.invoiceRef || '')}"></label>
          <label class="field"><span class="label">Expected date</span><input class="input js-expected" type="date" value="${(existing?.expectedAt || '').slice(0, 10)}"></label>
          <label class="field"><span class="label">Save as</span>
            <select class="select js-status">
              <option value="ordered" ${existing?.status === 'ordered' ? 'selected' : ''}>Ordered</option>
              <option value="draft" ${!existing || existing?.status === 'draft' ? 'selected' : ''}>Draft</option>
            </select></label>
        </div>
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Note</span><textarea class="textarea js-note" rows="2">${escapeHtml(existing?.note || '')}</textarea></label>
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
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Freight / other charges</span>
          <input class="input js-freight" type="number" step="0.01" min="0" value="${money.toMajor(freight)}"></label>
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Amount paid now</span>
          <input class="input js-paid" type="number" step="0.01" min="0" value="${money.toMajor(paidTotal)}"></label>
      </div>
      <div class="form-actions">
        <button class="btn btn--ghost" id="cancel">Cancel</button>
        <button class="btn btn--primary" id="save" disabled>${editId ? 'Save changes' : 'Create Purchase'}</button>
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

  function lineNet(l) {
    const gross = l.qty * l.unitCost;
    const disc = l.discountType === 'percent' ? money.percent(gross, l.discountValue || 0) : 0;
    const net = Math.max(0, gross - disc);
    return net + (l.taxRate ? money.percent(net, l.taxRate) : 0);
  }

  function renderLines() {
    const host = $('.js-lines');
    host.innerHTML = lines.length ? `<div class="table-wrap"><table class="table table--compact"><thead><tr>
        <th>Product</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Disc %</th><th class="num">VAT %</th><th class="num">Line total</th><th></th></tr></thead>
      <tbody>${lines.map((l, i) => `<tr data-i="${i}">
        <td>${escapeHtml(l.name)}</td>
        <td class="num"><input class="input js-q" type="number" min="1" value="${l.qty}" style="width:64px;text-align:right"></td>
        <td class="num"><input class="input js-c" type="number" step="0.01" min="0" value="${money.toMajor(l.unitCost)}" style="width:92px;text-align:right"></td>
        <td class="num"><input class="input js-d" type="number" step="0.5" min="0" max="100" value="${l.discountType === 'percent' ? l.discountValue : 0}" style="width:64px;text-align:right"></td>
        <td class="num"><input class="input js-t" type="number" step="0.5" min="0" max="100" value="${l.taxRate || 0}" style="width:64px;text-align:right"></td>
        <td class="num">${money.format(lineNet(l))}</td>
        <td class="num"><button class="btn btn--icon btn--ghost btn--sm js-rm">${icon('x', { size: 14 })}</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted text-sm">Add at least one product.</p>';
    host.querySelectorAll('tr[data-i]').forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('.js-q').addEventListener('input', (e) => { lines[i].qty = Math.max(1, Math.trunc(Number(e.target.value) || 1)); renderLines(); });
      tr.querySelector('.js-c').addEventListener('input', (e) => { lines[i].unitCost = money.toMinor(e.target.value); renderLines(); });
      tr.querySelector('.js-d').addEventListener('input', (e) => {
        const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
        lines[i].discountType = v > 0 ? 'percent' : null;
        lines[i].discountValue = v;
        renderLines();
      });
      tr.querySelector('.js-t').addEventListener('input', (e) => { lines[i].taxRate = Math.max(0, Math.min(100, Number(e.target.value) || 0)); renderLines(); });
      tr.querySelector('.js-rm').addEventListener('click', () => { lines.splice(i, 1); renderLines(); });
    });
    renderSummary();
  }

  function renderSummary() {
    const subtotal = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    const discountTotal = lines.reduce((s, l) => s + (l.discountType === 'percent' ? money.percent(l.qty * l.unitCost, l.discountValue || 0) : 0), 0);
    const taxTotal = lines.reduce((s, l) => {
      const net = Math.max(0, l.qty * l.unitCost - (l.discountType === 'percent' ? money.percent(l.qty * l.unitCost, l.discountValue || 0) : 0));
      return s + (l.taxRate ? money.percent(net, l.taxRate) : 0);
    }, 0);
    freight = money.toMinor($('.js-freight').value);
    paidTotal = money.toMinor($('.js-paid').value);
    const grand = subtotal - discountTotal + taxTotal + Math.max(0, freight);
    $('.js-summary').innerHTML = `
      <div class="detail-list__row"><dt>Items</dt><dd>${lines.length}</dd></div>
      <div class="detail-list__row"><dt>Units</dt><dd>${lines.reduce((s, l) => s + l.qty, 0)}</dd></div>
      <div class="detail-list__row"><dt>Subtotal</dt><dd>${money.format(subtotal)}</dd></div>
      ${discountTotal ? `<div class="detail-list__row"><dt>Discount</dt><dd>-${money.format(discountTotal)}</dd></div>` : ''}
      ${taxTotal ? `<div class="detail-list__row"><dt>VAT</dt><dd>${money.format(taxTotal)}</dd></div>` : ''}
      ${freight ? `<div class="detail-list__row"><dt>Freight</dt><dd>${money.format(freight)}</dd></div>` : ''}
      <div class="detail-list__row"><dt>Total</dt><dd class="strong">${money.format(grand)}</dd></div>
      <div class="detail-list__row"><dt>Due</dt><dd>${money.format(Math.max(0, grand - paidTotal))}</dd></div>`;
    $('#save').disabled = !lines.length || !$('.js-supplier').value || paidTotal > grand;
  }
  $('.js-paid').addEventListener('input', renderSummary);
  $('.js-freight').addEventListener('input', renderSummary);
  $('.js-supplier').addEventListener('change', renderSummary);
  renderLines();

  $('#cancel').addEventListener('click', () => history.back());
  $('#save').addEventListener('click', async () => {
    const btn = $('#save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner--invert"></span> Saving…';
    const payload = {
      supplierId: $('.js-supplier').value,
      invoiceRef: $('.js-invref').value,
      expectedAt: $('.js-expected').value || null,
      status: $('.js-status').value,
      note: $('.js-note').value,
      freight: money.toMinor($('.js-freight').value),
      paidTotal: money.toMinor($('.js-paid').value),
      lines: lines.map((l) => ({ ...l })),
    };
    try {
      const purchase = editId
        ? await purchaseService.updatePurchase(editId, payload)
        : await purchaseService.createPurchase(payload);
      toast.success(editId ? 'Purchase updated' : 'Purchase created');
      location.hash = `#/purchases/${purchase.id || editId}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = editId ? 'Save changes' : 'Create Purchase';
      toast.fromError(err);
    }
  });
}
