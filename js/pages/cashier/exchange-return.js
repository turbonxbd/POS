/**
 * exchange-return.js - Cashier: Exchange / Return.
 *
 * Scan the invoice barcode -> the original sale loads -> pick products + return
 * quantities -> Return (refund) or Exchange (swap + price difference) -> confirm
 * -> the existing POST /sales/:id/returns records it, restocks the returned goods
 * to the original branch, deducts the replacement, and it shows up in the admin
 * Sales Returns list, dashboard and reports. Receipt uses the existing printing.
 */
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce } from '../../utils/debounce.js';
import { fmtDate, fmtTime } from '../../utils/date.js';
import money from '../../utils/money.js';
import salesService from '../../services/sales-service.js';
import productService from '../../services/product-service.js';
import settingsService from '../../services/settings-service.js';
import { printHtml } from '../../utils/print.js';
import { buildReturnReceipt } from '../shared/return-receipt.js';

const REASONS = [
  { value: 'customer_request', label: 'Customer changed mind' },
  { value: 'defective', label: 'Defective / faulty' },
  { value: 'damaged', label: 'Damaged (do not restock)' },
  { value: 'wrong_item', label: 'Wrong item sold' },
  { value: 'expired', label: 'Expired product' },
];
const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'mobile', label: 'Mobile Banking' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'store_credit', label: 'Store credit' },
];

