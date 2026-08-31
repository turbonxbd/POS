/**
 * platform/payments.js - Super Admin -> Payment Requests.
 *
 * Every merchant payment on the platform: initial plan purchases, monthly
 * server charges and additional-branch purchases. Pending manual submissions
 * are shown first; open one to see the transaction details + proof and
 * Approve (activates the service) or Reject.
 */
import platformService from '../../services/platform-service.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { page, loading, errorBox, tableCard, badge, fmtMoney, fmtDateTime, liveRefresh } from './kit.js';

const TYPE_LABEL = { initial: 'Initial plan purchase', monthly: 'Monthly charge', branch: 'Additional branch' };
const STATUS_TONE = { pending: 'warning', paid: 'success', rejected: 'danger', failed: 'danger', refunded: 'muted', cancelled: 'muted' };
const STATUS_LABEL = { pending: 'Pending', paid: 'Approved', rejected: 'Rejected', failed: 'Failed', refunded: 'Refunded', cancelled: 'Cancelled' };

export default async function paymentsPage(ctx, mount) {
  const p = page(mount, { title: 'Payment Requests', subtitle: 'Verify and approve merchant payments — initial purchases, monthly charges and branch purchases' });
  const q = { ...ctx.query };

  const bar = document.createElement('div');
  bar.className = 'sa-filterbar';
  bar.innerHTML = `
    <select class="select" id="pf-type">
      ${['all', 'initial', 'monthly', 'branch'].map((s) => `<option value="${s}"${(q.type || 'all') === s ? ' selected' : ''}>${s === 'all' ? 'Type: all' : TYPE_LABEL[s]}</option>`).join('')}
    </select>
    <select class="select" id="pf-status">
      ${['all', 'pending', 'paid', 'rejected', 'failed', 'refunded', 'cancelled'].map((s) => `<option value="${s}"${(q.status || 'all') === s ? ' selected' : ''}>${s === 'all' ? 'Status: all' : STATUS_LABEL[s] || s}</option>`).join('')}
    </select>`;
  p.body.appendChild(bar);
  const list = document.createElement('div');
  p.body.appendChild(list);
  bar.addEventListener('change', render);

  async function render() {
    loading(list);
    let res;
    try {
      const params = {};
      if (bar.querySelector('#pf-type').value !== 'all') params.type = bar.querySelector('#pf-type').value;
      if (bar.querySelector('#pf-status').value !== 'all') params.status = bar.querySelector('#pf-status').value;
      res = await platformService.payments(params);
    } catch (err) {
      return errorBox(list, err);
    }
    const all = [...res.data].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    const byId = new Map(all.map((x) => [x.id, x]));
    const pend = all.filter((x) => (x.status || 'pending') === 'pending');
    const settled = all.filter((x) => (x.status || 'pending') !== 'pending');

    const queue = pend.length ? `
      <div class="sa-section"><h3>Waiting for verification (${pend.length})</h3><span class="sa-section__hint">${fmtMoney(pend.reduce((s, x) => s + (x.amount || 0), 0))} pending</span></div>
      <div class="sa-payq">${pend.map((x) => `
        <div class="sa-card sa-payq__card" data-id="${escapeHtml(x.id)}">
          <div class="sa-payq__top">
            <a href="#/merchants/${escapeHtml(x.merchantId)}">${escapeHtml(x.businessName || x.merchantName || '—')}</a>
            <span class="sa-payq__amt">${fmtMoney(x.amount)}</span>
          </div>
          <div class="muted text-sm">${escapeHtml(TYPE_LABEL[x.type] || x.type || 'monthly')} · ${escapeHtml(x.method || '—')} · ${fmtDateTime(x.at)}</div>
          <div class="sa-kv"><span>Transaction ID</span><b>${escapeHtml(x.reference || '—')}</b></div>
          <div class="sa-kv"><span>Paid from</span><b>${escapeHtml(x.accountNumber || '—')}</b></div>
          ${x.note ? `<div class="sa-kv"><span>Note</span><b>${escapeHtml(x.note)}</b></div>` : ''}
          ${x.proofImage ? `<a class="sa-payq__proof js-open" data-id="${escapeHtml(x.id)}" href="#"><img src="${escapeHtml(x.proofImage)}" alt="Payment proof"></a>` : ''}
          <div class="sa-payq__actions">
            <button class="btn btn--ghost btn--sm js-open" data-id="${escapeHtml(x.id)}">Details</button>
            <span class="grow"></span>
            <button class="btn btn--ghost btn--sm js-reject" data-id="${escapeHtml(x.id)}">Reject</button>
            <button class="btn btn--primary btn--sm js-approve" data-id="${escapeHtml(x.id)}">Approve</button>
          </div>
        </div>`).join('')}</div>` : '';

    const rows = settled.map((x) => `<tr class="sa-row" data-id="${escapeHtml(x.id)}">
      <td>${fmtDateTime(x.at)}</td>
      <td>${escapeHtml(x.businessName || x.merchantName || '—')}</td>
      <td>${escapeHtml(TYPE_LABEL[x.type] || x.type || 'monthly')}</td>
      <td class="num">${fmtMoney(x.amount)}</td>
      <td>${escapeHtml(x.method || '—')}</td>
      <td>${escapeHtml(x.reference || '—')}</td>
      <td>${badge(STATUS_LABEL[x.status] || x.status || 'pending', STATUS_TONE[x.status || 'pending'])}</td>
    </tr>`);

    list.innerHTML = queue + `
      <div class="sa-section"><h3>History</h3><span class="sa-section__hint">${settled.length} settled · ${fmtMoney(res.sum)} approved</span></div>` +
      tableCard({
        head: [{ label: 'Date' }, { label: 'Merchant' }, { label: 'Type' }, { label: 'Amount', num: true }, { label: 'Method' }, { label: 'Transaction ID' }, { label: 'Status' }],
        rows, empty: pend.length ? 'Nothing settled yet.' : 'No payment requests match these filters.',
      });

    list.querySelectorAll('.sa-row').forEach((r) => r.addEventListener('click', () => openDetail(byId.get(r.dataset.id))));
    list.querySelectorAll('.js-open').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openDetail(byId.get(b.dataset.id)); }));
    list.querySelectorAll('.js-approve').forEach((b) => b.addEventListener('click', () => approve(b.dataset.id)));
    list.querySelectorAll('.js-reject').forEach((b) => b.addEventListener('click', () => reject(b.dataset.id)));
  }

  async function approve(id) {
    if (!(await confirmDialog({ title: 'Approve this payment?', message: 'The merchant\'s subscription / branch is activated and their access is restored.', confirmLabel: 'Approve' }))) return;
    try { await platformService.updatePayment(id, { status: 'paid' }); toast.success('Payment approved'); render(); }
    catch (err) { toast.error(err?.data?.message || 'Could not approve'); }
  }
  async function reject(id) {
    const reason = window.prompt('Reason for rejecting this payment (shown to the merchant):', '');
    if (reason === null) return;
    try { await platformService.updatePayment(id, { status: 'rejected', reason }); toast.success('Payment rejected'); render(); }
    catch (err) { toast.error(err?.data?.message || 'Could not reject'); }
  }

  function openDetail(x) {
    if (!x) return;
    const m = openModal({ title: 'Payment request', subtitle: `${x.businessName || x.merchantName || ''} · ${fmtMoney(x.amount)}`, size: 'md', body: '<div></div>' });
    const kv = (k, v) => `<div class="sa-kv"><span>${escapeHtml(k)}</span><b>${v}</b></div>`;
    m.$('.modal__body').innerHTML = `
      ${kv('Merchant', escapeHtml(x.businessName || x.merchantName || '—'))}
      ${kv('Payment type', escapeHtml(TYPE_LABEL[x.type] || x.type || '—'))}
      ${x.meta?.planOrBranch ? kv('Plan / Branch', escapeHtml(x.meta.planOrBranch)) : ''}
      ${kv('Amount', fmtMoney(x.amount))}
      ${kv('Method', escapeHtml(x.method || '—'))}
      ${kv('Transaction ID', escapeHtml(x.reference || '—'))}
      ${kv('Paid from', escapeHtml(x.accountNumber || '—'))}
      ${kv('Submitted', fmtDateTime(x.at))}
      ${kv('Submitted by', escapeHtml(x.submittedBy || '—'))}
      ${x.note ? kv('Merchant note', escapeHtml(x.note)) : ''}
      ${kv('Status', badge(STATUS_LABEL[x.status] || x.status || 'pending', STATUS_TONE[x.status || 'pending']))}
      ${x.rejectedReason ? kv('Rejection reason', escapeHtml(x.rejectedReason)) : ''}
      ${x.confirmedAt ? kv('Decided', `${fmtDateTime(x.confirmedAt)}${x.confirmedBy ? ' · ' + escapeHtml(x.confirmedBy) : ''}`) : ''}
      ${x.proofImage ? `<div style="margin-top:12px"><span class="muted text-sm">Payment proof</span><br><a href="${escapeHtml(x.proofImage)}" target="_blank" rel="noopener"><img src="${escapeHtml(x.proofImage)}" alt="Payment proof" style="max-width:100%;border-radius:8px;border:1px solid var(--border);margin-top:6px"></a></div>` : ''}`;
    if ((x.status || 'pending') === 'pending') {
      m.setFooter(`<button class="btn btn--ghost js-d-reject">Reject</button><button class="btn btn--primary js-d-approve">Approve</button>`);
      m.$('.js-d-approve').addEventListener('click', async () => { m.close(); await approve(x.id); });
      m.$('.js-d-reject').addEventListener('click', async () => { m.close(); await reject(x.id); });
    }
  }

  await render();
  liveRefresh(p.body, render);
}
