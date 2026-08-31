/**
 * platform/plans.js - manage the POS TXbd plans. These records are the single
 * source of truth for pricing - the Live/Public panel reads exactly these.
 */
import platformService from '../../services/platform-service.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { icon } from '../../components/icons.js';
import { page, loading, errorBox, badge, fmtMoney, liveRefresh } from './kit.js';

export default async function plansPage(ctx, mount) {
  const p = page(mount, { title: 'Plans', subtitle: 'Shown on the public site — edit a price here and it updates everywhere' });
  p.setActions([{ label: 'New plan', icon: 'plus', onClick: () => editPlan(null, reload) }]);
  loading(p.body);
  let plans;
  try {
    plans = (await platformService.plans()).data;
  } catch (err) {
    return errorBox(p.body, err);
  }

  function reload() { plansPage(ctx, mount); }
  liveRefresh(p.root, reload, 1200);

  p.body.innerHTML = `<div class="sa-plans">${plans.map((pl) => `
    <div class="sa-plan ${pl.popular ? 'is-popular' : ''} ${pl.status !== 'active' ? 'is-archived' : ''}">
      ${pl.popular ? '<span class="sa-plan__tag">Most popular</span>' : ''}
      <div class="sa-plan__head">
        <h3>${escapeHtml(pl.name)}</h3>
        ${badge(pl.status)}
      </div>
      <div class="sa-plan__price">${fmtMoney(pl.monthlyPrice ?? pl.price)}<span>/ ${escapeHtml(pl.billingPeriod === 'yearly' ? 'year' : 'month')}</span></div>
      <div class="sa-plan__meta">
        <span>Setup <b>${fmtMoney(pl.setupPrice || 0)}</b></span>
        <span>${pl.includedBranches ?? 1} branch${(pl.includedBranches ?? 1) === 1 ? '' : 'es'} included</span>
        <span>Extra branch <b>${pl.extraBranchPrice != null ? fmtMoney(pl.extraBranchPrice) : 'platform default'}</b></span>
      </div>
      <p class="muted text-sm">${escapeHtml(pl.description || '')}</p>
      <ul class="sa-plan__features">${(pl.features || []).map((f) => `<li>${icon('check', { size: 14 })} ${escapeHtml(f)}</li>`).join('')}</ul>
      <div class="sa-plan__foot">
        <button class="btn btn--ghost btn--sm js-edit" data-id="${pl.id}">${icon('edit', { size: 14 })} Edit</button>
        ${pl.status === 'active' ? `<button class="btn btn--ghost btn--sm js-archive" data-id="${pl.id}">${icon('trash', { size: 14 })} Archive</button>` : ''}
      </div>
    </div>`).join('')}</div>`;

  p.body.querySelectorAll('.js-edit').forEach((b) => b.addEventListener('click', () => editPlan(plans.find((x) => x.id === b.dataset.id), reload)));
  p.body.querySelectorAll('.js-archive').forEach((b) => b.addEventListener('click', async () => {
    const pl = plans.find((x) => x.id === b.dataset.id);
    if (!(await confirmDialog({ title: `Archive "${pl.name}"?`, message: 'It disappears from the public site. Existing subscribers keep their plan until they change it.', confirmLabel: 'Archive', danger: true }))) return;
    await platformService.archivePlan(pl.id);
    toast.success('Plan archived');
    reload();
  }));
}

function editPlan(plan, done) {
  const isEdit = !!plan;
  const m = openModal({ title: isEdit ? `Edit ${plan.name}` : 'New plan', size: 'md', body: '<div></div>' });
  createForm(m.$('.modal__body'), {
    fields: [
      { name: 'name', label: 'Plan name', required: true },
      { name: 'setupPrice', label: 'Initial / setup price', type: 'number', hint: 'One-time. Major units, e.g. 15000 for ৳15,000' },
      { name: 'monthlyPrice', label: 'Monthly server & backup charge', type: 'number', required: true, hint: 'Recurring. Major units' },
      { name: 'billingPeriod', label: 'Billing period', type: 'select', options: [{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }] },
      { name: 'includedBranches', label: 'Branches included', type: 'number', hint: 'Branches the plan covers before extra charges' },
      { name: 'extraBranchPrice', label: 'Additional branch price', type: 'number', hint: 'Per extra branch. Blank = use platform default' },
      { name: 'description', label: 'Short description', colSpan: 'full' },
      { name: 'features', label: 'Features (one per line)', type: 'textarea', colSpan: 'full', rows: 6 },
      { name: 'popular', label: 'Mark as "Most popular"', type: 'checkbox' },
      { name: 'sortOrder', label: 'Display order', type: 'number', value: plan?.sortOrder ?? 0 },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active (public)' }, { value: 'archived', label: 'Archived (hidden)' }] },
    ],
    values: isEdit
      ? {
          ...plan,
          setupPrice: (plan.setupPrice || 0) / 100,
          monthlyPrice: (plan.monthlyPrice ?? plan.price ?? 0) / 100,
          includedBranches: plan.includedBranches ?? 1,
          extraBranchPrice: plan.extraBranchPrice != null ? plan.extraBranchPrice / 100 : '',
          features: (plan.features || []).join('\n'),
        }
      : { billingPeriod: 'monthly', status: 'active', sortOrder: 0, includedBranches: 1 },
    submitLabel: isEdit ? 'Save plan' : 'Create plan',
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      const body = {
        name: v.name,
        setupPrice: Math.round(Number(v.setupPrice || 0) * 100),
        monthlyPrice: Math.round(Number(v.monthlyPrice) * 100),
        includedBranches: Math.max(0, Math.trunc(Number(v.includedBranches) || 0)),
        extraBranchPrice: String(v.extraBranchPrice).trim() === '' ? '' : Math.round(Number(v.extraBranchPrice) * 100),
        billingPeriod: v.billingPeriod,
        description: v.description, popular: !!v.popular, sortOrder: Number(v.sortOrder) || 0, status: v.status,
        features: String(v.features || '').split('\n').map((s) => s.trim()).filter(Boolean),
      };
      if (isEdit) await platformService.updatePlan(plan.id, body);
      else await platformService.createPlan(body);
      m.close();
      toast.success(isEdit ? 'Plan saved' : 'Plan created');
      done();
    },
  });
}
