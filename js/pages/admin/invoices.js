/**
 * invoices.js - invoice management: look up, preview and reprint.
 */
import { pageShell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import { printHtml } from '../../utils/print.js';
import money from '../../utils/money.js';
import salesService from '../../services/sales-service.js';
import settingsService from '../../services/settings-service.js';
import { buildReceipt } from '../shared/receipt.js';

export default async function invoicesPage(ctx, mount) {
  const settings = await settingsService.getSettings();
  const shell = pageShell(mount, {
    title: 'Invoice Management',
    subtitle: 'Search an invoice number, preview it, and reprint it using the configured print settings.',
  });

  shell.body.innerHTML = `
    <div class="filter-bar">
      <div class="input-search grow"><span class="input-search__icon">${icon('search', { size: 16 })}</span>
        <input class="input js-lookup" placeholder="Enter an exact invoice number, e.g. AFIA-BAN-00042"></div>
      <button class="btn btn--primary js-go">Find</button>
    </div>
    <div id="invoice-table"></div>`;

  shell.body.querySelector('.js-go').addEventListener('click', lookup);
  shell.body.querySelector('.js-lookup').addEventListener('keydown', (e) => e.key === 'Enter' && lookup());

  async function lookup() {
    const no = shell.body.querySelector('.js-lookup').value.trim();
    if (!no) return;
    try {
      const sale = await salesService.lookupByInvoice(no);
      preview(sale.id);
    } catch (err) {
      toast.error(err?.data?.message || 'Invoice not found');
    }
  }

  createDataTable(shell.body.querySelector('#invoice-table'), {
    columns: [
      { key: 'invoiceNo', label: 'Invoice', sortable: true, render: (r) => `<strong class="mono">${escapeHtml(r.invoiceNo)}</strong>` },
      { key: 'createdAt', label: 'Date', sortable: true, render: (r) => fmtDateTime(r.createdAt) },
      { key: 'customerName', label: 'Customer', render: (r) => escapeHtml(r.customerName) },
      { key: 'grandTotal', label: 'Total', align: 'right', sortable: true, render: (r) => money.format(r.grandTotal) },
      { key: 'branchName', label: 'Branch', render: (r) => escapeHtml(r.branchName || '—') },
    ],
    searchPlaceholder: 'Search invoices…',
    stacked: true,
    emptyState: { icon: 'file', title: 'No invoices' },
    fetcher: (params) => salesService.getSales(params),
    onRowClick: (row) => preview(row.id),
    rowActions: (row) => [
      { label: 'Preview', icon: 'eye', onClick: () => preview(row.id) },
      { label: 'Print', icon: 'print', onClick: () => quickPrint(row.id) },
    ],
  });

  async function quickPrint(id) {
    const sale = await salesService.getSaleById(id);
    printHtml(buildReceipt(sale, { settings }));
  }

  async function preview(id) {
    const sale = await salesService.getSaleById(id);
    const m = openModal({
      title: `Invoice ${sale.invoiceNo}`, size: 'lg',
      body: `<p class="muted text-sm" style="margin-bottom:var(--sp-3)">Uses the layout from <a href="#/settings?section=print">Settings → Print → Invoice</a>.</p>
        <div class="js-preview" style="overflow:auto;max-height:60vh;display:flex;justify-content:center;background:var(--bg-inset);padding:var(--sp-4);border-radius:var(--radius-md)"></div>`,
      footer: `<button class="btn btn--ghost js-modal-close">Close</button><button class="btn btn--primary js-print">${icon('print', { size: 15 })} Print</button>`,
    });
    m.$('.js-preview').innerHTML = buildReceipt(sale, { settings });
    m.$('.js-print').addEventListener('click', () => printHtml(buildReceipt(sale, { settings })));
  }
}
