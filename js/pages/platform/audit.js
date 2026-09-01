/**
 * platform/audit.js — Super Admin → Activity log.
 * Every action a platform operator has taken across all merchants: approvals,
 * rejections, suspensions, plan edits, messages, password resets, notes.
 */
import { page, loading, errorBox, tableCard, badge, fmtDateTime, liveRefresh } from './kit.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce } from '../../utils/debounce.js';
import { renderPagination } from '../../components/pagination.js';
import { titleCase } from '../../utils/format.js';
import platformService from '../../services/platform-service.js';

const ACTIONS = ['create', 'update', 'archive', 'delete', 'restore', 'approve', 'reject', 'settings', 'transfer'];
const TONE = { create: 'success', update: 'info', archive: 'warning', delete: 'danger', reject: 'danger', approve: 'success', restore: 'success', settings: 'info' };

function detail(l) {
  const m = l.meta || {};
  if (m.action) return titleCase(String(m.action).replace(/_/g, ' '));
  if (m.reference) return m.reference;
  if (m.invoiceNo) return `Invoice ${m.invoiceNo}`;
  if (m.name) return m.name;
  if (l.after?.name) return l.after.name;
  return l.entityId ? String(l.entityId).slice(0, 12) : '—';
}

export default async function platformAuditPage(ctx, mount) {
  const p = page(mount, { title: 'Activity log', subtitle: 'Everything platform operators have done, across every merchant' });
  const q = { ...ctx.query };
  const state = { page: 1 };

  const bar = document.createElement('div');
  bar.className = 'sa-filterbar';
  bar.innerHTML = `
    <input class="input" id="a-search" type="search" placeholder="Search operator / entity / action" value="${escapeHtml(q.search || '')}">
    <select class="select" id="a-action">
      <option value="">Action: all</option>
      ${ACTIONS.map((a) => `<option value="${a}">${titleCase(a)}</option>`).join('')}
    </select>
    <input class="input" id="a-from" type="date" aria-label="From">
    <input class="input" id="a-to" type="date" aria-label="To">`;
  p.body.appendChild(bar);
  const list = document.createElement('div');
  p.body.appendChild(list);

  const read = () => ({
    search: bar.querySelector('#a-search').value.trim() || undefined,
    action: bar.querySelector('#a-action').value || undefined,
    from: bar.querySelector('#a-from').value || undefined,
    to: bar.querySelector('#a-to').value || undefined,
    page: state.page,
    pageSize: 25,
  });
  const reload = debounce(() => { state.page = 1; render(); }, 250);
  bar.querySelector('#a-search').addEventListener('input', reload);
  bar.querySelectorAll('select, input[type=date]').forEach((el) => el.addEventListener('change', () => { state.page = 1; render(); }));

  async function render() {
    loading(list);
    let res;
    try {
      res = await platformService.audit(read());
    } catch (err) {
      return errorBox(list, err);
    }
    const rows = (res.data || []).map((l) => `<tr>
      <td class="text-xs">${fmtDateTime(l.at)}</td>
      <td>${escapeHtml(l.actorName || 'system')}</td>
      <td>${badge(l.action, TONE[l.action] || 'muted')}</td>
      <td>${escapeHtml(titleCase(l.entity || ''))}</td>
      <td>${l.merchantName ? `<a href="#/merchants/${escapeHtml(l.merchantId || l.meta?.merchantId || '')}">${escapeHtml(l.merchantName)}</a>` : '—'}</td>
      <td>${escapeHtml(detail(l))}</td>
    </tr>`);
    const from = res.total === 0 ? 0 : (res.page - 1) * res.pageSize + 1;
    const to = Math.min(res.page * res.pageSize, res.total);
    list.innerHTML = `<p class="muted text-sm" style="margin:0 0 8px">${res.total ? `${from}–${to} of ` : ''}${res.total} action${res.total === 1 ? '' : 's'}</p>` +
      tableCard({
        head: [{ label: 'Time' }, { label: 'Operator' }, { label: 'Action' }, { label: 'Entity' }, { label: 'Merchant' }, { label: 'Detail' }],
        rows,
        empty: 'No platform actions match these filters.',
      }) +
      renderPagination(res.page, res.totalPages || 1);
    list.querySelectorAll('.js-page').forEach((b) => b.addEventListener('click', () => {
      const n = Number(b.dataset.page);
      if (n && n !== state.page) { state.page = n; render(); }
    }));
  }
  await render();
  liveRefresh(p.body, render);
}
