/**
 * sales-returns.js - list of processed sales returns.
 */
import { pageShell, moneyCell, statStrip } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime, RANGE_PRESETS, resolveRange } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import { exportCsv } from '../../utils/csv.js';
import money from '../../utils/money.js';
import salesService from '../../services/sales-service.js';

export default async function salesReturnsPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Exchange / Return',
    subtitle: 'Returns and exchanges from the cashier terminal (Cashier → Exchange / Return) or from a sale in Sales → open invoice.',
    actions: [{ label: 'Export CSV', icon: 'download', variant: 'outline', onClick: doExport }],
  });
  const strip = document.createElement('div');
  const tableMount = document.createElement('div');
  shell.body.append(strip, tableMount);

  createDataTable(tableMount, {
    columns: [
      { key: 'at', label: 'Date', sortable: true, render: (r) => fmtDateTime(r.at) },
      { key: 'reference', label: 'Reference', render: (r) => `<span class="mono">${escapeHtml(r.reference)}</span>` },
      { key: 'type', label: 'Type', render: (r) => `<span class="badge badge--${r.type === 'exchange' ? 'info' : 'neutral'}">${r.type === 'exchange' ? 'Exchange' : 'Return'}</span>` },
      { key: 'invoiceNo', label: 'Invoice', render: (r) => `<a href="#/sales/${r.saleId}" class="mono">${escapeHtml(r.invoiceNo)}</a>` },
      { key: 'customerName', label: 'Customer', render: (r) => escapeHtml(r.customerName || 'Walk-in Customer') },
      { key: 'cashierName', label: 'By', render: (r) => escapeHtml(r.cashierName || '—') },
      { key: 'refundMethod', label: 'Method', render: (r) => titleCase(r.refundMethod || 'cash') },
      { key: 'refundTotal', label: 'Refund / +Paid', align: 'right', sortable: true, render: (r) => r.additionalPayment ? `<span class="text-success">+${money.format(r.additionalPayment)}</span>` : moneyCell(r.refundTotal, { strong: true }) },
    ],
    filters: [{ key: 'preset', label: 'Period', options: RANGE_PRESETS.filter((p) => p.value !== 'custom'), allowAll: false, default: 'this_month' }],
    searchPlaceholder: 'Search reference or invoice…',
    stacked: true,
    emptyState: { icon: 'undo', title: 'No returns in this period' },
    fetcher: async (params) => {
      const range = resolveRange(params.preset || 'this_month');
      const res = await salesService.getReturns({ ...params });
      const rows = (res.data || []).filter((r) => {
        const t = new Date(r.at).getTime();
        return t >= new Date(range.from).getTime() && t <= new Date(range.to).getTime();
      });
      const exchanges = rows.filter((r) => r.type === 'exchange').length;
      strip.innerHTML = statStrip([
        { label: 'Returns', value: rows.length - exchanges },
        { label: 'Exchanges', value: exchanges },
        { label: 'Total refunded', value: money.format(rows.reduce((s, r) => s + (r.refundTotal || 0), 0)) },
        { label: 'Extra collected', value: money.format(rows.reduce((s, r) => s + (r.additionalPayment || 0), 0)) },
      ]);
      return { ...res, data: rows, total: rows.length, totalPages: 1, page: 1 };
    },
    onRowClick: (row) => openModal({
      title: `${row.type === 'exchange' ? 'Exchange' : 'Return'} · ${row.reference}`,
      subtitle: `${titleCase(row.reason)} · ${fmtDateTime(row.at)}`, size: 'md',
      body: `
        <div class="form-section-title">Original sale</div>
        <div class="detail-list">
          <div class="detail-list__row"><dt>Invoice</dt><dd><a class="mono" href="#/sales/${row.saleId}">${escapeHtml(row.invoiceNo)}</a></dd></div>
          <div class="detail-list__row"><dt>Customer</dt><dd>${escapeHtml(row.customerName || 'Walk-in Customer')}</dd></div>
          <div class="detail-list__row"><dt>Cashier / branch</dt><dd>${escapeHtml(row.cashierName || '—')}</dd></div>
        </div>
        <div class="form-section-title" style="margin-top:var(--sp-4)">Returned products</div>
        <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Product</th><th class="num">Qty</th><th>Restocked</th><th class="num">Value</th></tr></thead>
          <tbody>${row.items.map((i) => `<tr><td>${escapeHtml(i.name || i.productId)}</td><td class="num">${i.qty}</td><td>${i.restock ? 'Yes' : 'No'}</td><td class="num">${money.format(i.refund || 0)}</td></tr>`).join('')}</tbody></table></div>
        ${row.replacementItems?.length ? `<div class="form-section-title" style="margin-top:var(--sp-4)">Replacement products</div>
        <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Price</th></tr></thead>
          <tbody>${row.replacementItems.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td class="num">${i.qty}</td><td class="num">${money.format(i.lineTotal || 0)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="form-section-title" style="margin-top:var(--sp-4)">Financials</div>
        <div class="detail-list">
          <div class="detail-list__row"><dt>Returned value</dt><dd>${money.format(row.returnRefund || row.refundTotal || 0)}</dd></div>
          ${row.type === 'exchange' ? `<div class="detail-list__row"><dt>Replacement value</dt><dd>${money.format(row.replacementTotal || 0)}</dd></div>` : ''}
          ${row.additionalPayment ? `<div class="detail-list__row"><dt>Additional payment</dt><dd class="strong">${money.format(row.additionalPayment)} (${escapeHtml(row.refundMethod)})</dd></div>`
            : `<div class="detail-list__row"><dt>Refund</dt><dd class="strong">${money.format(row.refundTotal || 0)} (${escapeHtml(row.refundMethod || 'cash')})</dd></div>`}
        </div>
        ${row.note ? `<p class="muted text-sm" style="margin-top:var(--sp-3)">${escapeHtml(row.note)}</p>` : ''}`,
      footer: `<a class="btn btn--ghost" href="#/sales/${row.saleId}">Open invoice</a><button class="btn btn--primary js-modal-close">Close</button>`,
    }),
    rowActions: () => [],
  });

  async function doExport() {
    const res = await salesService.getReturns({ pageSize: 'all' });
    exportCsv(`sales-returns-${Date.now()}`, res.data || [], [
      { key: 'at', label: 'Date' }, { key: 'reference', label: 'Reference' }, { key: 'invoiceNo', label: 'Invoice' },
      { key: 'reason', label: 'Reason' }, { key: 'refundTotal', label: 'Refund', value: (r) => money.toPlain(r.refundTotal) },
    ]);
  }
}
