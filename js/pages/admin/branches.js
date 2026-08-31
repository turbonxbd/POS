/**
 * branches.js - multi-branch management. Stock is branch-scoped.
 *
 * The plan includes a set number of branches; adding one beyond that opens a
 * purchase flow (POST /billing/branch-request) instead of creating it directly.
 */
import { resourcePage } from '../shared/resource-page.js';
import { statusBadge, pill } from '../shared/page-kit.js';
import { escapeHtml } from '../../utils/dom.js';
import branchService from '../../services/branch-service.js';
import billingService from '../../services/billing-service.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { openPaymentSheet } from '../../components/payment-sheet.js';
import { toast } from '../../components/toast.js';
import money from '../../utils/money.js';
import bus from '../../core/event-bus.js';

export default async function branchesPage(ctx, mount) {
  let billing = null;
  try { billing = await billingService.summary(); } catch { /* legacy / no subscription */ }

  resourcePage(mount, {
    title: 'Branches',
    subtitle: entitlementLine(billing),
    entityLabel: 'Branch',
    service: {
      list: (p) => branchService.getBranches(p),
      create: async (payload) => {
        try {
          const b = await branchService.createBranch(payload);
          await refreshBranches();
          return b;
        } catch (err) {
          if (err?.status === 402 && err?.data?.requiresPurchase) {
            openBranchPurchase(payload, err.data);
            throw { errors: { name: 'This plan’s branches are all in use — use the purchase window that just opened.' } };
          }
          throw err;
        }
      },
      update: async (id, payload) => {
        const b = await branchService.updateBranch(id, payload);
        await refreshBranches();
        return b;
      },
      archive: async (id) => {
        const r = await branchService.archiveBranch(id);
        await refreshBranches();
        return r;
      },
    },
    perms: { create: 'branches.manage', edit: 'branches.manage', archive: 'branches.manage' },
    columns: [
      { key: 'name', label: 'Branch', sortable: true, render: (r) => `<strong>${escapeHtml(r.name)}</strong> ${r.isDefault ? pill('Default', 'brand') : ''}${r.openRegister ? ' ' + pill('Register open', 'success') : ''}<br><span class="muted text-xs mono">${escapeHtml(r.code)}</span>` },
      { key: 'address', label: 'Address', render: (r) => escapeHtml(r.address || '—') },
      { key: 'phone', label: 'Phone', render: (r) => escapeHtml(r.phone || '—') },
      { key: 'employeeCount', label: 'Staff', align: 'right' },
      { key: 'productsInStock', label: 'SKUs in stock', align: 'right' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.archivedAt ? 'archived' : r.status || 'active') },
    ],
    canArchive: (r) => !r.isDefault,
    formFields: () => [
      { name: 'name', label: 'Branch name', required: true },
      { name: 'code', label: 'Short code', hint: 'Used in invoice numbers, e.g. BAN', suffix: '' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, colSpan: 'full' },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
    ],
    toForm: (r) => ({ name: r?.name || '', code: r?.code || '', phone: r?.phone || '', email: r?.email || '', address: r?.address || '', status: r?.status || 'active' }),
  });

  async function refreshBranches() {
    const res = await branchService.getBranches({ pageSize: 'all' });
    const list = (res.data || res).filter((b) => !b.archivedAt);
    const s = (await import('../../core/store.js')).default;
    s.set({ branches: list });
    bus.emit('branches:updated');
  }
}

function entitlementLine(billing) {
  if (!billing?.subscription) return 'Each branch keeps its own stock, cash registers, sales and staff assignments.';
  const b = billing.branches;
  const extra = billing.extraBranchPrice ? ` · additional branch ${money.format(billing.extraBranchPrice)}` : '';
  return `Using ${b.used} of ${b.limit} branch${b.limit === 1 ? '' : 'es'} (${b.included} included, ${b.extraPaid} purchased)${extra}.`;
}

function openBranchPurchase(payload, info) {
  const price = info.price || 0;
  const m = openModal({
    title: 'Add an additional branch',
    subtitle: `Your plan includes ${info.included}; you are using ${info.used}. Additional branch — ${money.format(price)}`,
    size: 'sm', body: '<div></div>',
  });
  createForm(m.$('.modal__body'), {
    fields: [
      { name: 'name', label: 'New branch name', required: true, value: payload?.name || '' },
      { name: 'code', label: 'Short code', value: payload?.code || '' },
      { name: 'address', label: 'Address', type: 'textarea', rows: 2, value: payload?.address || '' },
    ],
    submitLabel: `Continue to payment — ${money.format(price)}`,
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      m.close();
      await openPaymentSheet({
        paymentType: 'branch',
        amount: price,
        referenceLabel: `New branch: ${v.name}`,
        submit: (f) => billingService.requestBranch({ name: v.name, code: v.code, address: v.address, ...f }),
        onDone: () => location.reload(),
      });
    },
  });
}
