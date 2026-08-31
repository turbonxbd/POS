/**
 * customers.js
 */
import { resourcePage } from '../shared/resource-page.js';
import { statusBadge, moneyCell } from '../shared/page-kit.js';
import { escapeHtml } from '../../utils/dom.js';
import { openModal } from '../../components/modal.js';
import { fmtDate, fmtRelative } from '../../utils/date.js';
import money from '../../utils/money.js';
import { phone as fmtPhone } from '../../utils/format.js';
import customerService from '../../services/customer-service.js';

export default async function customersPage(ctx, mount) {
  resourcePage(mount, {
    title: 'Customers',
    subtitle: 'Phone number is the primary lookup key.',
    entityLabel: 'Customer',
    service: {
      list: (p) => customerService.getCustomers(p),
      get: customerService.getCustomerById,
      create: customerService.createCustomer,
      update: customerService.updateCustomer,
      archive: customerService.archiveCustomer,
      restore: customerService.restoreCustomer,
    },
    perms: { create: 'customers.create', edit: 'customers.edit', archive: 'customers.edit' },
    filters: [{ key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] }],
    searchPlaceholder: 'Search name or phone…',
    columns: [
      { key: 'name', label: 'Customer', sortable: true, render: (r) => `<strong>${escapeHtml(r.name)}</strong><br><span class="muted text-xs mono">${escapeHtml(fmtPhone(r.phone))}</span>` },
      { key: 'totalOrders', label: 'Orders', align: 'right', sortable: true },
      { key: 'totalPurchases', label: 'Spent', align: 'right', sortable: true, render: (r) => moneyCell(r.totalPurchases) },
      { key: 'outstandingBalance', label: 'Due', align: 'right', sortable: true, render: (r) => r.outstandingBalance ? `<span class="pos-amount text-danger">${money.format(r.outstandingBalance)}</span>` : '—' },
      { key: 'loyaltyPoints', label: 'Points', align: 'right', sortable: true },
      { key: 'lastPurchaseAt', label: 'Last purchase', sortable: true, render: (r) => r.lastPurchaseAt ? fmtRelative(r.lastPurchaseAt) : '—' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.archivedAt ? 'archived' : r.status || 'active') },
    ],
    exportColumns: [
      { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
      { key: 'totalOrders', label: 'Orders' }, { key: 'totalPurchases', label: 'Spent', value: (r) => money.toPlain(r.totalPurchases) },
      { key: 'outstandingBalance', label: 'Due', value: (r) => money.toPlain(r.outstandingBalance) },
    ],
    rowActionsExtra: (row) => [{ label: 'View history', icon: 'history', onClick: () => showHistory(row) }],
    onRowClick: (row) => showHistory(row),
    formFields: () => [
      { name: 'name', label: 'Full name', required: true },
      { name: 'phone', label: 'Phone', type: 'tel', required: true, hint: 'Used for fast lookup at the till' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'district', label: 'District' },
      { name: 'upazila', label: 'Upazila / Thana' },
      { name: 'openingBalance', label: 'Opening balance (owed)', type: 'money' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, colSpan: 'full' },
      { name: 'note', label: 'Notes', type: 'textarea', rows: 2, colSpan: 'full' },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
    ],
    toForm: (r) => ({
      name: r?.name || '', phone: r?.phone || '', email: r?.email || '', district: r?.district || '', upazila: r?.upazila || '',
      openingBalance: r?.openingBalance || 0, address: r?.address || '', note: r?.note || '', status: r?.status || 'active',
    }),
  });

  // deep-link: #/customers?open=<id> (from dashboard / report drill-downs)
  if (ctx.query?.open) {
    customerService.getCustomerById(ctx.query.open)
      .then((c) => showHistory(c))
      .catch(() => {});
  }

  async function showHistory(customer) {
    const m = openModal({ title: customer.name, subtitle: fmtPhone(customer.phone), size: 'lg', body: '<div class="loading-block"><span class="spinner"></span></div>' });
    try {
      const { customer: c, sales, returns } = await customerService.getHistory(customer.id);
      m.setBody(`
        <div class="stat-strip" style="margin-bottom:var(--sp-4)">
          <div class="stat-strip__item"><div class="label">Total spent</div><div class="value">${money.format(c.totalPurchases || 0)}</div></div>
          <div class="stat-strip__item"><div class="label">Orders</div><div class="value">${c.totalOrders || 0}</div></div>
          <div class="stat-strip__item"><div class="label">Outstanding</div><div class="value">${money.format(c.outstandingBalance || 0)}</div></div>
          <div class="stat-strip__item"><div class="label">Loyalty points</div><div class="value">${c.loyaltyPoints || 0}</div></div>
        </div>
        <h4 class="section-title">Purchase history</h4>
        ${sales.length ? `<div class="table-wrap"><table class="table table--compact"><thead><tr><th>Invoice</th><th>Date</th><th class="num">Total</th><th>Status</th></tr></thead>
          <tbody>${sales.map((s) => `<tr><td class="mono"><a href="#/sales/${s.id}">${escapeHtml(s.invoiceNo)}</a></td><td>${fmtDate(s.createdAt)}</td><td class="num">${money.format(s.grandTotal)}</td><td>${statusBadge(s.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted text-sm">No purchases yet.</p>'}
        ${returns.length ? `<h4 class="section-title" style="margin-top:var(--sp-4)">Returns</h4><div class="table-wrap"><table class="table table--compact"><thead><tr><th>Ref</th><th>Invoice</th><th class="num">Refund</th></tr></thead><tbody>${returns.map((r) => `<tr><td class="mono">${escapeHtml(r.reference)}</td><td class="mono">${escapeHtml(r.invoiceNo)}</td><td class="num">${money.format(r.refundTotal)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      `);
      m.el.addEventListener('click', (e) => e.target.closest('a[href^="#/"]') && m.close());
    } catch (err) {
      m.setBody(`<p class="text-danger">${escapeHtml(err.message)}</p>`);
    }
  }
}
