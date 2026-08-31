/**
 * discounts.js - percentage / fixed discounts and coupon codes.
 */
import { resourcePage } from '../shared/resource-page.js';
import { statusBadge, pill } from '../shared/page-kit.js';
import { escapeHtml } from '../../utils/dom.js';
import money from '../../utils/money.js';
import { fmtDate } from '../../utils/date.js';
import { icon } from '../../components/icons.js';
import discountService from '../../services/discount-service.js';

const CUR = money.format(0).split(' ')[0];

export default async function discountsPage(ctx, mount) {
  resourcePage(mount, {
    title: 'Discounts & Coupons',
    subtitle: 'Coupon codes the cashier can type in, plus automatic discounts that apply themselves at checkout.',
    entityLabel: 'Discount',
    service: {
      list: (p) => discountService.getDiscounts(p),
      create: discountService.createDiscount,
      update: discountService.updateDiscount,
      archive: discountService.archiveDiscount,
      restore: discountService.restoreDiscount,
    },
    perms: { create: 'discounts.manage', edit: 'discounts.manage', archive: 'discounts.manage' },
    filters: [
      { key: 'scope', label: 'Scope', options: [{ value: 'cart', label: 'Cart' }, { value: 'product', label: 'Product' }, { value: 'category', label: 'Category' }] },
      { key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] },
    ],
    columns: [
      { key: 'name', label: 'Name', sortable: true, render: (r) => `<strong>${escapeHtml(r.name)}</strong> ${r.code ? pill(r.code, 'brand') : pill('Automatic', 'neutral')}` },
      { key: 'type', label: 'Value', render: (r) => r.type === 'percent' ? `${icon('percent', { size: 13 })} ${r.value}%` : `${icon('receipt', { size: 13 })} ${money.format(money.toMinor(r.value))}` },
      { key: 'scope', label: 'Scope', render: (r) => escapeHtml(r.scope) },
      { key: 'usage', label: 'Used', align: 'right', render: (r) => `${r.usageCount || 0}${r.usageLimit ? ` / ${r.usageLimit}` : ''}` },
      { key: 'endsAt', label: 'Expires', render: (r) => r.endsAt ? fmtDate(r.endsAt) : '—' },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.archivedAt ? 'archived' : r.status || 'active') },
    ],
    exportColumns: [{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'type', label: 'Type' }, { key: 'value', label: 'Value' }],
    formFields: () => [
      { name: 'name', label: 'Name', required: true },
      { name: 'code', label: 'Coupon code', placeholder: 'Leave blank for an automatic discount', suffix: '', hint: 'Uppercase, no spaces' },
      { name: 'type', label: 'Type', type: 'select', required: true, options: [{ value: 'percent', label: '％  Percentage' }, { value: 'fixed', label: `${CUR}  Fixed amount` }] },
      { name: 'value', label: 'Value', type: 'number', required: true, min: 0, step: 0.01 },
      { name: 'scope', label: 'Applies to', type: 'select', options: [{ value: 'cart', label: 'Whole cart' }, { value: 'product', label: 'Specific products' }, { value: 'category', label: 'A category' }], value: 'cart' },
      { name: 'minSpend', label: 'Minimum spend', type: 'money' },
      { name: 'maxDiscount', label: 'Maximum discount', type: 'money', hint: '0 = no cap' },
      { name: 'usageLimit', label: 'Usage limit', type: 'number', min: 0, hint: '0 = unlimited' },
      { name: 'startsAt', label: 'Starts', type: 'date' },
      { name: 'endsAt', label: 'Ends', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
    ],
    toForm: (r) => ({
      name: r?.name || '', code: r?.code || '', type: r?.type || 'percent', value: r?.value ?? 0, scope: r?.scope || 'cart',
      minSpend: r?.minSpend || 0, maxDiscount: r?.maxDiscount || 0, usageLimit: r?.usageLimit || 0,
      startsAt: r?.startsAt?.slice(0, 10) || '', endsAt: r?.endsAt?.slice(0, 10) || '', status: r?.status || 'active',
    }),
    fromForm: (v) => ({ ...v, code: v.code ? v.code.toUpperCase().replace(/\s+/g, '') : null }),
  });
}
