/**
 * dashboard.js - interactive business-intelligence dashboard.
 * Every card, payment tile, chart point and rank row drills into the detailed
 * report that produced the number (js/pages/admin/reports.js).
 */
import { pageShell } from '../shared/page-kit.js';
import { renderKpi } from '../../components/kpi-card.js';
import { createChart, chartLegend } from '../../components/chart.js';
import { kpiSkeleton, blockLoader } from '../../components/skeleton.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { toast } from '../../components/toast.js';
import { exportJson } from '../../utils/csv.js';
import money from '../../utils/money.js';
import { num } from '../../utils/format.js';
import reportService from '../../services/report-service.js';
import { can } from '../../core/rbac.js';
import store from '../../core/store.js';
import bus from '../../core/event-bus.js';

const PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'last_week', label: 'Last Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_year', label: 'This Year' },
];

let charts = [];

export default async function dashboardPage(ctx, mount) {
  charts.forEach((c) => c.destroy?.());
  charts = [];

  const q = ctx.query || {};
  const custom = q.from && q.to ? { from: q.from, to: q.to } : null;
  // Always open on TODAY. The range is never remembered across reloads - the
  // user picks 7-day / 30-day / custom when they want it, and a fresh page load
  // always shows today's numbers again.
  const preset = custom ? 'custom' : q.preset || 'today';

  const branch = (store.get('branches') || []).find((b) => b.id === store.get('activeBranchId'));
  const shell = pageShell(mount, {
    title: 'Dashboard',
    subtitle: `${store.get('business')?.name || 'TX Demo'}${branch ? ' · ' + branch.name : ''}`,
    actions: [can('reports.export') && { label: 'Export', icon: 'download', variant: 'outline', onClick: () => exportCurrent() }].filter(Boolean),
  });

  const rangeQS = () => (custom ? `from=${encodeURIComponent(custom.from)}&to=${encodeURIComponent(custom.to)}` : `preset=${preset}`);
  const reportHref = (type, extra = '') => `#/reports/${type}?${rangeQS()}${extra ? '&' + extra : ''}`;

  shell.body.innerHTML = `
    <div class="filter-bar" style="justify-content:space-between">
      <div class="segmented" role="group" aria-label="Date range" id="dt-seg">
        ${PRESETS.map((p) => `<button data-p="${p.value}" aria-pressed="${p.value === preset}">${p.label}</button>`).join('')}
        <button data-p="custom" aria-pressed="${preset === 'custom'}">Custom</button>
      </div>
      <div class="row js-custom" ${preset === 'custom' ? '' : 'hidden'}>
        <input type="date" class="input js-from" value="${custom?.from?.slice(0, 10) || ''}" style="width:auto;height:34px">
        <span class="muted">to</span>
        <input type="date" class="input js-to" value="${custom?.to?.slice(0, 10) || ''}" style="width:auto;height:34px">
        <button class="btn btn--sm js-apply">Apply</button>
      </div>
    </div>
    <div id="kpis">${kpiSkeleton(6)}</div>
    <div id="pay-section" class="card" style="margin-top:var(--sp-4)"></div>
    <div class="dash-grid" id="charts">${blockLoader('Building charts…')}</div>`;

  const $ = (s) => shell.body.querySelector(s);
  $('#dt-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    if (b.dataset.p === 'custom') {
      $('.js-custom').hidden = false;
      return;
    }
    location.hash = `#/?preset=${b.dataset.p}`;
  });
  $('.js-apply').addEventListener('click', applyCustom);
  $('.js-from').addEventListener('keydown', (e) => e.key === 'Enter' && applyCustom());
  $('.js-to').addEventListener('keydown', (e) => e.key === 'Enter' && applyCustom());
  function applyCustom() {
    let f = $('.js-from').value;
    let t = $('.js-to').value;
    if (!f || !t) return toast.warning('Pick both dates.');
    if (f > t) [f, t] = [t, f];
    // anchor to the viewer's local day boundaries, then store as ISO
    const from = new Date(`${f}T00:00:00`).toISOString();
    const to = new Date(`${t}T23:59:59.999`).toISOString();
    location.hash = `#/?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }

  let data = null;
  try {
    data = await reportService.getDashboard(custom ? { from: custom.from, to: custom.to } : { preset });
  } catch (err) {
    $('#kpis').innerHTML = `<div class="alert alert--danger"><div class="alert__body">${escapeHtml(err.message)}</div></div>`;
    $('#charts').innerHTML = '';
    $('#pay-section').innerHTML = '';
    return;
  }

  const k = data.kpis;
  const hasSales = k.totalSales > 0 || k.invoiceCount > 0;

  /* -------- KPI cards -------- */
  const m = (v) => money.format(v);
  const cards = [
    renderKpi({ label: 'Total Sales', value: m(k.totalSales), icon: 'dollar-sign', tone: 'brand', href: reportHref('sales'), foot: `${num(k.invoiceCount)} invoices` }),
    renderKpi({ label: 'Cash Payments', value: m(k.cashPayments), icon: 'banknote', tone: 'success', href: reportHref('cash') }),
    renderKpi({ label: 'E-Payments', value: m(k.ePayments), icon: 'smartphone', tone: 'info', href: reportHref('epayments') }),
    renderKpi({ label: 'Invoices / Sales', value: num(k.invoiceCount), icon: 'receipt', tone: 'brand', href: reportHref('sales'), foot: `avg ${m(k.avgOrderValue)}` }),
    renderKpi({ label: 'Customers Served', value: num(k.customersServed), icon: 'users', tone: 'info', href: reportHref('customers-served') }),
    renderKpi({ label: 'Products Sold', value: num(k.unitsSold) + ' units', icon: 'box', tone: 'brand', href: reportHref('products-sold') }),
    renderKpi({ label: 'Total Discount', value: m(k.totalDiscount), icon: 'percent', tone: 'warning', href: reportHref('discounts'), foot: (k.couponDiscount || k.autoDiscount) ? `coupon ${m(k.couponDiscount || 0)} · auto ${m(k.autoDiscount || 0)}` : '' }),
    renderKpi({ label: 'VAT Collected', value: m(k.taxCollected || 0), icon: 'receipt', tone: 'info', href: reportHref('tax') }),
    renderKpi({ label: 'Purchases / Stock In', value: m(k.purchaseTotal), icon: 'truck', tone: 'info', href: reportHref('purchases') }),
    renderKpi({ label: 'Current Stock Value', value: m(k.stockCost), icon: 'warehouse', tone: 'brand', href: reportHref('inventory-valuation'), foot: `retail ${m(k.stockRetail)}` }),
    can('reports.financial') && renderKpi({ label: 'Gross Profit', value: m(k.grossProfit), icon: 'trending-up', tone: k.grossProfit >= 0 ? 'success' : 'danger', href: reportHref('profit'), foot: k.totalSales ? `margin ${((k.grossProfit / k.totalSales) * 100).toFixed(1)}%` : '' }),
    renderKpi({ label: 'Returns / Refunds', value: m(k.returnsTotal), icon: 'undo', tone: 'danger', href: reportHref('returns'), foot: `${num(k.returnsCount)} returns · ${num(k.exchangesCount)} exchanges` }),
    renderKpi({ label: 'Exchanges', value: num(k.exchangesCount), icon: 'refresh-cw', tone: 'info', href: reportHref('returns'), foot: k.exchangeAddon ? `+${m(k.exchangeAddon)} collected` : `${num(k.exchangedUnits)} items out` }),
    renderKpi({ label: 'Expenses', value: m(k.expensesTotal), icon: 'wallet', tone: 'warning', href: reportHref('expenses') }),
    renderKpi({ label: 'Outstanding / Due', value: m(k.receivable), icon: 'clock', tone: k.receivable > 0 ? 'danger' : 'success', href: reportHref('receivables') }),
  ].filter(Boolean);

  const infoCards = [
    renderKpi({ label: 'Total Products', value: num(k.totalProducts), icon: 'box', tone: 'info', href: '#/products' }),
    renderKpi({ label: 'Low Stock', value: num(k.lowStockProducts), icon: 'alert-triangle', tone: 'warning', href: '#/inventory?status=low_stock' }),
    renderKpi({ label: 'Out of Stock', value: num(k.outOfStockProducts), icon: 'alert-circle', tone: 'danger', href: '#/inventory?status=out_of_stock' }),
    renderKpi({ label: 'Cash in Register', value: m(k.cashInRegister), icon: 'drawer', tone: 'success', href: '#/cash-register' }),
  ];

  $('#kpis').innerHTML = `<div class="kpi-grid">${cards.join('')}</div>
    <div class="section-title" style="margin:var(--sp-5) 0 var(--sp-3)">Operations</div>
    <div class="kpi-grid">${infoCards.join('')}</div>`;

  /* -------- payment analytics -------- */
  renderPayments(data, reportHref);

  /* -------- charts + ranks -------- */
  if (!hasSales) {
    $('#charts').innerHTML = `<div class="card col-8"><div class="empty-state"><div class="empty-state__icon">${icon('chart', { size: 26 })}</div><h3>No sales found for this period</h3><p>Try a wider date range, or complete a sale in the cashier terminal.</p></div></div>`;
  } else {
    renderCharts(data, reportHref);
  }

  function exportCurrent() {
    if (!data) return;
    exportJson(`dashboard-${new Date().toISOString().slice(0, 10)}`, { range: data.range, kpis: data.kpis });
    toast.success('Dashboard data exported (JSON)');
  }

  /* live: a sale rung up in the cashier terminal (this tab or another) refreshes
     the dashboard within a couple of seconds - no manual reload */
  dashboardPage._off?.();
  let liveTimer = null;
  const onData = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      // only when THIS dashboard is the live, visible page and nothing is open
      const live = document.getElementById('kpis');
      if (!live || !live.isConnected || !mount.contains(live)) { dashboardPage._off?.(); dashboardPage._off = null; return; }
      if (document.querySelector('.overlay') || document.visibilityState === 'hidden') return;
      dashboardPage(ctx, mount);
    }, 1500);
  };
  const offs = ['db:changed', 'db:external-change'].map((e) => bus.on(e, onData));
  dashboardPage._off = () => offs.forEach((o) => o());
}

/* ------------------------------------------------------------ payments */
function renderPayments(data, reportHref) {
  const host = document.getElementById('pay-section');
  const k = data.kpis;
  const groups = data.paymentGroups || [];
  const total = k.cashPayments + k.ePayments;
  if (total <= 0) {
    host.innerHTML = `<div class="card__header"><h3>Payment methods</h3></div><div class="empty-state" style="padding:var(--sp-6)"><p>No payments recorded for this period.</p></div>`;
    return;
  }
  const pct = (v) => (total ? ((v / total) * 100).toFixed(0) : 0);
  const colors = ['var(--chart-2)', 'var(--chart-1)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];

  host.innerHTML = `
    <div class="card__header"><h3>Payment analytics</h3><span class="muted text-sm">${money.format(total)} received · ${pct(k.cashPayments)}% cash</span></div>
    <div class="card__body">
      <div class="pay-analytics">
        <a class="pay-tile" href="${reportHref('cash')}">
          <span class="pay-tile__label"><i style="background:var(--chart-2)"></i>Cash</span>
          <span class="pay-tile__value">${money.format(k.cashPayments)}</span>
          <span class="pay-tile__count">${pct(k.cashPayments)}% of total</span>
        </a>
        <a class="pay-tile" href="${reportHref('epayments')}">
          <span class="pay-tile__label"><i style="background:var(--chart-1)"></i>All E-Payments</span>
          <span class="pay-tile__value">${money.format(k.ePayments)}</span>
          <span class="pay-tile__count">${pct(k.ePayments)}% of total</span>
        </a>
        ${(k.ePaymentGroups || []).map((g, i) => `
        <a class="pay-tile" href="${reportHref('epayments', 'method=' + encodeURIComponent(g.key))}">
          <span class="pay-tile__label"><i style="background:${colors[(i + 2) % colors.length]}"></i>${escapeHtml(g.label)}</span>
          <span class="pay-tile__value">${money.format(g.inflow)}</span>
          <span class="pay-tile__count">${g.count} txns · ${pct(g.inflow)}%</span>
        </a>`).join('')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------ charts */
function renderCharts(data, reportHref) {
  const g = document.getElementById('charts');
  g.innerHTML = `
    <div class="card col-8">
      <div class="chart-card__head"><div><h3>Revenue &amp; Profit</h3><p>${data.granularity === 'month' ? 'Monthly' : 'Daily'} — click a point to see that day's sales</p></div></div>
      <div class="chart-holder" id="c-revenue"></div>
      ${chartLegend([{ label: 'Revenue', color: 'var(--chart-1)' }, { label: 'Profit', color: 'var(--chart-2)' }])}
    </div>
    <div class="card col-4">
      <div class="chart-card__head"><div><h3>Sales by Category</h3><p>click to open category performance</p></div></div>
      <div class="chart-holder" id="c-category"></div>
    </div>
    <div class="card col-4">
      <div class="chart-card__head"><div><h3>Top Products</h3></div><a class="btn btn--ghost btn--sm" href="${reportHref('products-sold')}">All</a></div>
      <div class="card__body" id="r-products"></div>
    </div>
    <div class="card col-4">
      <div class="chart-card__head"><div><h3>Top Customers</h3></div><a class="btn btn--ghost btn--sm" href="${reportHref('customers-served')}">All</a></div>
      <div class="card__body" id="r-customers"></div>
    </div>
    <div class="card col-4">
      <div class="chart-card__head"><div><h3>Top Cashiers</h3></div><a class="btn btn--ghost btn--sm" href="${reportHref('cashier')}">All</a></div>
      <div class="card__body" id="r-cashiers"></div>
    </div>`;

  charts.push(createChart(g.querySelector('#c-revenue'), {
    type: 'area',
    data: {
      labels: data.salesSeries.map((s) => s.label),
      series: [
        { name: 'Revenue', values: data.salesSeries.map((s) => s.revenue), color: 'var(--chart-1)' },
        ...(can('reports.financial') ? [{ name: 'Profit', values: data.salesSeries.map((s) => s.profit), color: 'var(--chart-2)' }] : []),
      ],
    },
    options: {
      valueFormat: 'money',
      height: 260,
      onClick: (i) => {
        const day = data.salesSeries[i]?.date;
        if (!day) return;
        const from = new Date(day + 'T00:00:00').toISOString();
        const to = new Date(day + (day.length === 7 ? '-28' : '') + 'T23:59:59').toISOString();
        location.hash = `#/reports/sales?from=${from}&to=${to}`;
      },
    },
  }));

  charts.push(createChart(g.querySelector('#c-category'), {
    type: 'donut',
    data: { items: data.salesByCategory.slice(0, 6).map((d) => ({ label: d.label, value: d.value })) },
    options: {
      valueFormat: 'money',
      height: 240,
      onClick: () => (location.hash = reportHref('category-performance')),
    },
  }));

  rankList(g.querySelector('#r-products'), data.topProducts.slice(0, 6), (p) => ({
    title: p.name,
    sub: `${p.qty} sold · profit ${money.format(p.profit)}`,
    val: money.format(p.revenue),
    href: `#/products/${p.id}`,
  }));
  rankList(g.querySelector('#r-customers'), data.topCustomers.slice(0, 6), (c) => ({
    title: c.label,
    sub: `${c.orders} orders`,
    val: money.format(c.value),
    href: reportHref('customers-served', 'customerId=' + c.id),
  }));
  rankList(g.querySelector('#r-cashiers'), data.topCashiers.slice(0, 6), (c) => ({
    title: c.label,
    sub: `${c.orders} sales`,
    val: money.format(c.value),
    href: `#/reports/cashier?${reportHref('cashier').split('?')[1]}`,
  }));
}

function rankList(host, rows, mapFn) {
  if (!rows.length) {
    host.innerHTML = '<p class="muted text-sm" style="padding:var(--sp-3)">No data.</p>';
    return;
  }
  host.innerHTML = `<div class="rank-list">${rows
    .map((r, i) => {
      const x = mapFn(r);
      return `<a class="rank-row" href="${escapeHtml(x.href)}">
        <span class="rank-row__n">${i + 1}</span>
        <span class="rank-row__main"><strong>${escapeHtml(x.title)}</strong><span>${escapeHtml(x.sub)}</span></span>
        <span class="rank-row__val">${x.val}</span>
      </a>`;
    })
    .join('')}</div>`;
}
