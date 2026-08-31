/**
 * sale-detail.js - full invoice view, reprint, and sales return.
 */
import { pageShell, statusBadge, statStrip } from '../shared/page-kit.js';
import { blockLoader } from '../../components/skeleton.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import { printHtml } from '../../utils/print.js';
import { titleCase } from '../../utils/format.js';
import { RETURN_REASONS } from '../../data/schema.js';
import money from '../../utils/money.js';
import salesService from '../../services/sales-service.js';
import settingsService from '../../services/settings-service.js';
import { buildReceipt } from '../shared/receipt.js';
import { can } from '../../core/rbac.js';

export default async function saleDetailPage(ctx, mount) {
  mount.innerHTML = blockLoader('Loading sale…');
  let sale;
  try {
    sale = await salesService.getSaleById(ctx.params.id);
  } catch (err) {
    mount.innerHTML = `<div class="page"><div class="alert alert--danger"><div class="alert__body">${escapeHtml(err.message)}</div></div></div>`;
    return;
  }
  const settings = await settingsService.getSettings();

  const shell = pageShell(mount, {
    title: sale.invoiceNo,
    breadcrumb: [{ label: 'Sales', href: '#/sales' }, { label: sale.invoiceNo }],
    actions: [
      { label: 'Print Receipt', icon: 'print', variant: 'outline', onClick: () => print() },
      can('sales.refund') && sale.status !== 'refunded' && { label: 'Return / Refund', icon: 'undo', variant: 'primary', onClick: openReturn },
    ].filter(Boolean),
  });

  render();

  function render() {
    const returnedTotal = (sale.returns || []).reduce((s, r) => s + r.refundTotal, 0);
    shell.body.innerHTML = `
      <div class="row" style="gap:var(--sp-2);margin-bottom:var(--sp-4)">${statusBadge(sale.status)}
        <span class="muted">${fmtDateTime(sale.createdAt)} · ${escapeHtml(sale.branchName || '')} · ${escapeHtml(sale.cashierName || '')}</span></div>
      ${statStrip([
        { label: 'Total', value: money.format(sale.grandTotal) },
        { label: 'Paid', value: money.format(sale.paidTotal) },
        { label: 'Change', value: money.format(sale.changeTotal || 0) },
        sale.dueTotal ? { label: 'Due', value: money.format(sale.dueTotal) } : { label: 'Items', value: sale.totalQty },
        returnedTotal ? { label: 'Refunded', value: money.format(returnedTotal) } : { label: 'Customer', value: escapeHtml(sale.customerName) },
      ])}
      <div class="form-layout">
        <div class="form-layout__main">
          <div class="card">
            <div class="card__header"><h3>Items</h3></div>
            <div class="table-wrap" style="border:0">
              <table class="table"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Discount</th><th class="num">Tax</th><th class="num">Total</th><th class="num">Returned</th></tr></thead>
              <tbody>${(sale.items || []).map((it) => `<tr>
                <td><strong>${escapeHtml(it.name)}</strong>${it.variantLabel ? `<br><span class="muted text-xs">${escapeHtml(it.variantLabel)}</span>` : ''}<br><span class="muted text-xs mono">${escapeHtml(it.sku)}</span></td>
                <td class="num">${it.qty}</td>
                <td class="num">${money.format(it.unitPrice)}</td>
                <td class="num">${it.discountTotal ? money.format(it.discountTotal) : '—'}</td>
                <td class="num">${money.format(it.taxAmount)}</td>
                <td class="num">${money.format(it.lineTotal)}</td>
                <td class="num">${it.returnedQty ? `<span class="badge badge--warning">${it.returnedQty}</span>` : '—'}</td>
              </tr>`).join('')}</tbody></table>
            </div>
          </div>
          ${(sale.returns || []).length ? `<div class="card"><div class="card__header"><h3>Returns</h3></div><div class="card__body">
            ${sale.returns.map((r) => `<div class="row-between" style="padding:var(--sp-2) 0;border-bottom:1px solid var(--border-subtle)">
              <div><strong class="mono">${escapeHtml(r.reference)}</strong> <span class="muted text-sm">${titleCase(r.reason)} · ${fmtDateTime(r.at)}</span></div>
              <strong>${money.format(r.refundTotal)}</strong></div>`).join('')}
          </div></div>` : ''}
        </div>
        <div class="form-layout__side">
          <div class="card card--pad">
            <div class="form-section-title">Summary</div>
            <dl class="detail-list">
              <div class="detail-list__row"><dt>Subtotal</dt><dd>${money.format(sale.subtotal)}</dd></div>
              <div class="detail-list__row"><dt>Discount</dt><dd>−${money.format(sale.discountTotal)}</dd></div>
              ${(sale.taxLines || []).map((t) => `<div class="detail-list__row"><dt>${escapeHtml(t.name)}</dt><dd>${money.format(t.amount)}</dd></div>`).join('')}
              <div class="detail-list__row"><dt>Grand total</dt><dd class="strong">${money.format(sale.grandTotal)}</dd></div>
            </dl>
          </div>
          <div class="card card--pad">
            <div class="form-section-title">Payments</div>
            <dl class="detail-list">
              ${(sale.payments || []).map((p) => `<div class="detail-list__row"><dt>${titleCase(p.method)}${p.direction === 'out' ? ' (refund)' : ''}</dt><dd>${p.direction === 'out' ? '−' : ''}${money.format(p.amount)}</dd></div>`).join('')}
            </dl>
          </div>
          <div class="card card--pad">
            <div class="form-section-title">Customer</div>
            <p><strong>${escapeHtml(sale.customerName)}</strong><br><span class="muted">${escapeHtml(sale.customerPhone || 'No phone')}</span></p>
          </div>
        </div>
      </div>`;
  }

  function print() {
    printHtml(buildReceipt(sale, { settings }));
  }

  function openReturn() {
    const items = (sale.items || []).map((it) => ({ ...it, remaining: it.qty - (it.returnedQty || 0) })).filter((it) => it.remaining > 0);
    if (!items.length) { toast.info('All items on this invoice have been returned.'); return; }
    const m = openModal({
      title: `Return — ${sale.invoiceNo}`, size: 'lg',
      body: `
        <label class="field"><span class="label">Reason</span>
          <select class="select js-reason">${RETURN_REASONS.map((r) => `<option value="${r.value}">${r.label}</option>`).join('')}</select></label>
        <table class="table table--compact" style="margin-top:var(--sp-3)">
          <thead><tr><th>Product</th><th class="num">Sold</th><th class="num">Returnable</th><th class="num">Return qty</th><th>Restock</th></tr></thead>
          <tbody>${items.map((it) => `<tr data-id="${it.id}">
            <td>${escapeHtml(it.name)}</td><td class="num">${it.qty}</td><td class="num">${it.remaining}</td>
            <td class="num"><input class="input js-q" type="number" min="0" max="${it.remaining}" value="0" style="width:74px;text-align:right"></td>
            <td><label class="check"><input type="checkbox" class="js-restock" checked></label></td>
          </tr>`).join('')}</tbody>
        </table>
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Refund method</span>
          <select class="select js-method"><option value="cash">Cash</option><option value="card">Card</option><option value="mobile">Mobile</option><option value="store_credit">Store credit</option></select></label>
        <div class="alert alert--info" style="margin-top:var(--sp-3)"><div class="alert__body">Estimated refund: <strong class="js-est">৳ 0.00</strong></div></div>
        <label class="field" style="margin-top:var(--sp-3)"><span class="label">Note</span><textarea class="textarea js-note" rows="2"></textarea></label>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--danger js-do">Process Return</button>`,
    });

    const est = m.$('.js-est');
    const recalc = () => {
      let total = 0;
      m.$$('tr[data-id]').forEach((tr) => {
        const it = items.find((x) => x.id === tr.dataset.id);
        const q = Number(tr.querySelector('.js-q').value) || 0;
        total += Math.round((it.lineTotal / it.qty) * q);
      });
      est.textContent = money.format(total);
    };
    m.$$('.js-q').forEach((i) => i.addEventListener('input', recalc));
    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-do').addEventListener('click', async () => {
      const lines = m.$$('tr[data-id]').map((tr) => ({
        saleItemId: tr.dataset.id,
        qty: Number(tr.querySelector('.js-q').value) || 0,
        restock: tr.querySelector('.js-restock').checked,
      })).filter((l) => l.qty > 0);
      if (!lines.length) { toast.warning('Enter a return quantity.'); return; }
      if (!(await confirmDialog({ title: 'Process this return?', message: 'Stock will be updated and a refund payment recorded. This cannot be undone.', danger: true, confirmLabel: 'Process return' }))) return;
      m.setBusy(true);
      try {
        await salesService.refundSale(sale.id, { reason: m.$('.js-reason').value, refundMethod: m.$('.js-method').value, note: m.$('.js-note').value, lines });
        m.close();
        toast.success('Return processed');
        sale = await salesService.getSaleById(ctx.params.id);
        render();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }
}
