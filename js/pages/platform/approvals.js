/**
 * platform/approvals.js - Super Admin -> Approvals.
 *
 * One queue for everything waiting on the Super Admin: merchants pending
 * activation, submitted manual payments awaiting verification, and overdue
 * subscriptions. Each card shows the transaction id / proof / a WhatsApp
 * shortcut; Approve activates the service and notifies the merchant, Reject
 * records a reason and leaves them pending.
 */
import platformService from '../../services/platform-service.js';
import { confirmDialog } from '../../components/confirm.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { icon } from '../../components/icons.js';
import { page, loading, errorBox, badge, fmtMoney, fmtDateTime, liveRefresh } from './kit.js';

const TYPE_LABEL = { initial: 'Initial plan purchase', monthly: 'Monthly charge', branch: 'Additional branch' };

export default async function approvalsPage(ctx, mount) {
  const p = page(mount, { title: 'Approvals', subtitle: 'Verify payments and activate merchant accounts, branches and subscriptions' });
  loading(p.body);
  await render();
  liveRefresh(p.body, render);

  async function render() {
    let res;
    try {
      res = await platformService.approvals();
    } catch (err) {
      return errorBox(p.body, err);
    }
    const rows = res.data || [];
    const c = res.counts || {};

    if (!rows.length) {
      p.body.innerHTML = `<div class="sa-card sa-empty" style="padding:48px 20px">
        <span class="sa-empty__icon">${icon('check-circle', { size: 26 })}</span>
        <p>All caught up — nothing is waiting for approval.</p>
      </div>`;
      return;
    }

    p.body.innerHTML = `
      <div class="sa-attn-strip">
        <span>${icon('user', { size: 14 })} ${c.accounts || 0} account${c.accounts === 1 ? '' : 's'} to approve</span>
        <span>${icon('credit-card', { size: 14 })} ${c.payments || 0} payment${c.payments === 1 ? '' : 's'} to verify</span>
        <span>${icon('clock', { size: 14 })} ${c.overdue || 0} overdue</span>
      </div>
      <div class="sa-approvals">${rows.map(cardHtml).join('')}</div>`;

    p.body.querySelectorAll('.js-approve').forEach((b) => b.addEventListener('click', () => approve(b.dataset.id, b.dataset.name)));
    p.body.querySelectorAll('.js-reject').forEach((b) => b.addEventListener('click', () => reject(b.dataset.id)));
    p.body.querySelectorAll('.js-proof').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const img = a.dataset.src;
      const dlg = openModal({ title: 'Payment proof', size: 'md', body: `<img src="${escapeHtml(img)}" alt="Payment proof" style="max-width:100%;border-radius:8px">` });
      void dlg;
    }));
  }

  function cardHtml(r) {
    const pay = r.pendingPayment;
    const owed = pay ? pay.amount : (r.dueAmount || r.setupPrice || 0);
    return `<div class="sa-card sa-approval">
      <div class="sa-approval__head">
        <div>
          <a class="sa-approval__biz" href="#/merchants/${escapeHtml(r.merchantId)}">${escapeHtml(r.businessName)}</a>
          <div class="muted text-sm">${escapeHtml(r.ownerName)} · ${escapeHtml(r.email)}</div>
        </div>
        ${badge(r.subscriptionStatus)}
      </div>
      <div class="sa-approval__body">
        <div class="sa-kv"><span>Plan</span><b>${escapeHtml(r.planName || '—')}</b></div>
        ${pay
          ? `<div class="sa-kv"><span>Payment</span><b>${escapeHtml(TYPE_LABEL[pay.type] || pay.type)} · ${fmtMoney(pay.amount)}</b></div>
             <div class="sa-kv"><span>Method</span><b>${escapeHtml(pay.method || '—')}</b></div>
             <div class="sa-kv"><span>Transaction ID</span><b>${escapeHtml(pay.reference || '—')}</b></div>
             <div class="sa-kv"><span>Paid from</span><b>${escapeHtml(pay.accountNumber || '—')}</b></div>
             <div class="sa-kv"><span>Submitted</span><b>${fmtDateTime(pay.at)}</b></div>
             ${pay.note ? `<div class="sa-kv"><span>Note</span><b>${escapeHtml(pay.note)}</b></div>` : ''}`
          : `<div class="sa-kv"><span>Amount due</span><b>${fmtMoney(owed)}</b></div>
             <div class="sa-kv"><span>Waiting for</span><b>${r.subscriptionStatus === 'pending' ? 'First payment / activation' : 'Overdue payment'}</b></div>`}
      </div>
      <div class="sa-approval__actions">
        ${pay?.proofImage ? `<a href="#" class="btn btn--ghost btn--sm js-proof" data-src="${escapeHtml(pay.proofImage)}">${icon('file', { size: 14 })} Proof</a>` : ''}
        ${r.whatsapp ? `<a href="${escapeHtml(r.whatsapp)}" target="_blank" rel="noopener" class="btn btn--ghost btn--sm">${icon('smartphone', { size: 14 })} WhatsApp</a>` : ''}
        <span class="grow"></span>
        <button class="btn btn--ghost btn--sm js-reject" data-id="${escapeHtml(r.merchantId)}">Reject</button>
        <button class="btn btn--primary btn--sm js-approve" data-id="${escapeHtml(r.merchantId)}" data-name="${escapeHtml(r.businessName)}">Approve &amp; activate</button>
      </div>
    </div>`;
  }

  async function approve(id, name) {
    if (!(await confirmDialog({ title: `Approve ${name}?`, message: 'The payment is marked verified, the account / branch / subscription is activated, and the merchant is notified.', confirmLabel: 'Approve & activate' }))) return;
    try {
      await platformService.approveMerchant(id);
      toast.success('Approved — the merchant now has access');
      loading(p.body);
      await render();
    } catch (err) { toast.error(err?.data?.message || 'Could not approve'); }
  }
  async function reject(id) {
    const reason = window.prompt('Reason for rejecting (shown to the merchant):', '');
    if (reason === null) return;
    try {
      await platformService.rejectMerchant(id, reason);
      toast.success('Rejected — the merchant has been notified');
      loading(p.body);
      await render();
    } catch (err) { toast.error(err?.data?.message || 'Could not reject'); }
  }
}
