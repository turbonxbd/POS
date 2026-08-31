/**
 * taxes.js — "Discount & VAT". Two tabs that behave the same way:
 *   • Discount — automatic discounts that subtract money from every cart.
 *   • VAT      — tax rates that add on top (assigned per product; mark a default).
 * Both feed the cashier and the dashboard analytics.
 */
import { pageShell, pill } from '../shared/page-kit.js';
import { createTabs } from '../../components/tabs.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDate } from '../../utils/date.js';
import { icon } from '../../components/icons.js';
import money from '../../utils/money.js';

const CUR = money.format(0).split(' ')[0]; // currency symbol, e.g. ৳
// percent vs fixed-amount, offered the same way everywhere
const AMOUNT_TYPE_OPTIONS = [
  { value: 'percent', label: '％  Percentage' },
  { value: 'fixed', label: `${CUR}  Fixed amount` },
];
const pctChip = (n) => `${icon('percent', { size: 13 })} ${n}%`;
const amtChip = (minor) => `${icon('receipt', { size: 13 })} ${money.format(minor)}`;
import { can } from '../../core/rbac.js';
import taxService from '../../services/tax-service.js';
import discountService from '../../services/discount-service.js';

const MANAGE_TAX = 'taxes.manage';
const MANAGE_DISCOUNT = 'discounts.manage';

export default async function taxesPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Discount & VAT',
    subtitle: 'Automatic discounts and VAT that apply themselves at the cashier — no code needed.',
  });

  createTabs(shell.body, {
    tabs: [
      { id: 'discount', label: 'Discount', render: renderDiscountTab },
      { id: 'vat', label: 'VAT', render: renderVatTab },
    ],
  });
}

/* ------------------------------------------------------------ Discount tab */

function renderDiscountTab(el) {
  const host = document.createElement('div');
  el.appendChild(host);

  // automatic discounts only = the coupon-less rows of the discounts collection
  const fetcher = async (params) => {
    const res = await discountService.getDiscounts({ pageSize: 'all' });
    let rows = (res.data || []).filter((d) => !d.code);
    const q = (params.search || '').toLowerCase();
    if (q) rows = rows.filter((d) => (d.name || '').toLowerCase().includes(q));
    if (params.status) rows = rows.filter((d) => (d.archivedAt ? 'archived' : d.status || 'active') === params.status);
    rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const page = params.page || 1;
    const size = params.pageSize && params.pageSize !== 'all' ? Number(params.pageSize) : 20;
    return { data: rows.slice((page - 1) * size, page * size), total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), page, pageSize: size };
  };

  const table = createDataTable(host, {
    columns: [
      { key: 'name', label: 'Name', render: (r) => `<strong>${escapeHtml(r.name)}</strong> ${pill('Automatic', 'neutral')}` },
      { key: 'value', label: 'Amount off', align: 'right', render: (r) => r.type === 'fixed' ? amtChip(money.toMinor(r.value)) : pctChip(r.value) },
      { key: 'minSpend', label: 'Min. spend', align: 'right', render: (r) => r.minSpend ? money.format(r.minSpend) : '—' },
      { key: 'window', label: 'Active window', render: (r) => r.startsAt || r.endsAt ? `${r.startsAt ? fmtDate(r.startsAt) : '…'} – ${r.endsAt ? fmtDate(r.endsAt) : '…'}` : 'Always' },
      { key: 'usageCount', label: 'Used', align: 'right', render: (r) => `${r.usageCount || 0}${r.usageLimit ? ` / ${r.usageLimit}` : ''}` },
      { key: 'status', label: 'Status', render: (r) => pill(r.archivedAt ? 'Archived' : (r.status === 'inactive' ? 'Inactive' : 'Active'), r.archivedAt || r.status === 'inactive' ? 'neutral' : 'success') },
    ],
    filters: [{ key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }, { value: 'archived', label: 'Archived' }] }],
    searchPlaceholder: 'Search discounts…',
    stacked: true,
    toolbarExtra: can(MANAGE_DISCOUNT) ? actionBtn('New discount', () => editDiscount(null, table)) : null,
    emptyState: { icon: 'percent', title: 'No automatic discounts', message: 'Add one and it comes off every cart at the cashier.' },
    fetcher,
    rowActions: (row) => {
      if (!can(MANAGE_DISCOUNT)) return [];
      const acts = [];
      if (!row.archivedAt) acts.push({ label: 'Edit', icon: 'edit', onClick: () => editDiscount(row, table) });
      if (row.archivedAt) acts.push({ label: 'Restore', icon: 'rotate-ccw', onClick: () => run(() => discountService.restoreDiscount(row.id), 'Discount restored', table) });
      else acts.push({ label: 'Archive', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog({ title: `Archive "${row.name}"?`, message: 'It stops applying to new carts. Past sales keep their discount.', confirmLabel: 'Archive', danger: true })) {
          run(() => discountService.archiveDiscount(row.id), 'Discount archived', table);
        }
      } });
      return acts;
    },
  });
}

