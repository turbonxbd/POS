/**
 * platform/subscriptions.js - every merchant's subscription, filterable.
 */
import platformService from '../../services/platform-service.js';
import { escapeHtml } from '../../utils/dom.js';
import { page, loading, errorBox, tableCard, badge, fmtMoney, fmtDate, liveRefresh } from './kit.js';

export default async function subscriptionsPage(ctx, mount) {
  const p = page(mount, { title: 'Subscriptions', subtitle: 'All merchant subscriptions on POS TXbd' });
  const q = { ...ctx.query };

  const bar = document.createElement('div');
  bar.className = 'sa-filterbar';
  bar.innerHTML = `<select class="select" id="s-status">
    ${['all', 'active', 'past_due', 'pending', 'expired', 'suspended'].map((s) => `<option value="${s}"${(q.status || 'all') === s ? ' selected' : ''}>${s === 'all' ? 'Status: all' : s.replace('_', ' ').replace(/^\w/, (c) => c.toUpperCase())}</option>`).join('')}
  </select>`;
  p.body.appendChild(bar);
  const list = document.createElement('div');
  p.body.appendChild(list);
  bar.addEventListener('change', render);

  async function render() {
    loading(list);
    let res;
    try {
      const status = bar.querySelector('#s-status').value;
      res = await platformService.subscriptions(status === 'all' ? {} : { status });
    } catch (err) {
      return errorBox(list, err);
    }
    const rows = res.data.map((s) => `<tr class="sa-row" data-id="${s.merchantId}">
      <td><strong>${escapeHtml(s.merchantName)}</strong></td>
      <td>${escapeHtml(s.planName || '—')}</td>
      <td class="num">${fmtMoney(s.monthlyPrice ?? s.planPrice)}</td>
      <td>${badge(s.liveStatus)}</td>
      <td>${fmtDate(s.nextBillingAt || s.expiresAt)}</td>
      <td class="num">${s.dueAmount ? fmtMoney(s.dueAmount) : '—'}</td>
      <td>${fmtDate(s.startedAt)}</td>
    </tr>`);
    list.innerHTML = tableCard({
      head: [{ label: 'Merchant' }, { label: 'Plan' }, { label: 'Monthly', num: true }, { label: 'Status' }, { label: 'Next billing' }, { label: 'Due', num: true }, { label: 'Started' }],
      rows, empty: 'No subscriptions match.',
    });
    list.querySelectorAll('.sa-row').forEach((r) => r.addEventListener('click', () => { location.hash = '#/merchants/' + r.dataset.id; }));
  }
  await render();
  liveRefresh(p.body, render);
}
