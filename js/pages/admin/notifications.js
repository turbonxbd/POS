/**
 * notifications.js - full notification centre.
 */
import { pageShell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime, fmtRelative } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import notificationService from '../../services/notification-service.js';

const LEVEL_ICON = { danger: 'alert-circle', warning: 'alert-triangle', success: 'check-circle', info: 'info' };

export default async function notificationsPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Notifications',
    subtitle: 'Low stock, sales, refunds, purchases received and system alerts.',
    actions: [{ label: 'Mark all read', icon: 'check', variant: 'outline', onClick: markAll }],
  });

  const table = createDataTable(shell.body, {
    columns: [
      { key: 'level', label: '', width: '40px', render: (r) => `<span style="color:var(--${r.level}-solid)">${icon(LEVEL_ICON[r.level] || 'info', { size: 16 })}</span>` },
      { key: 'title', label: 'Notification', render: (r) => `<strong>${escapeHtml(r.title)}</strong>${r.read ? '' : ' <span class="badge badge--brand">new</span>'}<br><span class="muted text-sm">${escapeHtml(r.message)}</span>` },
      { key: 'type', label: 'Type', render: (r) => `<span class="badge badge--neutral">${titleCase(r.type)}</span>` },
      { key: 'at', label: 'When', sortable: true, render: (r) => `<span title="${fmtDateTime(r.at)}">${fmtRelative(r.at)}</span>` },
    ],
    filters: [
      { key: 'unread', label: 'Show', options: [{ value: 'true', label: 'Unread only' }] },
      { key: 'type', label: 'Type', options: ['low_stock', 'out_of_stock', 'sale', 'refund', 'purchase_received', 'register_close', 'system'].map((t) => ({ value: t, label: titleCase(t) })) },
    ],
    stacked: true,
    emptyState: { icon: 'bell', title: "You're all caught up" },
    fetcher: (params) => notificationService.getNotifications(params),
    onRowClick: async (row) => {
      if (!row.read) await notificationService.markRead(row.id);
      if (row.link) location.hash = row.link.replace(/^#/, '');
      else table.reload();
    },
    rowActions: (row) => [
      !row.read && { label: 'Mark read', icon: 'check', onClick: async () => { await notificationService.markRead(row.id); table.reload(); } },
      row.link && { label: 'Open', icon: 'external-link', onClick: () => (location.hash = row.link.replace(/^#/, '')) },
      { label: 'Delete', icon: 'trash', danger: true, onClick: async () => { await notificationService.remove(row.id); table.reload(); } },
    ].filter(Boolean),
  });

  async function markAll() {
    await notificationService.markAllRead();
    toast.success('All notifications marked read');
    table.reload();
  }
}
