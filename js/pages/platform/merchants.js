/**
 * platform/merchants.js - all merchants, filterable + paginated, drill into detail.
 */
import platformService from '../../services/platform-service.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce } from '../../utils/debounce.js';
import { renderPagination } from '../../components/pagination.js';
import { page, loading, errorBox, tableCard, badge, fmtDate, liveRefresh } from './kit.js';

export default async function merchantsPage(ctx, mount) {
  const p = page(mount, { title: 'Merchants', subtitle: 'Every business on POS TXbd' });
  p.setActions([{ label: 'Add merchant', icon: 'plus', onClick: () => addMerchant(() => render()) }]);
  const q = { ...ctx.query };
  const state = { page: 1, tags: [] };

  const bar = document.createElement('div');
  bar.className = 'sa-filterbar';
  bar.innerHTML = `
    <input class="input" id="m-search" type="search" placeholder="Search name / business / email / tag" value="${escapeHtml(q.search || '')}">
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
    </select>
    <select class="select" id="m-tag"><option value="">Tag: any</option></select>`;
  p.body.appendChild(bar);
  const list = document.createElement('div');
  p.body.appendChild(list);

  const read = () => ({
    search: bar.querySelector('#m-search').value.trim() || undefined,
    status: bar.querySelector('#m-status').value || undefined,
    subscription: bar.querySelector('#m-sub').value || undefined,
    tag: bar.querySelector('#m-tag').value || undefined,
    new: q.new,
    page: state.page,
    pageSize: 20,
  });

  const reload = debounce(() => { state.page = 1; render(); }, 250);
  bar.querySelector('#m-search').addEventListener('input', reload);
  bar.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { state.page = 1; render(); }));

  async function render() {
    loading(list);
    let res;
    try {
      res = await platformService.merchants(read());
    } catch (err) {
      return errorBox(list, err);
    }

    // keep the tag filter options in sync (without losing the current selection)
    const tagSel = bar.querySelector('#m-tag');
    const cur = tagSel.value;
    if ((res.tags || []).join('|') !== state.tags.join('|')) {
      state.tags = res.tags || [];
      tagSel.innerHTML = `<option value="">Tag: any</option>` + state.tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
      tagSel.value = cur;
    }

    const rows = res.data.map((m) => `<tr class="sa-row" data-id="${m.id}">
      <td><strong>${escapeHtml(m.businessName)}</strong><div class="muted text-sm">${escapeHtml(m.ownerName)} · ${escapeHtml(m.email)}</div>
        ${(m.tags || []).length ? `<div class="sa-tags">${m.tags.map((t) => `<span class="sa-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}</td>
      <td>${badge(m.status)}</td>
      <td>${escapeHtml(m.planName || '—')}</td>
      <td>${badge(m.subscriptionStatus)}</td>
      <td>${fmtDate(m.subscriptionExpiry)}</td>
      <td class="num">${m.branches}</td>
      <td class="num">${m.users}</td>
      <td>${fmtDate(m.registeredAt)}</td>
    </tr>`);

    const from = res.total === 0 ? 0 : (res.page - 1) * res.pageSize + 1;
    const to = Math.min(res.page * res.pageSize, res.total);
    list.innerHTML = `<p class="muted text-sm" style="margin:0 0 8px">${res.total ? `${from}–${to} of ` : ''}${res.total} merchant${res.total === 1 ? '' : 's'}</p>` +
      tableCard({
        head: [{ label: 'Business' }, { label: 'Account' }, { label: 'Plan' }, { label: 'Subscription' }, { label: 'Expires' }, { label: 'Branches', num: true }, { label: 'Users', num: true }, { label: 'Registered' }],
        rows,
        empty: 'No merchants match these filters.',
      }) +
      renderPagination(res.page, res.totalPages || 1);

    list.querySelectorAll('.sa-row').forEach((r) => r.addEventListener('click', () => { location.hash = '#/merchants/' + r.dataset.id; }));
    list.querySelectorAll('.js-page').forEach((b) => b.addEventListener('click', () => {
      const next = Number(b.dataset.page);
      if (next && next !== state.page) { state.page = next; render(); }
    }));
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
