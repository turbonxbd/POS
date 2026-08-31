/**
 * audit-logs.js - immutable activity log (read-only).
 */
import { pageShell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import { exportJson } from '../../utils/csv.js';
import auditService, { AUDIT_ENTITIES, AUDIT_ACTIONS } from '../../services/audit-service.js';

const ACTION_TONE = { create: 'success', update: 'info', archive: 'warning', delete: 'danger', sale: 'success', refund: 'danger', login: 'neutral', logout: 'neutral', settings: 'info', adjust: 'warning', receive: 'success', transfer: 'info', restore: 'success', login_failed: 'danger' };

export default async function auditLogsPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Audit Logs',
    subtitle: 'Every create, update, archive, sale, refund, stock change and settings change. Append-only.',
    actions: [{ label: 'Export JSON', icon: 'download', variant: 'outline', onClick: doExport }],
  });

  createDataTable(shell.body, {
    columns: [
      { key: 'at', label: 'Time', sortable: true, render: (r) => fmtDateTime(r.at) },
      { key: 'actorName', label: 'User', render: (r) => escapeHtml(r.actorName || 'system') },
      { key: 'action', label: 'Action', render: (r) => `<span class="badge badge--${ACTION_TONE[r.action] || 'neutral'}">${titleCase(r.action)}</span>` },
      { key: 'entity', label: 'Entity', render: (r) => `${escapeHtml(titleCase(r.entity))}${r.entityId ? `<br><span class="muted text-xs mono">${escapeHtml(String(r.entityId).slice(0, 12))}</span>` : ''}` },
      { key: 'meta', label: 'Details', render: (r) => escapeHtml(summarise(r)) },
    ],
    filters: [
      { key: 'entity', label: 'Entity', options: AUDIT_ENTITIES.map((e) => ({ value: e, label: titleCase(e) })) },
      { key: 'action', label: 'Action', options: AUDIT_ACTIONS.map((a) => ({ value: a, label: titleCase(a) })) },
    ],
    searchPlaceholder: 'Search user, entity or action…',
    stacked: true,
    emptyState: { icon: 'history', title: 'No activity logged yet' },
    fetcher: (params) => auditService.getLogs(params),
    onRowClick: (row) => openModal({
      title: `${titleCase(row.action)} · ${titleCase(row.entity)}`,
      subtitle: `${row.actorName} · ${fmtDateTime(row.at)}`,
      size: 'md',
      body: `<dl class="detail-list">
        <div class="detail-list__row"><dt>Entity ID</dt><dd class="mono">${escapeHtml(row.entityId || '—')}</dd></div>
        <div class="detail-list__row"><dt>Device</dt><dd class="text-xs">${escapeHtml(row.meta?.device || '—')}</dd></div>
        <div class="detail-list__row"><dt>Branch</dt><dd>${escapeHtml(row.meta?.branchId || '—')}</dd></div>
      </dl>
      ${row.before ? `<h4 class="section-title" style="margin-top:var(--sp-3)">Before</h4><pre style="background:var(--bg-inset);padding:var(--sp-3);border-radius:var(--radius-sm);overflow:auto;font-size:var(--fs-xs)">${escapeHtml(JSON.stringify(row.before, null, 2))}</pre>` : ''}
      ${row.after ? `<h4 class="section-title" style="margin-top:var(--sp-3)">After</h4><pre style="background:var(--bg-inset);padding:var(--sp-3);border-radius:var(--radius-sm);overflow:auto;font-size:var(--fs-xs)">${escapeHtml(JSON.stringify(row.after, null, 2))}</pre>` : ''}`,
      footer: '<button class="btn btn--primary js-modal-close">Close</button>',
    }),
    rowActions: () => [],
  });

  async function doExport() {
    const res = await auditService.getLogs({ pageSize: 'all' });
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
