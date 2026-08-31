/**
 * cash-register.js - register sessions overview and reconciliation.
 */
import { pageShell, statusBadge, statStrip } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { blockLoader } from '../../components/skeleton.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import money from '../../utils/money.js';
import cashRegisterService from '../../services/cash-register-service.js';

export default async function cashRegisterPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Cash Register',
    subtitle: 'Register sessions, expected vs counted cash, and shift differences.',
  });

  const strip = document.createElement('div');
  const tableMount = document.createElement('div');
  shell.body.append(strip, tableMount);

  createDataTable(tableMount, {
    columns: [
      { key: 'reference', label: 'Session', sortable: true, render: (r) => `<strong class="mono">${escapeHtml(r.reference)}</strong>` },
      { key: 'cashierName', label: 'Cashier', render: (r) => escapeHtml(r.cashierName) },
      { key: 'openedAt', label: 'Opened', sortable: true, render: (r) => fmtDateTime(r.openedAt) },
      { key: 'closedAt', label: 'Closed', render: (r) => r.closedAt ? fmtDateTime(r.closedAt) : '—' },
      { key: 'salesCount', label: 'Sales', align: 'right' },
      { key: 'expectedCash', label: 'Expected', align: 'right', render: (r) => money.format(r.expectedCash) },
      { key: 'difference', label: 'Difference', align: 'right', render: (r) => r.difference == null ? '—' : `<span class="pos-amount ${r.difference === 0 ? '' : r.difference > 0 ? 'text-success' : 'text-danger'}">${money.format(r.difference)}</span>` },
      { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
    ],
    filters: [{ key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }] }],
    searchPlaceholder: 'Search session or cashier…',
    stacked: true,
    emptyState: { icon: 'drawer', title: 'No register sessions yet' },
    fetcher: async (params) => {
      const res = await cashRegisterService.getSessions(params);
      const rows = res.data || [];
      strip.innerHTML = statStrip([
        { label: 'Sessions', value: res.total },
        { label: 'Currently open', value: rows.filter((r) => r.status === 'open').length },
        { label: 'Cash on hand (open)', value: money.format(rows.filter((r) => r.status === 'open').reduce((s, r) => s + r.expectedCash, 0)) },
        { label: 'Shortages/overages', value: rows.filter((r) => r.difference).length },
      ]);
      return res;
    },
    onRowClick: (row) => showSession(row.id),
    rowActions: (row) => [{ label: 'View', icon: 'eye', onClick: () => showSession(row.id) }],
  });

  async function showSession(id) {
    const m = openModal({ title: 'Register Session', size: 'md', body: blockLoader('Loading…') });
    const s = await cashRegisterService.getSessionById(id);
    m.setBody(`
      <div class="row" style="gap:var(--sp-2);margin-bottom:var(--sp-3)">${statusBadge(s.status)}<span class="muted">${escapeHtml(s.reference)} · ${escapeHtml(s.cashierName)}</span></div>
      ${statStrip([
        { label: 'Opening', value: money.format(s.openingCash) },
        { label: 'Cash sales', value: money.format(s.cashSales) },
        { label: 'Card / other', value: money.format(s.cardSales) },
        { label: 'Refunds', value: money.format(s.cashRefunds) },
        { label: 'Cash expenses', value: money.format(s.cashExpenses) },
        { label: 'Expected', value: money.format(s.expectedCash) },
      ])}
      ${s.status === 'closed' ? `<dl class="detail-list">
        <div class="detail-list__row"><dt>Counted</dt><dd>${money.format(s.closingCountedCash)}</dd></div>
        <div class="detail-list__row"><dt>Difference</dt><dd class="${s.difference === 0 ? '' : 'text-danger'}">${money.format(s.difference)}</dd></div>
        <div class="detail-list__row"><dt>Closed</dt><dd>${fmtDateTime(s.closedAt)}</dd></div>
        ${s.closingNote ? `<div class="detail-list__row"><dt>Note</dt><dd>${escapeHtml(s.closingNote)}</dd></div>` : ''}
      </dl>` : '<p class="muted text-sm">This session is still open. It is closed from the cashier terminal.</p>'}
      ${(s.movements || []).length ? `<h4 class="section-title" style="margin-top:var(--sp-4)">Cash movements</h4>
        <div class="table-wrap"><table class="table table--compact"><thead><tr><th>Time</th><th>Direction</th><th class="num">Amount</th><th>Reason</th></tr></thead>
        <tbody>${s.movements.map((mv) => `<tr><td>${fmtDateTime(mv.at)}</td><td>${mv.direction === 'in' ? 'In' : 'Out'}</td><td class="num">${money.format(mv.amount)}</td><td>${escapeHtml(mv.reason)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    `);
    m.setFooter('<button class="btn btn--primary js-modal-close">Close</button>');
  }
}
