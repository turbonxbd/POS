/**
 * reports.js - the detailed report + drill-down page.
 * Reached from dashboard cards (#/reports/<type>?preset=..&<filters>) or the
 * Reports nav. Every row drills into its entity (sale / product / customer).
 */
import { pageShell, statStrip } from '../shared/page-kit.js';
import { blockLoader } from '../../components/skeleton.js';
import { icon } from '../../components/icons.js';
import { escapeHtml, on } from '../../utils/dom.js';
import { toast } from '../../components/toast.js';
import { debounce } from '../../utils/debounce.js';
import { printHtml } from '../../utils/print.js';
import { exportCsv, exportJson } from '../../utils/csv.js';
import { fmtDateTime, fmtDate } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import money from '../../utils/money.js';
import reportService, { REPORT_TYPES, reportMeta } from '../../services/report-service.js';
import { openSaleDrawer } from '../shared/sale-drawer.js';
import { can } from '../../core/rbac.js';
import store from '../../core/store.js';

const MONEY_RE = /total|amount|value|revenue|cost|profit|tax|discount|paid|due|base|inflow|outflow|refund|net|spent|outstanding|gross|cash|epayment|price|saletotal|change/i;
const NUM_RE = /qty|orders|units|count|items|transactions|loyalty|balance|margin|rate/i;
const DATE_KEYS = new Set(['date', 'lastPurchase', 'lastpurchase', 'lastsold']);
const HIDDEN_KEYS = new Set(['id', 'saleId', 'customerId', 'productId', 'purchaseId', 'methodKey', 'direction']);

const PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This Week'], ['last_week', 'Last Week'],
  ['this_month', 'This Month'], ['last_month', 'Last Month'], ['this_year', 'This Year'],
];