function editDiscount(row, table) {
  const isEdit = !!row;
  const m = openModal({ title: isEdit ? `Edit ${row.name}` : 'New automatic discount', size: 'md', body: '<div></div>' });
  createForm(m.$('.modal__body'), {
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Eid discount' },
      { name: 'type', label: 'Discount as', type: 'select', required: true, options: AMOUNT_TYPE_OPTIONS, hint: `％ = percent of the cart · ${CUR} = a flat amount` },
      { name: 'value', label: 'Value', type: 'number', required: true, min: 0, step: 0.01, hint: `Percent, or a flat ${CUR} amount, depending on the choice above` },
      { name: 'minSpend', label: 'Minimum spend', type: 'money', hint: 'Cart must reach this before the discount applies. 0 = no minimum' },
      { name: 'maxDiscount', label: 'Maximum discount', type: 'money', hint: 'Caps a percentage discount. 0 = no cap' },
      { name: 'startsAt', label: 'Starts', type: 'date' },
      { name: 'endsAt', label: 'Ends', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
    ],
    values: isEdit
      ? { name: row.name, type: row.type || 'percent', value: row.value ?? 0, minSpend: row.minSpend || 0, maxDiscount: row.maxDiscount || 0, startsAt: row.startsAt?.slice(0, 10) || '', endsAt: row.endsAt?.slice(0, 10) || '', status: row.status || 'active' }
      : { type: 'percent', status: 'active', minSpend: 0, maxDiscount: 0 },
    submitLabel: isEdit ? 'Save discount' : 'Create discount',
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      const payload = {
        name: v.name, type: v.type, value: Number(v.value) || 0,
        code: null, scope: 'cart',
        minSpend: Math.trunc(Number(v.minSpend) || 0),
        maxDiscount: Math.trunc(Number(v.maxDiscount) || 0),
        startsAt: v.startsAt || null, endsAt: v.endsAt || null,
        status: v.status,
      };
      if (isEdit) await discountService.updateDiscount(row.id, payload);
      else await discountService.createDiscount(payload);
      m.close();
      toast.success(isEdit ? 'Discount saved' : 'Discount created');
      table.reload();
    },
  });
}

/* ----------------------------------------------------------------- VAT tab */