export function openExchangeReturn() {
  const state = {
    sale: null,
    mode: 'return', // 'return' | 'exchange'
    ret: {}, // saleItemId -> qty
    reps: [], // { productId, variantId, name, sku, unitPrice, stock, qty }
    reason: 'customer_request',
    method: 'cash',
    note: '',
  };

  const m = openModal({
    title: 'Exchange / Return',
    size: 'xl',
    body: scanView(),
    footer: '',
  });
  wireScan();

  /* -------------------------------------------------- step 1: scan invoice */
  function scanView() {
    return `
      <div class="xr-scan">
        <label class="label">Scan invoice barcode</label>
        <div class="input-search" style="height:52px">
          <span class="input-search__icon">${icon('barcode', { size: 20 })}</span>
          <input class="input js-inv" placeholder="Scan or type the invoice number, e.g. AFIA-BAN-00042"
            autocomplete="off" style="font-size:var(--fs-lg);font-family:var(--font-mono)">
        </div>
        <p class="field-hint">The customer's receipt has this barcode. Manual entry works too — press Enter.</p>
        <div class="js-inv-msg"></div>
      </div>`;
  }
  function wireScan() {
    const inp = m.$('.js-inv');
    inp?.focus();
    const go = async () => {
      const no = inp.value.trim();
      if (!no) return;
      m.$('.js-inv-msg').innerHTML = '<p class="muted text-sm">Looking up…</p>';
      try {
        const found = await salesService.lookupByInvoice(no);
        const full = await salesService.getSaleById(found.id);
        state.sale = full;
        const eligible = (full.items || []).some((it) => it.qty - (it.returnedQty || 0) > 0);
        if (!eligible) {
          m.$('.js-inv-msg').innerHTML = `<div class="alert alert--warning"><div class="alert__body">This invoice has no remaining eligible products for return or exchange.</div></div>`;
          return;
        }
        renderMain();
      } catch (err) {
        m.$('.js-inv-msg').innerHTML = `<div class="alert alert--danger"><div class="alert__body">${
          err?.status === 404 ? 'Invoice not found. Please check the barcode and try again.' : escapeHtml(err?.data?.message || err.message)
        }</div></div>`;
      }
    };
    inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    // scanners "type" fast then send Enter; also react to a paste/blur
    inp?.addEventListener('change', go);
  }

  /* -------------------------------------------------- step 2: review + choose */
  function renderMain() {
    const s = state.sale;
    const items = (s.items || []).map((it) => ({ ...it, remaining: it.qty - (it.returnedQty || 0) }));
    m.setBody(`
      <div class="xr">
        <div class="xr-orig card card--pad">
          <div class="row-between"><strong class="mono">${escapeHtml(s.invoiceNo)}</strong>
            <button class="btn btn--ghost btn--sm js-rescan">${icon('barcode', { size: 14 })} Scan another</button></div>
          <div class="xr-meta">
            <span>${fmtDate(s.createdAt)} ${fmtTime(s.createdAt)}</span>
            <span>${escapeHtml(s.customerName || 'Walk-in Customer')}${s.customerPhone ? ' · ' + escapeHtml(s.customerPhone) : ''}</span>
            <span>Cashier: ${escapeHtml(s.cashierName || '—')}</span>
            <span>Branch: ${escapeHtml(s.branchName || '—')}</span>
            <span>Paid: ${escapeHtml(s.paymentSummary || '—')}</span>
            <span>Original total: <strong>${money.format(s.grandTotal)}</strong></span>
          </div>
        </div>

        <div class="card card--pad">
          <div class="form-section-title">Select products to return / exchange</div>
          <div class="table-wrap"><table class="table table--compact">
            <thead><tr><th>Product</th><th>SKU</th><th class="num">Bought</th><th class="num">Unit</th><th class="num">Eligible</th><th class="num">Return qty</th></tr></thead>
            <tbody>${items.map((it) => `<tr data-id="${it.id}" ${it.remaining <= 0 ? 'style="opacity:.5"' : ''}>
              <td>${escapeHtml(it.name)}</td>
              <td class="mono text-xs">${escapeHtml(it.sku || '—')}</td>
              <td class="num">${it.qty}</td>
              <td class="num">${money.format(Math.round(it.lineTotal / it.qty))}</td>
              <td class="num">${it.remaining}</td>
              <td class="num"><input class="input js-rq" type="number" min="0" max="${it.remaining}" value="${state.ret[it.id] || 0}" ${it.remaining <= 0 ? 'disabled' : ''} style="width:78px;text-align:right"></td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>

        <div class="segmented xr-mode" role="tablist">
          <button data-mode="return" aria-pressed="${state.mode === 'return'}">${icon('undo', { size: 15 })} Return</button>
          <button data-mode="exchange" aria-pressed="${state.mode === 'exchange'}">${icon('refresh-cw', { size: 15 })} Exchange</button>
        </div>

        <div class="card card--pad js-mode-body"></div>

        <div class="card card--pad xr-summary js-summary"></div>
      </div>`);

    m.$('.js-rescan').addEventListener('click', () => { state.sale = null; state.ret = {}; state.reps = []; m.setBody(scanView()); m.setFooter(''); wireScan(); });
    m.$$('.js-rq').forEach((inp) => inp.addEventListener('input', () => {
      const id = inp.closest('tr').dataset.id;
      const max = Number(inp.max);
      let q = Math.max(0, Math.min(max, Math.trunc(Number(inp.value) || 0)));
      inp.value = q;
      if (q) state.ret[id] = q; else delete state.ret[id];
      renderSummary();
    }));
    m.$$('.xr-mode button').forEach((b) => b.addEventListener('click', () => {
      state.mode = b.dataset.mode;
      m.$$('.xr-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderModeBody();
      renderSummary();
    }));
    renderModeBody();
    renderSummary();
  }

  function renderModeBody() {
    const host = m.$('.js-mode-body');
    if (state.mode === 'return') {
      host.innerHTML = `
        <div class="form-section-title">Refund</div>
        <div class="field-grid">
          <label class="field"><span class="label">Reason</span>
            <select class="select js-reason">${REASONS.map((r) => `<option value="${r.value}" ${r.value === state.reason ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
          <label class="field"><span class="label">Refund method</span>
            <select class="select js-method">${METHODS.map((r) => `<option value="${r.value}" ${r.value === state.method ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
        </div>
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Note <span class="opt">optional</span></span>
          <input class="input js-note" value="${escapeHtml(state.note)}"></label>`;
    } else {
      host.innerHTML = `
        <div class="form-section-title">Replacement products</div>
        <div class="input-search"><span class="input-search__icon">${icon('search', { size: 16 })}</span>
          <input class="input js-rep-search" placeholder="Search a replacement product…" autocomplete="off"></div>
        <div class="js-rep-results stack" style="--stack-gap:2px;margin-top:var(--sp-2)"></div>
        <div class="js-rep-list" style="margin-top:var(--sp-3)"></div>
        <div class="field-grid" style="margin-top:var(--sp-3)">
          <label class="field"><span class="label">Reason for return</span>
            <select class="select js-reason">${REASONS.map((r) => `<option value="${r.value}" ${r.value === state.reason ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
          <label class="field"><span class="label">Payment / refund method for the difference</span>
            <select class="select js-method">${METHODS.map((r) => `<option value="${r.value}" ${r.value === state.method ? 'selected' : ''}>${r.label}</option>`).join('')}</select></label>
        </div>`;
      wireRepSearch();
      renderRepList();
    }
    host.querySelector('.js-reason')?.addEventListener('change', (e) => { state.reason = e.target.value; });
    host.querySelector('.js-method')?.addEventListener('change', (e) => { state.method = e.target.value; });
    host.querySelector('.js-note')?.addEventListener('input', (e) => { state.note = e.target.value; });
  }

  function wireRepSearch() {
    const search = debounce(async () => {
      const term = m.$('.js-rep-search').value.trim();
      if (!term) { m.$('.js-rep-results').innerHTML = ''; return; }
      const res = await productService.getProducts({ search: term, branchId: state.sale.branchId, pageSize: 8, status: 'active' });
      m.$('.js-rep-results').innerHTML = (res.data || []).map((p) => `<button class="btn btn--ghost js-rep-add" data-id="${p.id}" style="justify-content:space-between">
        <span>${escapeHtml(p.name)}</span><span class="muted text-xs">${money.format(p.sellingPrice)} · stock ${p.stock}</span></button>`).join('');
      m.$$('.js-rep-add').forEach((b) => b.addEventListener('click', () => {
        const p = res.data.find((x) => x.id === b.dataset.id);
        const ex = state.reps.find((r) => r.productId === p.id && !r.variantId);
        if (ex) ex.qty += 1;
        else state.reps.push({ productId: p.id, variantId: null, name: p.name, sku: p.sku, unitPrice: p.discountPrice ?? p.sellingPrice, stock: p.stock ?? 0, qty: 1 });
        m.$('.js-rep-search').value = '';
        m.$('.js-rep-results').innerHTML = '';
        renderRepList();
        renderSummary();
      }));
    }, 220);
    m.$('.js-rep-search').addEventListener('input', search);
  }

  function renderRepList() {
    const host = m.$('.js-rep-list');
    if (!host) return;
    if (!state.reps.length) { host.innerHTML = '<p class="muted text-sm">No replacement products chosen yet.</p>'; return; }
    host.innerHTML = `<div class="table-wrap"><table class="table table--compact">
      <thead><tr><th>Replacement</th><th class="num">Unit</th><th class="num">Stock</th><th class="num">Qty</th><th></th></tr></thead>
      <tbody>${state.reps.map((r, i) => `<tr data-i="${i}">
        <td>${escapeHtml(r.name)}${r.qty > r.stock ? ' <span class="badge badge--danger">low stock</span>' : ''}</td>
        <td class="num">${money.format(r.unitPrice)}</td>
        <td class="num">${r.stock}</td>
        <td class="num"><input class="input js-rep-q" type="number" min="1" value="${r.qty}" style="width:70px;text-align:right"></td>
        <td class="num"><button class="btn btn--icon btn--ghost btn--sm js-rep-rm">${icon('x', { size: 14 })}</button></td>
      </tr>`).join('')}</tbody></table></div>`;
    host.querySelectorAll('tr[data-i]').forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('.js-rep-q').addEventListener('input', (e) => { state.reps[i].qty = Math.max(1, Math.trunc(Number(e.target.value) || 1)); renderRepList(); renderSummary(); });
      tr.querySelector('.js-rep-rm').addEventListener('click', () => { state.reps.splice(i, 1); renderRepList(); renderSummary(); });
    });
  }

  /* -------------------------------------------------- summary + confirm */
  function returnRefundEstimate() {
    let total = 0;
    for (const it of state.sale.items || []) {
      const q = state.ret[it.id] || 0;
      if (!q) continue;
      const perUnitNet = Math.round((it.lineTotal - it.taxAmount) / it.qty);
      const perUnitTax = Math.round(it.taxAmount / it.qty);
      total += (perUnitNet + perUnitTax) * q;
    }
    return total;
  }
  function replacementEstimate() {
    return state.reps.reduce((s, r) => s + r.unitPrice * r.qty, 0);
  }

  function renderSummary() {
    const host = m.$('.js-summary');
    if (!host) return;
    const retQty = Object.values(state.ret).reduce((a, b) => a + b, 0);
    const refund = returnRefundEstimate();
    const rep = state.mode === 'exchange' ? replacementEstimate() : 0;
    const diff = rep - refund;
    const canDo = retQty > 0 && (state.mode === 'return' || state.reps.length > 0);
    const overStock = state.mode === 'exchange' && state.reps.some((r) => r.qty > r.stock);

    host.innerHTML = `
      <div class="form-section-title">${state.mode === 'exchange' ? 'Exchange' : 'Return'} summary</div>
      <div class="detail-list">
        <div class="detail-list__row"><dt>Original sale</dt><dd class="mono">${escapeHtml(state.sale.invoiceNo)}</dd></div>
        <div class="detail-list__row"><dt>Returned items</dt><dd>${retQty || '—'}</dd></div>
        <div class="detail-list__row"><dt>Returned value</dt><dd>${money.format(refund)}</dd></div>
        ${state.mode === 'exchange' ? `<div class="detail-list__row"><dt>Replacement value</dt><dd>${money.format(rep)}</dd></div>
        <div class="detail-list__row" style="border-top:1px solid var(--border);padding-top:var(--sp-2);margin-top:var(--sp-2)">
          <dt class="strong">${diff > 0 ? 'Customer pays' : diff < 0 ? 'Refund to customer' : 'No difference'}</dt>
          <dd class="strong" style="font-size:var(--fs-lg);color:${diff > 0 ? 'var(--danger-fg)' : 'var(--success-fg)'}">${money.format(Math.abs(diff))}</dd></div>`
        : `<div class="detail-list__row" style="border-top:1px solid var(--border);padding-top:var(--sp-2);margin-top:var(--sp-2)">
          <dt class="strong">Refund to customer</dt>
          <dd class="strong" style="font-size:var(--fs-lg);color:var(--success-fg)">${money.format(refund)}</dd></div>`}
      </div>
      ${overStock ? '<div class="alert alert--danger" style="margin-top:var(--sp-3)"><div class="alert__body">Insufficient stock for the selected replacement product.</div></div>' : ''}
      <p class="field-hint" style="margin-top:var(--sp-2)">Tax and final amounts are confirmed when the transaction completes.</p>`;

    m.setFooter(`
      <button class="btn btn--ghost js-cancel">Cancel</button>
      <button class="btn btn--primary js-confirm" ${canDo && !overStock ? '' : 'disabled'}>
        ${state.mode === 'exchange' ? 'Confirm Exchange' : 'Confirm Return'}</button>`);
    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-confirm').addEventListener('click', submit);
  }

  async function submit() {
    const lines = Object.entries(state.ret).filter(([, q]) => q > 0).map(([saleItemId, qty]) => ({ saleItemId, qty }));
    if (!lines.length) return toast.warning('Select a product and return quantity.');
    if (state.mode === 'exchange' && !state.reps.length) return toast.warning('Add at least one replacement product.');

    const payload = {
      type: state.mode,
      reason: state.reason,
      refundMethod: state.method,
      note: state.note,
      lines,
      replacementItems: state.mode === 'exchange'
        ? state.reps.map((r) => ({ productId: r.productId, variantId: r.variantId, qty: r.qty }))
        : undefined,
    };
    const ok = await confirmDialog({
      title: state.mode === 'exchange' ? 'Confirm this exchange?' : 'Confirm this return?',
      message: 'Inventory will be updated and the transaction recorded. This cannot be undone.',
      confirmLabel: state.mode === 'exchange' ? 'Confirm Exchange' : 'Confirm Return',
      danger: true,
    });
    if (!ok) return;

    m.setBusy(true);
    try {
      const doc = await salesService.refundSale(state.sale.id, payload);
      m.close();
      toast.success(state.mode === 'exchange' ? 'Exchange completed' : 'Return processed');
      showDone(doc);
    } catch (err) {
      m.setBusy(false);
      toast.error(err?.data?.message || err.message || 'The transaction could not be completed.');
    }
  }

  async function showDone(doc) {
    const settings = await settingsService.getSettings();
    const d = openModal({
      title: doc.type === 'exchange' ? 'Exchange complete' : 'Return complete',
      size: 'sm',
      body: `<div class="stack" style="--stack-gap:var(--sp-3);text-align:center">
        <span style="color:var(--success-solid)">${icon('check-circle', { size: 40 })}</span>
        <div><div class="strong mono">${escapeHtml(doc.reference)}</div>
        <p class="muted">${
          doc.additionalPayment ? `Customer paid ${money.format(doc.additionalPayment)}`
          : doc.refundTotal ? `Refunded ${money.format(doc.refundTotal)} (${escapeHtml(doc.refundMethod)})`
          : 'Even exchange — no difference'}</p></div>
      </div>`,
      footer: `<button class="btn btn--ghost js-modal-close">Done</button>
        <button class="btn btn--primary js-print">${icon('print', { size: 15 })} Print ${doc.type === 'exchange' ? 'Exchange' : 'Return'} Receipt</button>`,
    });
    d.$('.js-print').addEventListener('click', () => printHtml(buildReturnReceipt(doc, { sale: state.sale, settings })));
  }
}

export default openExchangeReturn;