export default async function reportsPage(ctx, mount) {
  const available = REPORT_TYPES.filter((r) => !r.perm || can(r.perm));
  let type = ctx.params.type || ctx.query.type || 'sales';
  if (!available.some((r) => r.type === type)) type = 'sales';

  const q = { ...ctx.query };
  const custom = q.from && q.to ? { from: q.from, to: q.to } : null;
  let preset = custom ? 'custom' : q.preset || 'today';
  const filters = { ...q };

  const meta = reportMeta(type);
  const branch = (store.get('branches') || []).find((b) => b.id === store.get('activeBranchId'));

  const shell = pageShell(mount, {
    title: meta?.label || 'Report',
    subtitle: `${store.get('business')?.name || 'TX Demo'}${branch ? ' · ' + branch.name : ''}`,
    breadcrumb: [{ label: 'Dashboard', href: '#/' }, { label: meta?.label || 'Report' }],
    actions: [
      { label: 'Print', icon: 'print', variant: 'outline', onClick: doPrint },
      { label: 'CSV', icon: 'download', variant: 'outline', onClick: () => doExport('csv') },
      { label: 'JSON', icon: 'download', variant: 'outline', onClick: () => doExport('json') },
    ],
  });

  // filter option data (lazy — only what this report needs)
  const filterData = await loadFilterData(meta);

  shell.body.innerHTML = `
    <div class="filter-bar" style="gap:var(--sp-2)">
      <select class="select js-type" style="width:auto" aria-label="Report">
        ${available.map((r) => `<option value="${r.type}" ${r.type === type ? 'selected' : ''}>${r.label}</option>`).join('')}
      </select>
      ${meta?.dated !== false ? `
      <div class="segmented" id="dt-seg" role="group" aria-label="Period">
        ${PRESETS.map(([v, l]) => `<button data-p="${v}" aria-pressed="${v === preset}">${l}</button>`).join('')}
        <button data-p="custom" aria-pressed="${preset === 'custom'}">Custom</button>
      </div>
      <div class="row js-custom" ${preset === 'custom' ? '' : 'hidden'} style="gap:6px">
        <input type="date" class="input js-from" value="${custom?.from?.slice(0, 10) || ''}" style="width:auto;height:34px">
        <span class="muted">–</span>
        <input type="date" class="input js-to" value="${custom?.to?.slice(0, 10) || ''}" style="width:auto;height:34px">
        <button class="btn btn--sm js-apply">Go</button>
      </div>` : ''}
      ${renderFilters(meta, filters, filterData)}
    </div>
    <div id="report-out">${blockLoader('Building report…')}</div>`;

  const $ = (s) => shell.body.querySelector(s);
  let current = null;
  let customRange = custom; // { from, to } | null - persists across filter changes

  $('.js-type').addEventListener('change', () => {
    location.hash = `#/reports/${$('.js-type').value}?${rangeQS()}`;
  });
  $('#dt-seg')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-p]');
    if (!b) return;
    if (b.dataset.p === 'custom') return ($('.js-custom').hidden = false);
    preset = b.dataset.p;
    customRange = null;
    $('#dt-seg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load();
  });
  $('.js-apply')?.addEventListener('click', applyCustom);
  $('.js-from')?.addEventListener('keydown', (e) => e.key === 'Enter' && applyCustom());
  $('.js-to')?.addEventListener('keydown', (e) => e.key === 'Enter' && applyCustom());
  function applyCustom() {
    let f = $('.js-from').value;
    let t = $('.js-to').value;
    if (!f || !t) return toast.warning('Pick both dates.');
    if (f > t) [f, t] = [t, f];
    preset = 'custom';
    customRange = { from: new Date(`${f}T00:00:00`).toISOString(), to: new Date(`${t}T23:59:59.999`).toISOString() };
    $('#dt-seg')?.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.p === 'custom')));
    load();
  }
  const debSearch = debounce(() => { filters.search = $('.js-f-search')?.value.trim() || ''; load(); }, 250);
  $('.js-f-search')?.addEventListener('input', debSearch);
  on(shell.body, 'change', '.js-filter', (e, el) => {
    filters[el.dataset.k] = el.value;
    load();
  });

  function rangeQS() {
    return customRange ? `from=${encodeURIComponent(customRange.from)}&to=${encodeURIComponent(customRange.to)}` : `preset=${preset}`;
  }

  async function load() {
    $('#report-out').innerHTML = blockLoader('Building report…');
    const params = {};
    if (meta?.dated !== false) {
      if (customRange) Object.assign(params, { from: customRange.from, to: customRange.to });
      else params.preset = preset;
    }
    for (const key of meta?.filters || []) {
      const v = filters[key];
      if (v && v !== 'all') params[key] = v;
    }
    if (filters.customerId) params.customerId = filters.customerId;
    try {
      current = await reportService.getReport(type, params);
      renderReport();
    } catch (err) {
      $('#report-out').innerHTML = `<div class="card"><div class="alert alert--danger"><div class="alert__body">${escapeHtml(err.data?.message || err.message)}</div></div></div>`;
    }
  }

  function renderReport() {
    const rows = current.rows || [];
    if (!rows.length) {
      $('#report-out').innerHTML = `<div class="card"><div class="empty-state">
        <div class="empty-state__icon">${icon(meta?.icon || 'chart', { size: 24 })}</div>
        <h3>No ${meta?.label?.toLowerCase() || 'data'} for this period</h3>
        <p>Try a wider date range or clear the filters.</p></div></div>`;
      return;
    }
    const cols = Object.keys(rows[0]).filter((c) => !HIDDEN_KEYS.has(c));
    const totals = current.totals || {};
    const strip = Object.entries(totals)
      .filter(([k]) => k !== 'count' && totals[k] != null)
      .slice(0, 6)
      .map(([k, v]) => ({ label: titleCase(k), value: MONEY_RE.test(k) ? money.format(v) : String(v) }));

    const drillable = meta?.entity && meta.entity !== 'none';

    $('#report-out').innerHTML = `
      <div class="card">
        <div class="card__header"><h3>${escapeHtml(meta?.label || type)}</h3>
          <span class="muted text-sm">${rows.length} row${rows.length === 1 ? '' : 's'}${drillable ? ' · click a row for details' : ''}</span></div>
        <div class="card__body">
          ${strip.length ? statStrip(strip) : ''}
          ${current.breakdown ? renderBreakdown(current.breakdown) : ''}
          <div class="table-wrap" style="border:0">
            <table class="table table--compact ${drillable ? '' : ''}" id="report-table">
              <thead><tr>${cols.map((c) => `<th class="${cellNum(c) ? 'num' : ''}">${escapeHtml(titleCase(c))}</th>`).join('')}</tr></thead>
              <tbody>${rows
                .map((r, i) => `<tr class="${drillable ? 'js-drill' : ''}" data-i="${i}" ${drillable ? 'style="cursor:pointer"' : ''}>
                  ${cols.map((c) => `<td class="${cellNum(c) ? 'num' : ''}">${fmtCell(c, r[c])}</td>`).join('')}
                </tr>`)
                .join('')}</tbody>
              ${Object.keys(totals).length ? `<tfoot><tr>${cols.map((c, i) => {
                if (i === 0) return '<th>Total</th>';
                const t = totals[c];
                return `<th class="num">${t == null ? '' : MONEY_RE.test(c) ? money.format(t) : cellNum(c) ? t : ''}</th>`;
              }).join('')}</tr></tfoot>` : ''}
            </table>
          </div>
        </div>
      </div>`;

    if (drillable) {
      on($('#report-table'), 'click', '.js-drill', (e, tr) => {
        const row = rows[Number(tr.dataset.i)];
        drillRow(row);
      });
    }
  }

  function drillRow(row) {
    const entity = meta.entity;
    if (entity === 'sale' && row.saleId) return openSaleDrawer(row.saleId);
    if (entity === 'sale' && row.invoiceNo && row.invoiceNo !== '—') {
      // receivables etc: look up by sale id if present else invoice route
      if (row.saleId) return openSaleDrawer(row.saleId);
    }
    if (entity === 'product' && row.productId) return (location.hash = `#/products/${row.productId}`);
    if (entity === 'customer' && row.customerId) return (location.hash = `#/customers?open=${row.customerId}`);
    if (entity === 'customer' && !row.customerId) return toast.info('Walk-in customer — no account to open.');
    toast.info('No linked record for this row.');
  }

  function doPrint() {
    if (!current) return;
    const table = $('#report-table')?.outerHTML || '';
    printHtml(`<div class="receipt-preview size-a4" style="padding:12mm">
      <h2 style="margin-bottom:2mm">${escapeHtml(meta?.label || type)}</h2>
      <p style="color:#666;font-size:11px;margin-bottom:6mm">${escapeHtml(store.get('business')?.name || 'TX Demo')} · ${escapeHtml(rangeLabel())} · generated ${new Date().toLocaleString()}</p>
      ${table}
    </div>`);
  }

  function doExport(fmt) {
    if (!current?.rows?.length) return toast.warning('Nothing to export.');
    const name = `${type}-${new Date().toISOString().slice(0, 10)}`;
    if (fmt === 'json') exportJson(name, current);
    else exportCsv(name, current.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !HIDDEN_KEYS.has(k)).map(([k, v]) => [k, MONEY_RE.test(k) ? money.toPlain(v) : v]))));
    toast.success(`Exported (${fmt.toUpperCase()})`);
  }

  function rangeLabel() {
    if (customRange) return `${fmtDate(customRange.from)} – ${fmtDate(customRange.to)}`;
    return PRESETS.find(([v]) => v === preset)?.[1] || preset;
  }

  await load();
}

