/**
 * billing.js - the merchant's own subscription: plan, setup fee, monthly
 * server & backup charge, next billing date, amount due, payment history, and
 * a Pay button that runs through the configured POS TXbd payment gateway.
 */
import { pageShell, statStrip, card, statusBadge } from '../shared/page-kit.js';
import { session } from '../../core/session.js';
import billingService from '../../services/billing-service.js';
import { openPaymentSheet } from '../../components/payment-sheet.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import money from '../../utils/money.js';

const fmtDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const TYPE_LABEL = { initial: 'Initial / setup', monthly: 'Monthly charge', branch: 'Additional branch' };
const STATUS_LABEL = { pending: 'Pending approval', paid: 'Approved', failed: 'Failed', refunded: 'Refunded', rejected: 'Rejected', cancelled: 'Cancelled' };

export default async function billingPage(ctx, mount) {
  const p = pageShell(mount, { title: 'Subscription & billing', subtitle: 'Your POS TXbd plan, server charge and payment history' });
  p.body.innerHTML = `<div class="loading-block"><span class="spinner"></span></div>`;

  let s;
  try {
    s = await billingService.summary();
  } catch (err) {
    p.body.innerHTML = `<div class="alert alert--danger"><div class="alert__body">${escapeHtml(err?.data?.message || err.message || 'Could not load billing.')}</div></div>`;
    return;
  }

  render();

  function render() {
    const sub = s.subscription;
    if (!sub) {
      p.body.innerHTML = `<div class="alert alert--info"><div class="alert__body">No subscription is attached to this business yet. Contact POS TXbd support.</div></div>`;
      return;
    }
    const due = sub.dueAmount || 0;
    const b = s.branches;

    const blocked = ['expired', 'suspended', 'cancelled'].includes(sub.status);
    const dl = sub.daysLeft;
    const countdown =
      blocked ? 'Subscription ended' :
      dl == null ? 'No end date' :
      dl < 0 ? `Expired ${-dl} day${dl === -1 ? '' : 's'} ago` :
      dl === 0 ? 'Expires today' :
      dl === 1 ? '1 day left' :
      `${dl} days left`;
    const tone = (blocked || dl != null && dl <= 1) ? 'danger' : (dl != null && dl <= 7) ? 'warning' : 'success';

    p.body.innerHTML = `
      ${due > 0 ? `<div class="alert alert--${blocked ? 'danger' : 'warning'}"><div class="alert__body" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span><strong>${money.format(due)} due now.</strong>
        ${sub.status === 'pending' && !sub.setupPaid ? ' Pay the plan purchase fee to activate your account.' : blocked ? ' Your access is limited until this is paid and approved.' : ' Your monthly server &amp; backup charge is overdue.'}</span>
        <button class="btn btn--primary btn--sm" id="pay-due">Pay ${money.format(due)}</button>
      </div></div>` : ''}

      <h3 class="billing-h3">Monthly subscription</h3>
      <div class="sub-countdown sub-countdown--${tone}">
        <div class="sub-countdown__main">
          <span class="sub-countdown__big">${escapeHtml(countdown)}</span>
          <span class="sub-countdown__sub">${blocked ? 'Pay the monthly charge and wait for approval to restore access.' : `Renews for ${money.format(sub.monthlyPrice)} / ${escapeHtml(sub.billingPeriod === 'yearly' ? 'year' : 'month')}. Every period you pay this charge to keep the service running.`}</span>
        </div>
        <div class="sub-countdown__meta">
          <div><span>Status</span>${statusBadge(sub.status)}</div>
          <div><span>Ends</span><b>${fmtDate(sub.expiresAt)}</b></div>
          <div><span>Next payment</span><b>${money.format(sub.monthlyPrice)}</b></div>
        </div>
        <button class="btn btn--primary" id="pay-sub">Pay ${money.format(sub.monthlyPrice)} now</button>
      </div>

      <h3 class="billing-h3">Billing</h3>
      ${statStrip([
        { label: 'Plan', value: escapeHtml(sub.planName || '—') },
        { label: 'Status', value: statusBadge(sub.status) },
        { label: 'Monthly charge', value: money.format(sub.monthlyPrice) },
        { label: 'Next billing', value: fmtDate(sub.nextBillingAt) },
        { label: 'Branches', value: `${b.used} / ${b.limit}` },
      ])}

      <div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--sp-4)">
        ${card('This plan', `
          <div class="kv-list">
            <div class="kv"><span>Initial / setup fee</span><b>${money.format(sub.setupPrice)} ${sub.setupPaid ? '· paid' : '· unpaid'}</b></div>
            <div class="kv"><span>Monthly server &amp; backup</span><b>${money.format(sub.monthlyPrice)} / ${escapeHtml(sub.billingPeriod === 'yearly' ? 'year' : 'month')}</b></div>
            <div class="kv"><span>Started</span><b>${fmtDate(sub.startedAt)}</b></div>
            <div class="kv"><span>Current period ends</span><b>${fmtDate(sub.expiresAt)}</b></div>
            <div class="kv"><span>Branches included</span><b>${b.included} (+${b.extraPaid} purchased)</b></div>
          </div>
          <div style="margin-top:var(--sp-3);display:flex;gap:8px;flex-wrap:wrap">
            ${!sub.setupPaid ? `<button class="btn btn--primary" id="pay-setup">Pay setup fee (${money.format(sub.setupPrice)})</button>` : ''}
            <button class="btn ${sub.setupPaid ? 'btn--primary' : 'btn--ghost'}" id="pay-monthly">Pay monthly charge (${money.format(sub.monthlyPrice)})</button>
          </div>`)}

        ${card('How to pay', `
          <p><strong>${escapeHtml(s.gateway.displayName)}</strong></p>
          <p class="muted" style="white-space:pre-wrap">${escapeHtml(s.gateway.instructions || 'Choose a payment above and follow the instructions.')}</p>
        `)}
      </div>

      <h3 style="margin:var(--sp-5) 0 var(--sp-2)">Payment History</h3>
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Date</th><th>For</th><th class="num">Amount</th><th>Method</th><th>Transaction ID</th><th>Status</th><th>Approved</th><th></th></tr></thead>
        <tbody>
          ${s.payments.length ? s.payments.map((x) => `<tr>
            <td>${fmtDate(x.at)}</td>
            <td>${escapeHtml(TYPE_LABEL[x.type] || x.type || 'Monthly')}</td>
            <td class="num">${money.format(x.amount)}</td>
            <td>${escapeHtml(x.method || '—')}</td>
            <td>${escapeHtml(x.reference || x.gatewayRef || '—')}</td>
            <td>${escapeHtml(STATUS_LABEL[x.status] || x.status || 'Paid')}</td>
            <td>${x.status === 'paid' && x.confirmedAt ? fmtDate(x.confirmedAt) : '—'}</td>
            <td>${(x.status || 'pending') === 'pending' ? `<button class="btn btn--ghost btn--sm js-cancel" data-id="${escapeHtml(x.id)}">Cancel</button>` : ''}</td>
          </tr>`).join('') : `<tr><td colspan="8" class="muted" style="text-align:center;padding:20px">No payments yet.</td></tr>`}
        </tbody>
      </table></div></div>`;

    p.body.querySelector('#pay-setup')?.addEventListener('click', () => payFlow('initial'));
    p.body.querySelector('#pay-monthly')?.addEventListener('click', () => payFlow('monthly'));
    p.body.querySelector('#pay-sub')?.addEventListener('click', () => payFlow('monthly'));
    p.body.querySelector('#pay-due')?.addEventListener('click', () => payFlow(!sub.setupPaid ? 'initial' : 'monthly'));
    p.body.querySelectorAll('.js-cancel').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Cancel this payment request?', message: 'It will be withdrawn. You can submit a new one any time.', confirmLabel: 'Cancel request', danger: true }))) return;
      try {
        const res = await billingService.cancelPayment(b.dataset.id);
        s = res.summary;
        toast.success('Request cancelled');
        render();
      } catch (err) { toast.error(err?.data?.message || 'Could not cancel'); }
    }));
  }

  async function payFlow(type) {
    const sub = s.subscription;
    const amount = type === 'initial' ? sub.setupPrice : sub.monthlyPrice;
    await openPaymentSheet({
      paymentType: type,
      amount,
      referenceLabel: `${sub.planName || 'Plan'} — ${type === 'initial' ? 'initial purchase' : 'monthly server & backup charge'}`,
      submit: (f) => billingService.pay({ type, ...f }),
      onDone: async () => {
        s = await billingService.summary().catch(() => s);
        await session.restore().catch(() => {});
        render();
      },
    });
  }
}
