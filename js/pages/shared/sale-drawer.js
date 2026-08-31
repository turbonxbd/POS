/**
 * sale-drawer.js - quick-inspect a sale in a side drawer.
 * Used by dashboard drill-downs and report row clicks.
 */
import { openDrawer } from '../../components/drawer.js';
import { blockLoader } from '../../components/skeleton.js';
import { statusBadge } from './page-kit.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import { printHtml } from '../../utils/print.js';
import money from '../../utils/money.js';
import salesService from '../../services/sales-service.js';
import settingsService from '../../services/settings-service.js';
import { buildReceipt } from './receipt.js';

export async function openSaleDrawer(saleId) {
  const d = openDrawer({ title: 'Sale details', width: 460, body: blockLoader('Loading…') });
  let sale;
  let settings;
  try {
    [sale, settings] = await Promise.all([salesService.getSaleById(saleId), settingsService.getSettings()]);
  } catch (err) {
    d.setBody(`<div class="alert alert--danger"><div class="alert__body">${escapeHtml(err.message)}</div></div>`);
    return;
  }

  d.setBody(`
    <div class="row" style="gap:var(--sp-2);margin-bottom:var(--sp-3)">${statusBadge(sale.status)}
      <span class="muted text-sm">${fmtDateTime(sale.createdAt)}</span></div>
    <div class="strong" style="font-size:var(--fs-xl)">${escapeHtml(sale.invoiceNo)}</div>
    <dl class="detail-list" style="margin-top:var(--sp-3)">
      <div class="detail-list__row"><dt>Customer</dt><dd>${escapeHtml(sale.customerName || 'Walk-in Customer')}${sale.customerPhone ? '<br><span class="muted">' + escapeHtml(sale.customerPhone) + '</span>' : ''}</dd></div>
      <div class="detail-list__row"><dt>Cashier</dt><dd>${escapeHtml(sale.cashierName || '—')}</dd></div>
      <div class="detail-list__row"><dt>Branch</dt><dd>${escapeHtml(sale.branchName || '—')}</dd></div>
    </dl>
    <h4 class="section-title" style="margin:var(--sp-4) 0 var(--sp-2)">Items</h4>
    <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Total</th></tr></thead>
      <tbody>${(sale.items || []).map((it) => `<tr><td>${escapeHtml(it.name)}${it.variantLabel ? `<br><span class="muted text-xs">${escapeHtml(it.variantLabel)}</span>` : ''}</td><td class="num">${it.qty}</td><td class="num">${money.format(it.lineTotal)}</td></tr>`).join('')}</tbody></table></div>
    <dl class="detail-list" style="margin-top:var(--sp-3)">
      <div class="detail-list__row"><dt>Subtotal</dt><dd>${money.format(sale.subtotal)}</dd></div>
      <div class="detail-list__row"><dt>Discount</dt><dd>−${money.format(sale.discountTotal)}</dd></div>
      <div class="detail-list__row"><dt>Tax / VAT</dt><dd>${money.format(sale.taxTotal)}</dd></div>
      <div class="detail-list__row"><dt>Grand total</dt><dd class="strong">${money.format(sale.grandTotal)}</dd></div>
      ${(sale.payments || []).map((p) => `<div class="detail-list__row"><dt>${titleCase(p.method)}${p.direction === 'out' ? ' (refund)' : ''}</dt><dd>${p.direction === 'out' ? '−' : ''}${money.format(p.amount)}</dd></div>`).join('')}
      ${sale.changeTotal ? `<div class="detail-list__row"><dt>Change</dt><dd>${money.format(sale.changeTotal)}</dd></div>` : ''}
      ${sale.dueTotal ? `<div class="detail-list__row"><dt>Amount due</dt><dd class="text-danger">${money.format(sale.dueTotal)}</dd></div>` : ''}
    </dl>`);

  d.setFooter(`
    <button class="btn btn--ghost js-print">${icon('print', { size: 15 })} Print</button>
    <a class="btn btn--primary" href="#/sales/${sale.id}">Full details</a>`);
  d.$('.js-print').addEventListener('click', () => printHtml(buildReceipt(sale, { settings })));
  d.el.addEventListener('click', (e) => {
    if (e.target.closest('a[href^="#/"]')) d.close();
  });
}

export default openSaleDrawer;
