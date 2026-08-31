/**
 * sales.js - sales history.
 */
import { pageShell, statusBadge, moneyCell, statStrip } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime, RANGE_PRESETS, resolveRange } from '../../utils/date.js';
import { exportCsv } from '../../utils/csv.js';
import money from '../../utils/money.js';
import salesService from '../../services/sales-service.js';
import { can } from '../../core/rbac.js';

export default async function salesPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Sales',
    subtitle: 'Every completed transaction. Records are immutable — corrections are made through returns.',
    actions: [{ label: 'Export CSV', icon: 'download', variant: 'outline', onClick: doExport }],
  });

  const strip = document.createElement('div');
  const tableMount = document.createElement('div');
  shell.body.append(strip, tableMount);

  createDataTable(tableMount, {
    columns: [
      { key: 'invoiceNo', label: 'Invoice', sortable: true, render: (r) => `<a href="#/sales/${r.id}"><strong class="mono">${escapeHtml(r.invoiceNo)}</strong></a>` },
      { key: 'createdAt', label: 'Date', sortable: true, render: (r) => fmtDateTime(r.createdAt) },
      { key: 'customerName', label: 'Customer', render: (r) => escapeHtml(r.customerName) },
      { key: 'cashierName', label: 'Cashier', render: (r) => escapeHtml(r.cashierName || '—') },
      { key: 'totalQty', label: 'Items', align: 'right' },
      { key: 'discountTotal', label: 'Disc.', align: 'right', render: (r) => r.discountTotal ? money.format(r.discountTotal) : '—' },
      { key: 'grandTotal', label: 'Total', align: 'right', sortable: true, render: (r) => moneyCell(r.grandTotal, { strong: true }) },
      ...(can('reports.financial') ? [{ key: 'estimatedProfit', label: 'Profit', align: 'right', render: (r) => money.format(r.estimatedProfit) }] : []),
      { key: 'paymentSummary', label: 'Payment', render: (r) => `<span class="badge badge--neutral">${escapeHtml(r.paymentSummary || '—')}</span>` },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
    ],
    filters: [
      { key: 'status', label: 'Status', options: [
        { value: 'completed', label: 'Completed' }, { value: 'due', label: 'Due' },
        { value: 'partially_refunded', label: 'Partially refunded' }, { value: 'refunded', label: 'Refunded' },
      ] },
      { key: 'payment', label: 'Payment', options: [{ value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }, { value: 'mobile', label: 'Mobile' }, { value: 'bank_transfer', label: 'Bank' }] },
      { key: 'preset', label: 'Period', options: RANGE_PRESETS.filter((p) => p.value !== 'custom'), allowAll: false, default: 'this_month' },
    ],
    searchPlaceholder: 'Search invoice, customer or phone…',
    stacked: true,
    emptyState: { icon: 'receipt', title: 'No sales in this period' },
    fetcher: async (params) => {
      const range = resolveRange(params.preset || 'this_month');
      const res = await salesService.getSales({ ...params, from: range.from, to: range.to });
      const t = res.totals || {};
      strip.innerHTML = statStrip([
        { label: 'Orders', value: t.count ?? 0 },
        { label: 'Gross sales', value: money.format(t.gross ?? 0) },
        { label: 'Discounts', value: money.format(t.discount ?? 0) },
        { label: 'Tax collected', value: money.format(t.tax ?? 0) },
        ...(can('reports.financial') ? [{ label: 'Gross profit', value: money.format(t.profit ?? 0) }] : []),
      ]);
      return res;
    },
    onRowClick: (row) => (location.hash = `#/sales/${row.id}`),
    rowActions: (row) => [{ label: 'Open', icon: 'eye', onClick: () => (location.hash = `#/sales/${row.id}`) }],
  });

  async function doExport() {
    const range = resolveRange('this_month');
    const res = await salesService.getSales({ pageSize: 'all', from: range.from, to: range.to });
    exportCsv(`sales-${Date.now()}`, res.data || [], [
      { key: 'invoiceNo', label: 'Invoice' }, { key: 'createdAt', label: 'Date' }, { key: 'customerName', label: 'Customer' },
      { key: 'cashierName', label: 'Cashier' }, { key: 'totalQty', label: 'Items' },
      { key: 'grandTotal', label: 'Total', value: (r) => money.toPlain(r.grandTotal) },
      { key: 'taxTotal', label: 'Tax', value: (r) => money.toPlain(r.taxTotal) },
      { key: 'paymentSummary', label: 'Payment' }, { key: 'status', label: 'Status' },
    ]);
  }
}
