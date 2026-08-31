/**
 * purchase-returns.js - list of returns made to suppliers.
 */
import { pageShell, moneyCell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import money from '../../utils/money.js';
import purchaseService from '../../services/purchase-service.js';

export default async function purchaseReturnsPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Purchase Returns',
    subtitle: 'Stock returned to suppliers. Create a return from an individual purchase.',
  });

  createDataTable(shell.body, {
    columns: [
      { key: 'at', label: 'Date', sortable: true, render: (r) => fmtDateTime(r.at) },
      { key: 'reference', label: 'Reference', render: (r) => `<span class="mono">${escapeHtml(r.reference)}</span>` },
      { key: 'purchaseRef', label: 'Purchase', render: (r) => `<a href="#/purchases/${r.purchaseId}" class="mono">${escapeHtml(r.purchaseRef)}</a>` },
      { key: 'supplierName', label: 'Supplier', render: (r) => escapeHtml(r.supplierName || '—') },
      { key: 'reason', label: 'Reason', render: (r) => `<span class="badge badge--neutral">${titleCase(r.reason)}</span>` },
      { key: 'returnTotal', label: 'Value', align: 'right', sortable: true, render: (r) => moneyCell(r.returnTotal) },
    ],
    searchPlaceholder: 'Search reference or supplier…',
    stacked: true,
    emptyState: { icon: 'rotate-ccw', title: 'No purchase returns yet' },
    fetcher: (params) => purchaseService.getPurchaseReturns(params),
    onRowClick: (row) => openModal({
      title: row.reference, subtitle: `${titleCase(row.reason)} · ${fmtDateTime(row.at)}`, size: 'md',
      body: `<div class="table-wrap"><table class="table table--compact"><thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead>
        <tbody>${row.items.map((i) => `<tr><td>${escapeHtml(i.name || i.productId)}</td><td class="num">${i.qty}</td><td class="num">${money.format(i.amount)}</td></tr>`).join('')}</tbody></table></div>
        ${row.note ? `<p class="muted text-sm" style="margin-top:var(--sp-3)">${escapeHtml(row.note)}</p>` : ''}`,
      footer: '<button class="btn btn--primary js-modal-close">Close</button>',
    }),
    rowActions: () => [],
  });
}
