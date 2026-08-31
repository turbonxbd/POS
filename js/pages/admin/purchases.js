/**
 * purchases.js - purchase order list.
 */
import { pageShell, statusBadge, moneyCell, statStrip } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDate, RANGE_PRESETS, resolveRange } from '../../utils/date.js';
import { exportCsv } from '../../utils/csv.js';
import money from '../../utils/money.js';
import purchaseService from '../../services/purchase-service.js';
import { can } from '../../core/rbac.js';

export default async function purchasesPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Purchases',
    subtitle: 'Purchase orders to suppliers. Receiving stock increases inventory.',
    actions: [
      { label: 'Export', icon: 'download', variant: 'outline', onClick: doExport },
      can('purchases.create') && { label: 'New Purchase', icon: 'plus', variant: 'primary', href: '#/purchases/new' },
    ].filter(Boolean),
  });

  const strip = document.createElement('div');
  const tableMount = document.createElement('div');
  shell.body.append(strip, tableMount);

  createDataTable(tableMount, {
    columns: [
      { key: 'reference', label: 'Reference', sortable: true, render: (r) => `<a href="#/purchases/${r.id}"><strong class="mono">${escapeHtml(r.reference)}</strong></a>` },
      { key: 'createdAt', label: 'Date', sortable: true, render: (r) => fmtDate(r.createdAt) },
      { key: 'supplierName', label: 'Supplier', render: (r) => escapeHtml(r.supplierName) },
      { key: 'grandTotal', label: 'Total', align: 'right', sortable: true, render: (r) => moneyCell(r.grandTotal) },
      { key: 'paidTotal', label: 'Paid', align: 'right', render: (r) => money.format(r.paidTotal) },
      { key: 'dueTotal', label: 'Due', align: 'right', render: (r) => r.dueTotal ? `<span class="text-danger pos-amount">${money.format(r.dueTotal)}</span>` : '—' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
    ],
    filters: [
      { key: 'status', label: 'Status', options: [
        { value: 'draft', label: 'Draft' }, { value: 'ordered', label: 'Ordered' },
        { value: 'partially_received', label: 'Partially received' }, { value: 'received', label: 'Received' }, { value: 'cancelled', label: 'Cancelled' },
      ] },
      { key: 'preset', label: 'Period', options: RANGE_PRESETS.filter((p) => p.value !== 'custom'), allowAll: false, default: 'this_year' },
    ],
    searchPlaceholder: 'Search reference or supplier…',
    stacked: true,
    emptyState: { icon: 'truck', title: 'No purchases yet', action: can('purchases.create') ? { label: 'New Purchase', icon: 'plus', onClick: () => (location.hash = '#/purchases/new') } : null },
    fetcher: async (params) => {
      const range = resolveRange(params.preset || 'this_year');
      const res = await purchaseService.getPurchases({ ...params, from: range.from, to: range.to });
      const rows = res.data || [];
      strip.innerHTML = statStrip([
        { label: 'Orders', value: res.total },
        { label: 'Total value', value: money.format(rows.reduce((s, r) => s + r.grandTotal, 0)) },
        { label: 'Outstanding payable', value: money.format(rows.reduce((s, r) => s + r.dueTotal, 0)) },
      ]);
      return res;
    },
    onRowClick: (row) => (location.hash = `#/purchases/${row.id}`),
    rowActions: (row) => [{ label: 'Open', icon: 'eye', onClick: () => (location.hash = `#/purchases/${row.id}`) }],
  });

  async function doExport() {
    const res = await purchaseService.getPurchases({ pageSize: 'all' });
    exportCsv(`purchases-${Date.now()}`, res.data || [], [
      { key: 'reference', label: 'Reference' }, { key: 'createdAt', label: 'Date' }, { key: 'supplierName', label: 'Supplier' },
      { key: 'grandTotal', label: 'Total', value: (r) => money.toPlain(r.grandTotal) },
      { key: 'paidTotal', label: 'Paid', value: (r) => money.toPlain(r.paidTotal) }, { key: 'status', label: 'Status' },
    ]);
  }
}
