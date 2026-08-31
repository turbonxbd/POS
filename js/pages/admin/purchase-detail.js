/**
 * purchase-detail.js - view a purchase, receive stock, create a return.
 */
import { pageShell, statusBadge, statStrip } from '../shared/page-kit.js';
import { blockLoader } from '../../components/skeleton.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import money from '../../utils/money.js';
import purchaseService from '../../services/purchase-service.js';
import { can } from '../../core/rbac.js';

export default async function purchaseDetailPage(ctx, mount) {
  mount.innerHTML = blockLoader('Loading purchase…');
  let p;
  try {
    p = await purchaseService.getPurchaseById(ctx.params.id);
  } catch (err) {
    mount.innerHTML = `<div class="page"><div class="alert alert--danger"><div class="alert__body">${escapeHtml(err.message)}</div></div></div>`;
    return;
  }

  const shell = pageShell(mount, {
    title: p.reference,
    breadcrumb: [{ label: 'Purchases', href: '#/purchases' }, { label: p.reference }],
    actions: [
      can('purchases.receive') && !['received', 'cancelled'].includes(p.status) && { label: 'Receive Stock', icon: 'download', variant: 'primary', onClick: openReceive },
      can('purchases.return') && ['received', 'partially_received'].includes(p.status) && { label: 'Return to Supplier', icon: 'rotate-ccw', variant: 'outline', onClick: openReturn },
      can('purchases.edit') && ['draft', 'ordered'].includes(p.status) && { label: 'Cancel', icon: 'x', variant: 'outline', onClick: doCancel },
    ].filter(Boolean),
  });

  render();

  function render() {
    shell.body.innerHTML = `
      <div class="row" style="gap:var(--sp-2);margin-bottom:var(--sp-4)">${statusBadge(p.status)}
        <span class="muted">${escapeHtml(p.supplierName)} · ${fmtDateTime(p.createdAt)}</span></div>
      ${statStrip([
        { label: 'Total', value: money.format(p.grandTotal) },
        { label: 'Paid', value: money.format(p.paidTotal) },
        { label: 'Due', value: money.format(p.dueTotal) },
        { label: 'Received', value: `${p.lines.reduce((s, l) => s + (l.receivedQty || 0), 0)} / ${p.lines.reduce((s, l) => s + l.qty, 0)} units` },
      ])}
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Product</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Returned</th><th class="num">Unit cost</th><th class="num">Line total</th></tr></thead>
        <tbody>${p.lines.map((l) => `<tr>
          <td>${escapeHtml(l.name || l.productId)}</td>
          <td class="num">${l.qty}</td>
          <td class="num">${l.receivedQty || 0}</td>
          <td class="num">${l.returnedQty || 0}</td>
          <td class="num">${money.format(l.unitCost)}</td>
          <td class="num">${money.format(l.qty * l.unitCost)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${p.note ? `<p class="muted text-sm" style="margin-top:var(--sp-3)">${escapeHtml(p.note)}</p>` : ''}`;
  }

  async function reload() {
    p = await purchaseService.getPurchaseById(ctx.params.id);
    render();
  }

  function openReceive() {
    const pending = p.lines.filter((l) => (l.receivedQty || 0) < l.qty);
    const m = openModal({
      title: 'Receive Stock', size: 'md',
      body: `<p class="text-sm muted">Enter how many units arrived. Stock increases immediately for the received quantities.</p>
        <table class="table table--compact" style="margin-top:var(--sp-3)"><thead><tr><th>Product</th><th class="num">Outstanding</th><th class="num">Receive now</th></tr></thead>
        <tbody>${pending.map((l) => `<tr data-id="${l.id || l.productId}"><td>${escapeHtml(l.name)}</td><td class="num">${l.qty - (l.receivedQty || 0)}</td>
          <td class="num"><input class="input js-r" type="number" min="0" max="${l.qty - (l.receivedQty || 0)}" value="${l.qty - (l.receivedQty || 0)}" style="width:80px;text-align:right"></td></tr>`).join('')}</tbody></table>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--primary js-do">Receive</button>`,
    });
    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-do').addEventListener('click', async () => {
      const receiveLines = [...m.$$('tr[data-id]')].map((tr) => ({ lineId: tr.dataset.id, qty: Number(tr.querySelector('.js-r').value) || 0 })).filter((l) => l.qty > 0);
      if (!receiveLines.length) { toast.warning('Enter at least one quantity.'); return; }
      m.setBusy(true);
      try {
        await purchaseService.receivePurchase(p.id, receiveLines);
        m.close();
        toast.success('Stock received');
        reload();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }

  function openReturn() {
    const returnable = p.lines.filter((l) => (l.receivedQty || 0) - (l.returnedQty || 0) > 0);
    if (!returnable.length) { toast.info('Nothing available to return.'); return; }
    const m = openModal({
      title: 'Return to Supplier', size: 'md',
      body: `<label class="field"><span class="label">Reason</span>
          <select class="select js-reason"><option value="defective">Defective</option><option value="expired">Expired</option><option value="wrong_item">Wrong item</option><option value="excess">Excess stock</option></select></label>
        <table class="table table--compact" style="margin-top:var(--sp-3)"><thead><tr><th>Product</th><th class="num">Returnable</th><th class="num">Return qty</th></tr></thead>
        <tbody>${returnable.map((l) => `<tr data-id="${l.id || l.productId}"><td>${escapeHtml(l.name)}</td><td class="num">${(l.receivedQty || 0) - (l.returnedQty || 0)}</td>
          <td class="num"><input class="input js-q" type="number" min="0" max="${(l.receivedQty || 0) - (l.returnedQty || 0)}" value="0" style="width:80px;text-align:right"></td></tr>`).join('')}</tbody></table>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--danger js-do">Post Return</button>`,
    });
    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-do').addEventListener('click', async () => {
      const rLines = [...m.$$('tr[data-id]')].map((tr) => ({ lineId: tr.dataset.id, qty: Number(tr.querySelector('.js-q').value) || 0 })).filter((l) => l.qty > 0);
      if (!rLines.length) { toast.warning('Enter a return quantity.'); return; }
      m.setBusy(true);
      try {
        await purchaseService.returnPurchase(p.id, { reason: m.$('.js-reason').value, lines: rLines });
        m.close();
        toast.success('Purchase return posted — stock reduced');
        reload();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }

  async function doCancel() {
    if (!(await confirmDialog({ title: 'Cancel this purchase?', message: 'This cannot be undone. Only purchases with no received stock can be cancelled.', danger: true, confirmLabel: 'Cancel purchase' }))) return;
    try {
      await purchaseService.cancelPurchase(p.id);
      toast.success('Purchase cancelled');
      reload();
    } catch (err) {
      toast.fromError(err);
    }
  }
}
