/**
 * inventory.js - stock levels for the active branch + movement ledger + valuation.
 */
import { pageShell, statusBadge, moneyCell, statStrip } from '../shared/page-kit.js';
import { createTabs } from '../../components/tabs.js';
import { createDataTable } from '../../components/data-table.js';
import { blockLoader } from '../../components/skeleton.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime, fmtRelative } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import { exportCsv } from '../../utils/csv.js';
import money from '../../utils/money.js';
import inventoryService from '../../services/inventory-service.js';
import store from '../../core/store.js';
import { can } from '../../core/rbac.js';

export default async function inventoryPage(ctx, mount) {
  const branchName = (store.get('branches') || []).find((b) => b.id === store.get('activeBranchId'))?.name || 'Branch';
  const shell = pageShell(mount, {
    title: 'Inventory',
    subtitle: `Stock at ${branchName}. Balances are computed from the movement ledger, so a page refresh never changes them.`,
    actions: [
      can('inventory.adjust') && { label: 'New Adjustment', icon: 'sliders', variant: 'primary', href: '#/stock-adjustments' },
    ].filter(Boolean),
  });

  const tabsHost = document.createElement('div');
  shell.body.appendChild(tabsHost);

  createTabs(tabsHost, {
    tabs: [
      { id: 'stock', label: 'Stock Levels', render: (el) => renderStock(el, ctx) },
      { id: 'movements', label: 'Stock Movements', render: (el) => renderMovements(el) },
      can('inventory.valuation') && { id: 'valuation', label: 'Valuation', render: (el) => renderValuation(el) },
    ].filter(Boolean),
  });
}

function renderStock(el, ctx) {
  const strip = document.createElement('div');
  const tableMount = document.createElement('div');
  el.append(strip, tableMount);
  createDataTable(tableMount, {
    columns: [
      { key: 'name', label: 'Product', sortable: true, render: (r) => `<a href="#/products/${r.productId}"><strong>${escapeHtml(r.name)}</strong></a>${r.variantLabel ? `<br><span class="muted text-xs">${escapeHtml(r.variantLabel)}</span>` : ''}<br><span class="muted text-xs mono">${escapeHtml(r.sku || '')}</span>` },
      { key: 'categoryName', label: 'Category', render: (r) => escapeHtml(r.categoryName || '—') },
      { key: 'quantity', label: 'On hand', align: 'right', sortable: true },
      { key: 'available', label: 'Available', align: 'right', sortable: true },
      { key: 'minStock', label: 'Min', align: 'right' },
      { key: 'stockValue', label: 'Value', align: 'right', sortable: true, render: (r) => moneyCell(r.stockValue) },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      { key: 'lastMovementAt', label: 'Last move', render: (r) => r.lastMovementAt ? fmtRelative(r.lastMovementAt) : '—' },
    ],
    filters: [{ key: 'status', label: 'Status', options: [{ value: 'in_stock', label: 'In stock' }, { value: 'low_stock', label: 'Low stock' }, { value: 'out_of_stock', label: 'Out of stock' }] }],
    searchPlaceholder: 'Search product or SKU…',
    initial: { status: ctx.query.status || '', search: ctx.query.product ? '' : '' },
    stacked: true,
    emptyState: { icon: 'warehouse', title: 'No stock records' },
    fetcher: async (params) => {
      const res = await inventoryService.getInventory(params);
      const s = res.summary || {};
      strip.innerHTML = statStrip([
        { label: 'SKUs tracked', value: s.totalSkus ?? 0 },
        { label: 'Total units', value: s.totalUnits ?? 0 },
        { label: 'Low stock', value: `<span class="text-warning">${s.lowStock ?? 0}</span>` },
        { label: 'Out of stock', value: `<span class="text-danger">${s.outOfStock ?? 0}</span>` },
        { label: 'Stock value (cost)', value: money.format(s.totalValue ?? 0) },
      ]);
      return res;
    },
    rowActions: () => [],
  });
}

function renderMovements(el) {
  const tableMount = document.createElement('div');
  el.appendChild(tableMount);
  createDataTable(tableMount, {
    columns: [
      { key: 'at', label: 'Date', sortable: true, render: (r) => fmtDateTime(r.at) },
      { key: 'productName', label: 'Product', render: (r) => escapeHtml(r.productName) },
      { key: 'type', label: 'Type', render: (r) => `<span class="badge badge--${r.qtyDelta > 0 ? 'success' : 'danger'}">${titleCase(r.type)}</span>` },
      { key: 'qtyDelta', label: 'Change', align: 'right', sortable: true, render: (r) => `<span style="color:var(--${r.qtyDelta > 0 ? 'success' : 'danger'}-fg)">${r.qtyDelta > 0 ? '+' : ''}${r.qtyDelta}</span>` },
      { key: 'balanceAfter', label: 'Balance', align: 'right' },
      { key: 'refId', label: 'Reference', render: (r) => `<span class="mono text-xs">${escapeHtml(r.note || r.refId || '—')}</span>` },
      { key: 'userName', label: 'User', render: (r) => escapeHtml(r.userName || 'system') },
    ],
    filters: [{ key: 'type', label: 'Type', options: ['opening', 'purchase', 'sale', 'sale_return', 'purchase_return', 'adjustment', 'damage', 'lost', 'transfer_in', 'transfer_out'].map((t) => ({ value: t, label: titleCase(t) })) }],
    searchPlaceholder: 'Search product or reference…',
    stacked: true,
    emptyState: { icon: 'history', title: 'No movements recorded' },
    fetcher: (params) => inventoryService.getStockMovements(params),
    toolbarExtra: exportBtn(async () => {
      const res = await inventoryService.getStockMovements({ pageSize: 'all' });
      exportCsv(`stock-movements-${Date.now()}`, res.data || [], [
        { key: 'at', label: 'Date' }, { key: 'productName', label: 'Product' }, { key: 'type', label: 'Type' },
        { key: 'qtyDelta', label: 'Change' }, { key: 'balanceAfter', label: 'Balance' }, { key: 'userName', label: 'User' },
      ]);
    }),
  });
}

async function renderValuation(el) {
  el.innerHTML = blockLoader('Calculating valuation…');
  const data = await inventoryService.getValuation();
  const s = data.summary;
  el.innerHTML = `${statStrip([
    { label: 'Units on hand', value: s.totalUnits },
    { label: 'Cost value', value: money.format(s.totalCostValue) },
    { label: 'Retail value', value: money.format(s.totalRetailValue) },
    { label: 'Potential profit', value: money.format(s.potentialProfit) },
    { label: 'Blended margin', value: s.marginPct + '%' },
  ])}
  <div class="table-wrap"><table class="table">
    <thead><tr><th>Category</th><th class="num">Units</th><th class="num">Cost Value</th><th class="num">Retail Value</th><th class="num">Margin</th></tr></thead>
    <tbody>${data.byCategory.map((c) => `<tr><td>${escapeHtml(c.category)}</td><td class="num">${c.units}</td>
      <td class="num">${money.format(c.costValue)}</td><td class="num">${money.format(c.retailValue)}</td>
      <td class="num">${c.retailValue ? Math.round(((c.retailValue - c.costValue) / c.retailValue) * 100) : 0}%</td></tr>`).join('')}</tbody>
  </table></div>`;
}

function exportBtn(onClick) {
  const b = document.createElement('button');
  b.className = 'btn btn--outline btn--sm';
  b.textContent = 'Export CSV';
  b.addEventListener('click', onClick);
  return b;
}
