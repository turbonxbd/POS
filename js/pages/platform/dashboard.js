/**
 * platform/dashboard.js - the POS TXbd Super Admin overview.
 *
 * Top: what needs the Super Admin's attention right now. Then revenue (with a
 * monthly chart), then grouped merchant / subscription / support counts, then a
 * recent-activity feed. Every card drills into its detail page.
 */
import platformService from '../../services/platform-service.js';
import platformNotificationService from '../../services/platform-notification-service.js';
import { renderKpi } from '../../components/kpi-card.js';
import { createChart } from '../../components/chart.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { page, loading, errorBox, fmtMoney, fmtDateTime, liveRefresh } from './kit.js';

export default async function dashboardPage(ctx, mount) {
  const p = page(mount, { title: 'Platform overview', subtitle: 'POS TXbd — merchants, subscriptions & revenue' });
  loading(p.body);

  let d, rev, notes;
  try {
    [d, rev, notes] = await Promise.all([
      platformService.dashboard(),
      platformService.revenue().catch(() => null),
      platformNotificationService.list({ pageSize: 8 }).catch(() => ({ data: [] })),
    ]);
  } catch (err) {
    return errorBox(p.body, err);
  }

  const attn = d.attention || {};
  const subs = d.subscriptions || {};
  const attnCards = [
    { n: attn.accounts || 0, label: 'account' + (attn.accounts === 1 ? '' : 's') + ' to approve', href: '#/approvals', icon: 'user', tone: attn.accounts ? 'alert' : '' },
    { n: attn.payments || 0, label: 'payment' + (attn.payments === 1 ? '' : 's') + ' to verify', href: '#/payments?status=pending', icon: 'credit-card', tone: attn.payments ? 'alert' : '' },
    { n: attn.overdue || 0, label: 'subscription' + (attn.overdue === 1 ? '' : 's') + ' overdue', href: '#/subscriptions?status=expired', icon: 'clock', tone: attn.overdue ? 'danger' : '' },
  ];
  const attnTotal = attnCards.reduce((s, c) => s + c.n, 0);

  const money = (v) => fmtMoney(v || 0);

  p.body.innerHTML = `
    <div class="sa-section"><h2>Needs attention</h2></div>
    ${attnTotal === 0
      ? `<div class="sa-card sa-empty" style="padding:24px"><span class="sa-empty__icon">${icon('check-circle', { size: 22 })}</span><p>You're all caught up — no approvals or overdue accounts.</p></div>`
      : `<div class="sa-attention">${attnCards.map((c) => `
          <a class="sa-attn ${c.tone ? 'sa-attn--' + c.tone : ''}" href="${c.href}">
            <span class="sa-attn__icon">${icon(c.icon, { size: 18 })}</span>
            <span><span class="sa-attn__num">${c.n}</span><br><span class="sa-attn__label">${c.label}</span></span>
          </a>`).join('')}</div>`}

    <div class="sa-section"><h2>Revenue</h2><a class="sa-section__hint" href="#/revenue">Open revenue &rarr;</a></div>
    <div class="kpi-grid">
      ${renderKpi({ label: 'Monthly recurring (MRR)', value: money(d.revenue.mrr), icon: 'trending-up', tone: 'success', href: '#/revenue' })}
      ${renderKpi({ label: 'Revenue this month', value: money(d.revenue.thisMonth), icon: 'banknote', tone: 'brand', href: '#/revenue' })}
      ${renderKpi({ label: 'Total collected', value: money(d.revenue.total), icon: 'dollar-sign', tone: 'brand', href: '#/revenue', foot: `${d.revenue.payments} payments` })}
      ${renderKpi({ label: 'Setup / plan purchases', value: money(d.revenue.byType?.initial || 0), icon: 'tag', tone: 'brand' })}
      ${renderKpi({ label: 'Branch purchases', value: money(d.revenue.byType?.branch || 0), icon: 'building', tone: 'brand' })}
    </div>
    ${(rev?.byMonth || []).length ? `<div class="sa-card sa-card--pad" style="margin-top:var(--sp-3)"><div class="form-section-title">Collected by month</div><div id="sa-rev-chart" style="height:220px"></div></div>` : ''}

    <div class="sa-section"><h2>Merchants</h2><a class="sa-section__hint" href="#/merchants">All merchants &rarr;</a></div>
    <div class="kpi-grid">
      ${renderKpi({ label: 'Total merchants', value: d.merchants.total, icon: 'building', tone: 'brand', href: '#/merchants', foot: `${d.merchants.new30d} new this month` })}
      ${renderKpi({ label: 'Active', value: d.merchants.active, icon: 'check-circle', tone: 'success', href: '#/merchants?status=active' })}
      ${renderKpi({ label: 'Suspended', value: d.merchants.inactive, icon: 'alert-triangle', tone: (d.merchants.inactive ? 'danger' : 'muted'), href: '#/merchants?status=suspended' })}
      ${renderKpi({ label: 'Active subscriptions', value: subs.active, icon: 'rotate-ccw', tone: 'info', href: '#/subscriptions?status=active' })}
      ${renderKpi({ label: 'Past due (in grace)', value: subs.pastDue || 0, icon: 'clock', tone: (subs.pastDue ? 'warning' : 'muted'), href: '#/subscriptions?status=past_due' })}
      ${renderKpi({ label: 'Expired', value: subs.expired || 0, icon: 'alert-triangle', tone: (subs.expired ? 'danger' : 'muted'), href: '#/subscriptions?status=expired' })}
      ${renderKpi({ label: 'Pending activation', value: subs.pending || 0, icon: 'clock', tone: (subs.pending ? 'warning' : 'muted'), href: '#/approvals' })}
      ${renderKpi({ label: 'Plans', value: d.plans, icon: 'tag', tone: 'brand', href: '#/plans' })}
    </div>

    <div class="sa-section"><h2>Support &amp; chat</h2></div>
    <div class="kpi-grid">
      ${renderKpi({ label: 'Open support requests', value: d.support.open, icon: 'help', tone: (d.support.open ? 'warning' : 'muted'), href: '#/support?status=open' })}
      ${renderKpi({ label: 'Open chats', value: d.chat?.open || 0, icon: 'inbox', tone: (d.chat?.open ? 'warning' : 'muted'), href: '#/chat?status=open' })}
    </div>

    <div class="sa-detail-grid">
      <div class="sa-card sa-card--pad">
        <div class="form-section-title">Recent activity</div>
        ${(notes.data || []).length
          ? `<div class="sa-activity">${notes.data.map((n) => `
              <div class="sa-activity__item">
                <span class="sa-activity__dot ${n.level === 'warning' || n.level === 'danger' ? 'sa-activity__dot--warning' : ''}"></span>
                <div class="sa-activity__body">
                  <strong>${escapeHtml(n.title || 'Update')}</strong>
                  <p>${escapeHtml(n.message || '')}</p>
                  <time>${fmtDateTime(n.at)}</time>
                </div>
              </div>`).join('')}</div>`
          : '<p class="muted">No activity yet.</p>'}
      </div>
      <div class="sa-card sa-card--pad">
        <div class="form-section-title">Platform usage (all merchants)</div>
        <div class="sa-usage__grid">
          <div><span>${d.usage.branches}</span><label>Branches</label></div>
          <div><span>${d.usage.users}</span><label>Cashiers / users</label></div>
          <div><span>${d.usage.products}</span><label>Products</label></div>
          <div><span>${d.usage.sales}</span><label>Sales rung up</label></div>
          <div><span>${money(d.usage.grossSales)}</span><label>Gross sales processed</label></div>
        </div>
      </div>
    </div>`;

  const chartMount = p.body.querySelector('#sa-rev-chart');
  if (chartMount && rev?.byMonth?.length) {
    try {
      createChart(chartMount, {
        type: 'bar',
        data: {
          labels: rev.byMonth.map((x) => x.month),
          series: [{ name: 'Collected', values: rev.byMonth.map((x) => x.amount), color: 'var(--accent)' }],
        },
        options: { valueFormat: 'money', height: 220 },
      });
    } catch { /* chart is decorative */ }
  }

  liveRefresh(p.root, () => dashboardPage(ctx, mount), 1500);
}
