/**
 * audit-logs.js - immutable activity log (read-only), filterable by entity,
 * action, user, branch and date range.
 */
import { pageShell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import { exportJson } from '../../utils/csv.js';
import { can } from '../../core/rbac.js';
import store from '../../core/store.js';
import auditService, { AUDIT_ENTITIES, AUDIT_ACTIONS } from '../../services/audit-service.js';
import { employeeService } from '../../services/employee-service.js';

const ACTION_TONE = { create: 'success', update: 'info', archive: 'warning', delete: 'danger', sale: 'success', refund: 'danger', login: 'neutral', logout: 'neutral', settings: 'info', adjust: 'warning', receive: 'success', transfer: 'info', restore: 'success', login_failed: 'danger' };

export default async function auditLogsPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Audit Logs',
    subtitle: 'Every create, update, archive, sale, refund, stock change and settings change. Append-only.',
    actions: [{ label: 'Export JSON', icon: 'download', variant: 'outline', onClick: doExport }],
  });

  const branches = (store.get('branches') || []).filter((b) => !b.archivedAt);
  let staff = [];
  if (can('employees.view')) {
    staff = await employeeService.getEmployees({ pageSize: 'all', includeArchived: 'true' })
      .then((r) => r.data || r || []).catch(() => []);
  }

  // date range lives outside the data-table's own filter set
  const range = { from: ctx.query.from || '', to: ctx.query.to || '' };
  const dateBar = document.createElement('div');
  dateBar.className = 'cluster';
  dateBar.style.gap = 'var(--sp-2)';
  dateBar.innerHTML = `
    <label class="text-xs muted" style="display:flex;align-items:center;gap:var(--sp-1)">From
      <input type="date" class="input js-from" value="${escapeHtml(range.from)}" style="height:34px"></label>
    <label class="text-xs muted" style="display:flex;align-items:center;gap:var(--sp-1)">To
      <input type="date" class="input js-to" value="${escapeHtml(range.to)}" style="height:34px"></label>
    <button class="btn btn--ghost btn--sm js-clear" hidden>Clear dates</button>`;

  const filters = [
    { key: 'entity', label: 'Entity', options: AUDIT_ENTITIES.map((e) => ({ value: e, label: titleCase(e) })) },
    { key: 'action', label: 'Action', options: AUDIT_ACTIONS.map((a) => ({ value: a, label: titleCase(a) })) },
  ];
  if (staff.length) {
    filters.push({ key: 'actorId', label: 'User', options: staff.map((u) => ({ value: u.id, label: u.name })) });
  }
  if (branches.length > 1) {
    filters.push({ key: 'branchId', label: 'Branch', options: branches.map((b) => ({ value: b.id, label: b.name })) });
  }

  const table = createDataTable(shell.body, {
    columns: [
      { key: 'at', label: 'Time', sortable: true, render: (r) => fmtDateTime(r.at) },
      { key: 'actorName', label: 'User', render: (r) => escapeHtml(r.actorName || 'system') },
      { key: 'action', label: 'Action', render: (r) => `<span class="badge badge--${ACTION_TONE[r.action] || 'neutral'}">${titleCase(r.action)}</span>` },
      { key: 'entity', label: 'Entity', render: (r) => `${escapeHtml(titleCase(r.entity))}${r.entityId ? `<br><span class="muted text-xs mono">${escapeHtml(String(r.entityId).slice(0, 12))}</span>` : ''}` },
      { key: 'branch', label: 'Branch', render: (r) => escapeHtml(branchName(r)) },
      { key: 'meta', label: 'Details', render: (r) => escapeHtml(summarise(r)) },
    ],
    filters,
    searchPlaceholder: 'Search user, entity or action…',
    stacked: true,
    toolbarExtra: dateBar,
    emptyState: { icon: 'history', title: 'No activity for these filters' },
    fetcher: (params) => auditService.getLogs({ ...params, ...cleanRange() }),
    onRowClick: (row) => openModal({
      title: `${titleCase(row.action)} · ${titleCase(row.entity)}`,
      subtitle: `${row.actorName} · ${fmtDateTime(row.at)}`,
      size: 'md',
      body: `<dl class="detail-list">
        <div class="detail-list__row"><dt>Entity ID</dt><dd class="mono">${escapeHtml(row.entityId || '—')}</dd></div>
        <div class="detail-list__row"><dt>Device</dt><dd class="text-xs">${escapeHtml(row.meta?.device || '—')}</dd></div>
        <div class="detail-list__row"><dt>Branch</dt><dd>${escapeHtml(branchName(row))}</dd></div>
      </dl>
      ${row.before ? `<h4 class="section-title" style="margin-top:var(--sp-3)">Before</h4><pre style="background:var(--bg-inset);padding:var(--sp-3);border-radius:var(--radius-sm);overflow:auto;font-size:var(--fs-xs)">${escapeHtml(JSON.stringify(row.before, null, 2))}</pre>` : ''}
      ${row.after ? `<h4 class="section-title" style="margin-top:var(--sp-3)">After</h4><pre style="background:var(--bg-inset);padding:var(--sp-3);border-radius:var(--radius-sm);overflow:auto;font-size:var(--fs-xs)">${escapeHtml(JSON.stringify(row.after, null, 2))}</pre>` : ''}`,
      footer: '<button class="btn btn--primary js-modal-close">Close</button>',
    }),
    rowActions: () => [],
  });

  const clearBtn = dateBar.querySelector('.js-clear');
  const syncClear = () => { clearBtn.hidden = !range.from && !range.to; };
  dateBar.querySelector('.js-from').addEventListener('change', (e) => { range.from = e.target.value; syncClear(); table.reload(); });
  dateBar.querySelector('.js-to').addEventListener('change', (e) => { range.to = e.target.value; syncClear(); table.reload(); });
  clearBtn.addEventListener('click', () => {
    range.from = range.to = '';
    dateBar.querySelector('.js-from').value = '';
    dateBar.querySelector('.js-to').value = '';
    syncClear();
    table.reload();
  });
  syncClear();

  function cleanRange() {
    const q = {};
    if (range.from) q.from = range.from;
    if (range.to) q.to = range.to;
    return q;
  }

  function branchName(r) {
    const id = r.meta?.branchId || r.branchId;
    if (!id) return '—';
    return branches.find((b) => b.id === id)?.name || String(id).slice(0, 8);
  }

  async function doExport() {
    const res = await auditService.getLogs({ pageSize: 'all', ...table.getState().filters, ...cleanRange() });
    exportJson(`audit-log-${new Date().toISOString().slice(0, 10)}`, res.data || []);
  }
}

function summarise(r) {
  const m = r.meta || {};
  if (m.invoiceNo) return `Invoice ${m.invoiceNo}`;
  if (m.reference) return m.reference;
  if (m.field) return `Field: ${m.field}`;
  if (m.bulk) return `Bulk ${m.bulk} (${m.count})`;
  if (m.action) return titleCase(m.action);
  if (r.after?.name) return r.after.name;
  return '—';
}
