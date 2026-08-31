/**
 * platform/merchants.js - all merchants, filterable, drill into detail.
 */
import platformService from '../../services/platform-service.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { page, loading, errorBox, tableCard, badge, fmtDate, liveRefresh } from './kit.js';

export default async function merchantsPage(ctx, mount) {
  const p = page(mount, { title: 'Merchants', subtitle: 'Every business on POS TXbd' });
  p.setActions([{ label: 'Add merchant', icon: 'plus', onClick: () => addMerchant(() => render()) }]);
  const q = { ...ctx.query };

  const bar = document.createElement('div');
  bar.className = 'sa-filterbar';
  bar.innerHTML = `
    <input class="input" id="m-search" type="search" placeholder="Search name / business / email" value="${escapeHtml(q.search || '')}">
    <select class="select" id="m-status">
      <option value="">Account: all</option>
      <option value="active"${q.status === 'active' ? ' selected' : ''}>Active</option>
      <option value="suspended"${q.status === 'suspended' ? ' selected' : ''}>Suspended</option>
    </select>
    <select class="select" id="m-sub">
      <option value="">Subscription: all</option>
      <option value="active"${q.subscription === 'active' ? ' selected' : ''}>Active</option>
      <option value="pending"${q.subscription === 'pending' ? ' selected' : ''}>Pending</option>
      <option value="expired"${q.subscription === 'expired' ? ' selected' : ''}>Expired</option>
    </select>`;
  p.body.appendChild(bar);
  const list = document.createElement('div');
  p.body.appendChild(list);

  const read = () => ({
    search: bar.querySelector('#m-search').value.trim() || undefined,
    status: bar.querySelector('#m-status').value || undefined,
    subscription: bar.querySelector('#m-sub').value || undefined,
    new: q.new,
  });
  bar.addEventListener('input', () => render());
  bar.addEventListener('change', () => render());

  async function render() {
    loading(list);
    let res;
    try {
      res = await platformService.merchants(read());
    } catch (err) {
      return errorBox(list, err);
    }
    const rows = res.data.map((m) => `<tr class="sa-row" data-id="${m.id}">
      <td><strong>${escapeHtml(m.businessName)}</strong><div class="muted text-sm">${escapeHtml(m.ownerName)} · ${escapeHtml(m.email)}</div></td>
      <td>${badge(m.status)}</td>
      <td>${escapeHtml(m.planName || '—')}</td>
      <td>${badge(m.subscriptionStatus)}</td>
      <td>${fmtDate(m.subscriptionExpiry)}</td>
      <td class="num">${m.branches}</td>
      <td class="num">${m.users}</td>
      <td>${fmtDate(m.registeredAt)}</td>
    </tr>`);
    list.innerHTML = `<p class="muted text-sm" style="margin:0 0 8px">${res.total} merchant${res.total === 1 ? '' : 's'}</p>` +
      tableCard({
        head: [{ label: 'Business' }, { label: 'Account' }, { label: 'Plan' }, { label: 'Subscription' }, { label: 'Expires' }, { label: 'Branches', num: true }, { label: 'Users', num: true }, { label: 'Registered' }],
        rows,
        empty: 'No merchants match these filters.',
      });
    list.querySelectorAll('.sa-row').forEach((r) => r.addEventListener('click', () => { location.hash = '#/merchants/' + r.dataset.id; }));
  }
  await render();
  liveRefresh(p.body, render);
}

async function addMerchant(done) {
  let plans = [];
  try { plans = (await platformService.plans()).data.filter((x) => x.status === 'active'); } catch { /* offline */ }
  const m = openModal({ title: 'Add a merchant', size: 'md', body: '<div></div>' });
  createForm(m.$('.modal__body'), {
    fields: [
      { name: 'name', label: 'Business name', required: true },
      { name: 'ownerEmail', label: 'Owner email', type: 'email', required: true },
      { name: 'ownerPassword', label: 'Temporary password', type: 'password', required: true, rules: [['minLength', 8]], hint: 'At least 8 characters' },
      { name: 'planId', label: 'Plan', type: 'select', options: [{ value: '', label: '— none —' }, ...plans.map((x) => ({ value: x.id, label: x.name }))] },
      { name: 'subscriptionStatus', label: 'Subscription', type: 'select', value: 'active', options: [{ value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending payment' }, { value: 'trialing', label: 'Trial' }] },
    ],
    submitLabel: 'Create merchant',
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      await platformService.createMerchant(v);
      m.close();
      toast.success('Merchant created — the owner can sign in at the portal');
      done();
    },
  });
}