/* ------------------------------------------------------------ helpers */
function cellNum(c) {
  return MONEY_RE.test(c) || NUM_RE.test(c);
}
function fmtCell(key, v) {
  if (v == null || v === '') return '—';
  if (MONEY_RE.test(key)) return `<span class="pos-amount">${money.format(v)}</span>`;
  if (DATE_KEYS.has(key.toLowerCase())) return escapeHtml(fmtCellDate(v));
  if (key === 'status') return `<span class="badge badge--neutral">${escapeHtml(titleCase(v))}</span>`;
  if (typeof v === 'number') return String(v);
  return escapeHtml(String(v));
}
function fmtCellDate(v) {
  const s = String(v);
  return /\d{4}-\d\d-\d\d/.test(s) && s.length <= 10 ? s : fmtDateTime(v);
}
function renderBreakdown(groups) {
  return `<div class="pay-analytics" style="margin-bottom:var(--sp-4)">
    ${groups.map((g) => `<div class="pay-tile" style="cursor:default">
      <span class="pay-tile__label">${escapeHtml(g.label)}</span>
      <span class="pay-tile__value">${money.format(g.inflow)}</span>
      <span class="pay-tile__count">${g.count} txns</span>
    </div>`).join('')}
  </div>`;
}
function renderFilters(meta, filters, data) {
  if (!meta?.filters?.length) return '<div class="grow"></div>';
  const parts = ['<div class="grow"></div>'];
  for (const f of meta.filters) {
    if (f === 'search') {
      parts.unshift(`<div class="input-search" style="max-width:220px"><span class="input-search__icon">${icon('search', { size: 15 })}</span>
        <input class="input js-f-search" placeholder="Search…" value="${escapeHtml(filters.search || '')}" style="height:34px"></div>`);
    } else if (f === 'sort') {
      parts.push(sel('sort', filters.sort, [['', 'Most revenue'], ['qtySold', 'Most sold'], ['least', 'Least sold'], ['profit', 'Most profit']]));
    } else if (f === 'payment') {
      parts.push(sel('payment', filters.payment, [['all', 'All payments'], ['cash', 'Cash'], ['card', 'Card'], ['mobile', 'Mobile'], ['bank_transfer', 'Bank']]));
    } else if (f === 'method') {
      parts.push(sel('method', filters.method, [['all', 'All e-payments'], ['card', 'Card'], ['bkash', 'bKash'], ['nagad', 'Nagad'], ['rocket', 'Rocket'], ['bank_transfer', 'Bank'], ['mobile', 'Other mobile']]));
    } else if (f === 'status') {
      parts.push(sel('status', filters.status, [['all', 'All statuses'], ['completed', 'Completed'], ['due', 'Due'], ['refunded', 'Refunded'], ['partially_refunded', 'Partially refunded']]));
    } else if (f === 'cashier') {
      parts.push(sel('cashier', filters.cashier, [['', 'All cashiers'], ...(data.cashiers || []).map((c) => [c, c])]));
    } else if (f === 'supplier') {
      parts.push(sel('supplier', filters.supplier, [['', 'All suppliers'], ...(data.suppliers || []).map((s) => [s, s])]));
    } else if (f === 'category') {
      parts.push(sel('category', filters.category, [['all', 'All categories'], ...(data.expenseCategories || []).map((c) => [c, c])]));
    } else if (f === 'days') {
      parts.push(sel('days', filters.days || '90', [['30', 'Idle 30+ days'], ['60', 'Idle 60+ days'], ['90', 'Idle 90+ days'], ['180', 'Idle 180+ days']]));
    } else if (f === 'stockStatus') {
      parts.push(sel('stockStatus', filters.stockStatus, [['all', 'All'], ['dead', 'Dead'], ['slow', 'Slow-moving'], ['ok', 'Still selling']]));
    }
  }
  return parts.join('');
}
function sel(key, val, opts) {
  return `<select class="select js-filter" data-k="${key}" style="width:auto;height:34px">
    ${opts.map(([v, l]) => `<option value="${escapeHtml(v)}" ${String(val || '') === String(v) ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}
  </select>`;
}
async function loadFilterData(meta) {
  const data = {};
  const need = new Set(meta?.filters || []);
  try {
    if (need.has('cashier')) {
      const emp = (await import('../../services/employee-service.js')).default;
      const res = await emp.getEmployees({ pageSize: 'all' });
      data.cashiers = [...new Set((res.data || []).map((e) => e.name))];
    }
    if (need.has('supplier')) {
      const sup = (await import('../../services/supplier-service.js')).default;
      const res = await sup.getSuppliers({ pageSize: 'all' });
      data.suppliers = (res.data || []).map((s) => s.name);
    }
    if (need.has('category')) {
      const exp = (await import('../../services/expense-service.js')).default;
      data.expenseCategories = await exp.getCategories();
    }
  } catch {
    /* filters degrade gracefully */
  }
  return data;
}
