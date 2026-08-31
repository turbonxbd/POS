/**
 * expenses.js
 */
import { pageShell, moneyCell, statStrip } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDate, RANGE_PRESETS, resolveRange } from '../../utils/date.js';
import { exportCsv } from '../../utils/csv.js';
import money from '../../utils/money.js';
import expenseService from '../../services/expense-service.js';
import { can } from '../../core/rbac.js';

export default async function expensesPage(ctx, mount) {
  const cats = await expenseService.getCategories().catch(() => ['Rent', 'Other']);
  const shell = pageShell(mount, {
    title: 'Expenses',
    subtitle: 'Track operating costs against sales.',
    actions: [
      { label: 'Export CSV', icon: 'download', variant: 'outline', onClick: doExport },
      can('expenses.manage') && { label: 'New Expense', icon: 'plus', variant: 'primary', onClick: () => openForm(null) },
    ].filter(Boolean),
  });

  const strip = document.createElement('div');
  shell.body.appendChild(strip);
  const tableMount = document.createElement('div');
  shell.body.appendChild(tableMount);

  const table = createDataTable(tableMount, {
    columns: [
      { key: 'at', label: 'Date', sortable: true, render: (r) => fmtDate(r.at) },
      { key: 'reference', label: 'Ref', render: (r) => `<span class="mono">${escapeHtml(r.reference || '—')}</span>` },
      { key: 'category', label: 'Category', render: (r) => `<span class="badge badge--neutral">${escapeHtml(r.category)}</span>` },
      { key: 'description', label: 'Description', render: (r) => escapeHtml(r.description) },
      { key: 'employeeName', label: 'By', render: (r) => escapeHtml(r.employeeName || '—') },
      { key: 'paymentMethod', label: 'Method', render: (r) => escapeHtml(r.paymentMethod) },
      { key: 'amount', label: 'Amount', align: 'right', sortable: true, render: (r) => moneyCell(r.amount, { strong: true }) },
    ],
    filters: [
      { key: 'category', label: 'Category', options: cats.map((c) => ({ value: c, label: c })) },
      { key: 'paymentMethod', label: 'Method', options: [{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank' }, { value: 'card', label: 'Card' }, { value: 'mobile', label: 'Mobile' }] },
      { key: 'preset', label: 'Period', options: RANGE_PRESETS.filter((p) => p.value !== 'custom'), allowAll: false, default: 'this_month' },
    ],
    searchPlaceholder: 'Search description or reference…',
    emptyState: { icon: 'wallet', title: 'No expenses recorded', action: can('expenses.manage') ? { label: 'New Expense', icon: 'plus', onClick: () => openForm(null) } : null },
    fetcher: async (params) => {
      const range = resolveRange(params.preset || 'this_month');
      const res = await expenseService.getExpenses({ ...params, from: range.from, to: range.to });
      const total = (res.data || []).reduce((s, e) => s + e.amount, 0);
      strip.innerHTML = statStrip([
        { label: 'Expenses (page period)', value: money.format(res.total ? total : total) },
        { label: 'Records', value: res.total },
      ]);
      return res;
    },
    rowActions: (row) => can('expenses.manage') ? [
      { label: 'Edit', icon: 'edit', onClick: () => openForm(row) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(row) },
    ] : [],
  });

  function openForm(row) {
    const m = openModal({ title: row ? 'Edit Expense' : 'New Expense', size: 'md', body: '<div></div>' });
    createForm(m.$('.modal__body'), {
      fields: [
        { name: 'category', label: 'Category', type: 'select', required: true, options: cats.map((c) => ({ value: c, label: c })) },
        { name: 'amount', label: 'Amount', type: 'money', required: true },
        { name: 'description', label: 'Description', required: true, colSpan: 'full' },
        { name: 'paymentMethod', label: 'Payment method', type: 'select', required: true, options: [{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }, { value: 'card', label: 'Card' }, { value: 'mobile', label: 'Mobile banking' }], value: 'cash' },
        { name: 'at', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
        { name: 'note', label: 'Notes', type: 'textarea', rows: 2, colSpan: 'full' },
      ],
      values: row ? { ...row, at: row.at?.slice(0, 10) } : {},
      submitLabel: row ? 'Save' : 'Record expense',
      onCancel: () => m.close(),
      onSubmit: async (v) => {
        const payload = { ...v, at: v.at ? new Date(v.at).toISOString() : undefined };
        if (row) await expenseService.updateExpense(row.id, payload);
        else await expenseService.createExpense(payload);
        m.close();
        toast.success(row ? 'Expense updated' : 'Expense recorded');
        table.reload();
      },
    });
  }

  async function remove(row) {
    if (!(await confirmDialog({ title: 'Delete this expense?', message: `${row.description} — ${money.format(row.amount)}`, danger: true, confirmLabel: 'Delete' }))) return;
    await expenseService.deleteExpense(row.id);
    toast.success('Expense deleted');
    table.reload();
  }

  async function doExport() {
    const range = resolveRange('this_year');
    const res = await expenseService.getExpenses({ pageSize: 'all', from: range.from, to: range.to });
    exportCsv(`expenses-${new Date().toISOString().slice(0, 10)}`, res.data || [], [
      { key: 'at', label: 'Date' }, { key: 'reference', label: 'Reference' }, { key: 'category', label: 'Category' },
      { key: 'description', label: 'Description' }, { key: 'paymentMethod', label: 'Method' },
      { key: 'amount', label: 'Amount', value: (r) => money.toPlain(r.amount) },
    ]);
    toast.success('Export ready');
  }
}