function renderVatTab(el) {
  const host = document.createElement('div');
  el.appendChild(host);

  const table = createDataTable(host, {
    columns: [
      { key: 'name', label: 'Name', render: (r) => `<strong>${escapeHtml(r.name)}</strong> ${r.isDefault ? pill('Default', 'brand') : ''}` },
      { key: 'rate', label: 'Charge', align: 'right', render: (r) => r.type === 'fixed' ? amtChip(r.amount || 0) : pctChip(r.rate || 0) },
      { key: 'inclusive', label: 'Type', render: (r) => r.type === 'fixed' ? pill('Flat fee / sale', 'neutral') : pill(r.inclusive ? 'Price includes VAT' : 'Added on top', r.inclusive ? 'info' : 'neutral') },
      { key: 'scope', label: 'Applies to', render: (r) => escapeHtml(r.type === 'fixed' ? 'whole sale' : r.scope || 'product') },
      { key: 'status', label: 'Status', render: (r) => pill(r.archivedAt ? 'Archived' : 'Active', r.archivedAt ? 'neutral' : 'success') },
    ],
    filters: [{ key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] }],
    searchPlaceholder: 'Search VAT rates…',
    stacked: true,
    toolbarExtra: can(MANAGE_TAX) ? actionBtn('New VAT rate', () => editTax(null, table)) : null,
    emptyState: { icon: 'percent', title: 'No VAT rates', message: 'Add a rate, mark it default, and new products pick it up automatically.' },
    fetcher: (params) => taxService.getTaxes(params),
    rowActions: (row) => {
      if (!can(MANAGE_TAX)) return [];
      const acts = [];
      if (!row.archivedAt) acts.push({ label: 'Edit', icon: 'edit', onClick: () => editTax(row, table) });
      if (row.archivedAt) acts.push({ label: 'Restore', icon: 'rotate-ccw', onClick: () => run(() => taxService.restoreTax(row.id), 'VAT rate restored', table) });
      else if (!row.isDefault) acts.push({ label: 'Archive', icon: 'trash', danger: true, onClick: async () => {
        if (await confirmDialog({ title: `Archive "${row.name}"?`, message: 'Products using it fall back to no VAT until reassigned.', confirmLabel: 'Archive', danger: true })) {
          run(() => taxService.archiveTax(row.id), 'VAT rate archived', table);
        }
      } });
      return acts;
    },
  });
}

function editTax(row, table) {
  const isEdit = !!row;
  const m = openModal({ title: isEdit ? `Edit ${row.name}` : 'New VAT rate', size: 'sm', body: '<div></div>' });
  createForm(m.$('.modal__body'), {
    fields: [
      { name: 'name', label: 'VAT name', required: true, placeholder: 'e.g. VAT 15%' },
      { name: 'type', label: 'Charge as', type: 'select', required: true, options: AMOUNT_TYPE_OPTIONS, hint: `％ = percent of each line · ${CUR} = a flat fee on every sale` },
      { name: 'rate', label: 'Rate', type: 'number', required: true, min: 0, max: 100, step: 0.01, suffix: '%', when: (v) => v.type !== 'fixed' },
      { name: 'amount', label: 'Amount', type: 'money', required: true, when: (v) => v.type === 'fixed', hint: 'Added once to every sale' },
      { name: 'inclusive', label: 'Product price already includes this VAT', type: 'switch', when: (v) => v.type !== 'fixed' },
      { name: 'scope', label: 'Applies to', type: 'select', options: [{ value: 'product', label: 'Product level' }, { value: 'category', label: 'Category level' }], value: 'product', when: (v) => v.type !== 'fixed' },
      { name: 'isDefault', label: 'Use as default for new products', type: 'switch', when: (v) => v.type !== 'fixed' },
    ],
    values: isEdit
      ? { name: row.name, type: row.type || 'percent', rate: row.rate ?? 0, amount: row.amount || 0, inclusive: !!row.inclusive, scope: row.scope || 'product', isDefault: !!row.isDefault }
      : { type: 'percent', rate: 0, amount: 0, scope: 'product' },
    submitLabel: isEdit ? 'Save VAT rate' : 'Create VAT rate',
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      const payload = v.type === 'fixed'
        ? { name: v.name, type: 'fixed', amount: Math.trunc(Number(v.amount) || 0) }
        : { name: v.name, type: 'percent', rate: Number(v.rate) || 0, inclusive: !!v.inclusive, scope: v.scope, isDefault: !!v.isDefault };
      if (isEdit) await taxService.updateTax(row.id, payload);
      else await taxService.createTax(payload);
      m.close();
      toast.success(isEdit ? 'VAT rate saved' : 'VAT rate created');
      table.reload();
    },
  });
}

/* ---------------------------------------------------------------- helpers */

function actionBtn(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn btn--primary btn--sm';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

async function run(fn, okMsg, table) {
  try {
    await fn();
    toast.success(okMsg);
    table.reload();
  } catch (err) {
    toast.fromError(err);
  }
}
