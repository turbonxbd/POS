/**
 * suppliers.js
 */
import { resourcePage } from '../shared/resource-page.js';
import { statusBadge, moneyCell } from '../shared/page-kit.js';
import { escapeHtml } from '../../utils/dom.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { toast } from '../../components/toast.js';
import { fmtDate } from '../../utils/date.js';
import money from '../../utils/money.js';
import supplierService from '../../services/supplier-service.js';
import { can } from '../../core/rbac.js';

export default async function suppliersPage(ctx, mount) {
  const page = resourcePage(mount, {
    title: 'Suppliers',
    subtitle: 'Vendors you purchase stock from.',
    entityLabel: 'Supplier',
    service: {
      list: (p) => supplierService.getSuppliers(p),
      get: supplierService.getSupplierById,
      create: supplierService.createSupplier,
      update: supplierService.updateSupplier,
      archive: supplierService.archiveSupplier,
      restore: supplierService.restoreSupplier,
    },
    perms: { create: 'suppliers.manage', edit: 'suppliers.manage', archive: 'suppliers.manage' },
    filters: [{ key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] }],
    columns: [
      { key: 'name', label: 'Supplier', sortable: true, render: (r) => `<strong>${escapeHtml(r.name)}</strong>${r.company && r.company !== r.name ? `<br><span class="muted text-xs">${escapeHtml(r.company)}</span>` : ''}` },
      { key: 'phone', label: 'Phone', render: (r) => escapeHtml(r.phone || '—') },
      { key: 'purchaseCount', label: 'Purchases', align: 'right', sortable: true },
      { key: 'currentBalance', label: 'Payable', align: 'right', sortable: true, render: (r) => moneyCell(r.currentBalance) },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.archivedAt ? 'archived' : r.status || 'active') },
    ],
    exportColumns: [
      { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
      { key: 'currentBalance', label: 'Balance', value: (r) => money.toPlain(r.currentBalance) },
    ],
    rowActionsExtra: (row, { reload }) => [
      can('suppliers.manage') && { label: 'Record payment', icon: 'wallet', onClick: () => recordPayment(row, reload) },
      { label: 'Statement', icon: 'file', onClick: () => showStatement(row) },
    ].filter(Boolean),
    formFields: () => [
      { name: 'name', label: 'Supplier name', required: true },
      { name: 'company', label: 'Company' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'openingBalance', label: 'Previous balance owed', type: 'money' },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, colSpan: 'full' },
      { name: 'note', label: 'Notes', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    toForm: (r) => ({
      name: r?.name || '', company: r?.company || '', phone: r?.phone || '', email: r?.email || '',
      openingBalance: r?.openingBalance || 0, status: r?.status || 'active', address: r?.address || '', note: r?.note || '',
    }),
  });

  function recordPayment(supplier, reload) {
    const m = openModal({ title: `Pay ${supplier.name}`, size: 'sm', subtitle: `Outstanding: ${money.format(supplier.currentBalance)}`, body: '<div></div>' });
    createForm(m.$('.modal__body'), {
      fields: [
        { name: 'amount', label: 'Payment amount', type: 'money', required: true },
        { name: 'method', label: 'Method', type: 'select', options: [{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'mobile', label: 'Mobile banking' }] },
        { name: 'note', label: 'Reference / note', type: 'textarea', rows: 2 },
      ],
      layout: 'stack',
      submitLabel: 'Record payment',
      onCancel: () => m.close(),
      onSubmit: async (v) => {
        await supplierService.recordPayment(supplier.id, v);
        m.close();
        toast.success('Payment recorded');
        reload();
      },
    });
  }

  async function showStatement(supplier) {
    const m = openModal({ title: `${supplier.name} — Statement`, size: 'lg', body: '<div class="loading-block"><span class="spinner"></span></div>' });
    try {
      const { entries } = await supplierService.getStatement(supplier.id);
      let bal = supplier.openingBalance || 0;
      m.setBody(entries.length ? `<div class="table-wrap"><table class="table table--compact">
        <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
        <tbody>${entries.map((e) => {
          bal += e.type === 'purchase' ? (e.amount - (e.paid || 0)) : -e.amount;
          return `<tr><td>${fmtDate(e.at)}</td><td>${escapeHtml(e.type)}</td><td class="mono">${escapeHtml(e.ref || '—')}</td>
            <td class="num">${money.format(e.type === 'purchase' ? e.amount : -e.amount)}</td><td class="num">${money.format(bal)}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty-state"><h3>No transactions</h3></div>');
    } catch (err) {
      m.setBody(`<p class="text-danger">${escapeHtml(err.message)}</p>`);
    }
  }
}
