/**
 * platform/revenue.js - platform income: today / month / total, split by
 * payment type (initial / monthly / branch), by month, by plan, plus the
 * upcoming billing schedule. Cards drill into the Payments ledger.
 */
import platformService from '../../services/platform-service.js';
import { renderKpi } from '../../components/kpi-card.js';
import { escapeHtml } from '../../utils/dom.js';
import { page, loading, errorBox, tableCard, fmtMoney, fmtDate, liveRefresh } from './kit.js';

export default async function revenuePage(ctx, mount) {
  const p = page(mount, { title: 'Revenue', subtitle: 'POS TXbd platform income — setup, monthly server charges & branch purchases' });
  loading(p.body);
  let rev;
  try {
    rev = await platformService.revenue();
  } catch (err) {
    return errorBox(p.body, err);
  }

  const maxMonth = Math.max(1, ...rev.byMonth.map((x) => x.amount));
  const t = rev.byType || { initial: 0, monthly: 0, branch: 0 };

  p.body.innerHTML = `
    <div class="kpi-grid">
      ${renderKpi({ label: 'Collected today', value: fmtMoney(rev.today || 0), icon: 'banknote', tone: 'brand' })}
      ${renderKpi({ label: 'This month', value: fmtMoney(rev.thisMonth || 0), icon: 'trending-up', tone: 'success' })}
      ${renderKpi({ label: 'Total collected', value: fmtMoney(rev.total), icon: 'dollar-sign', tone: 'success', href: '#/payments', foot: `${rev.count} payments` })}
      ${renderKpi({ label: 'Pending approval', value: rev.pendingCount || 0, icon: 'clock', tone: (rev.pendingCount ? 'warning' : 'muted'), href: '#/payments?status=pending', foot: fmtMoney(rev.pendingSum || 0) })}
      ${renderKpi({ label: 'Approved payments', value: rev.approvedCount ?? rev.count ?? 0, icon: 'check', tone: 'success', href: '#/payments?status=paid' })}
      ${renderKpi({ label: 'Rejected payments', value: rev.rejectedCount || 0, icon: 'x', tone: (rev.rejectedCount ? 'danger' : 'muted'), href: '#/payments?status=rejected' })}
    </div>

    <div class="sa-detail-grid">
      <div class="card card--pad">
        <div class="form-section-title">By payment type</div>
        <a class="sa-kv" href="#/payments?type=initial"><span>Initial / plan purchases</span><b>${fmtMoney(t.initial)}</b></a>
        <a class="sa-kv" href="#/payments?type=monthly"><span>Monthly server &amp; backup</span><b>${fmtMoney(t.monthly)}</b></a>
        <a class="sa-kv" href="#/payments?type=branch"><span>Additional branches</span><b>${fmtMoney(t.branch)}</b></a>
      </div>
      <div class="card card--pad">
        <div class="form-section-title">By plan</div>
        ${rev.byPlan.length ? rev.byPlan.map((x) => `<div class="sa-kv"><span>${escapeHtml(x.planName)}</span><b>${fmtMoney(x.amount)}</b></div>`).join('') : '<p class="muted">No payments yet.</p>'}
      </div>
      <div class="card card--pad">
        <div class="form-section-title">By month</div>
        <div class="sa-bars">
          ${rev.byMonth.length ? rev.byMonth.map((x) => `
            <div class="sa-bar"><span class="sa-bar__label">${escapeHtml(x.month)}</span>
              <span class="sa-bar__track"><span class="sa-bar__fill" style="width:${Math.round(x.amount / maxMonth * 100)}%"></span></span>
              <span class="sa-bar__val">${fmtMoney(x.amount)}</span></div>`).join('') : '<p class="muted">No payments yet.</p>'}
        </div>
      </div>
    </div>

    <h3 class="sa-h3">Upcoming billing (next 30 days)</h3>
    ${tableCard({
      head: [{ label: 'Merchant' }, { label: 'Due date' }, { label: 'Amount', num: true }],
      rows: (rev.upcoming || []).map((x) => `<tr class="sa-row" data-id="${x.merchantId}"><td>${escapeHtml(x.merchantName)}</td><td>${fmtDate(x.dueAt)}</td><td class="num">${fmtMoney(x.amount)}</td></tr>`),
      empty: 'No subscriptions bill in the next 30 days.',
    })}`;

  p.body.querySelectorAll('.sa-row').forEach((r) => r.addEventListener('click', () => { location.hash = '#/merchants/' + r.dataset.id; }));

  liveRefresh(p.root, () => revenuePage(ctx, mount), 1500);
}
