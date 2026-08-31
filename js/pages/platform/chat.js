/**
 * platform/chat.js - Super Admin -> Chat. Conversations started from the Live
 * site's support widget. Pick a thread, read it, reply (the visitor sees the
 * reply by polling), and close it when done.
 */
import http from '../../core/http.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { icon } from '../../components/icons.js';
import { page, loading, errorBox, badge, fmtDateTime } from './kit.js';

export default async function chatPage(ctx, mount) {
  const p = page(mount, { title: 'Chat', subtitle: 'Live conversations from the public website' });

  const bar = document.createElement('div');
  bar.className = 'sa-filterbar';
  bar.innerHTML = `<select class="select" id="c-status">
    ${['all', 'open', 'answered', 'closed'].map((s) => `<option value="${s}"${(ctx.query.status || 'open') === s ? ' selected' : ''}>${s === 'all' ? 'Status: all' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
  </select>`;
  p.body.appendChild(bar);

  const wrap = document.createElement('div');
  wrap.className = 'sa-chat';
  wrap.innerHTML = `<div class="sa-chat__list" id="c-list"></div><div class="sa-chat__view" id="c-view"><p class="sa-empty">Select a conversation.</p></div>`;
  p.body.appendChild(wrap);

  const listEl = wrap.querySelector('#c-list');
  const viewEl = wrap.querySelector('#c-view');
  let activeId = null;

  bar.addEventListener('change', loadList);
  await loadList();

  async function loadList() {
    loading(listEl);
    let res;
    try {
      const status = bar.querySelector('#c-status').value;
      res = await http.get('/platform/chat', { params: status === 'all' ? {} : { status } });
    } catch (err) { return errorBox(listEl, err); }
    if (!res.data.length) { listEl.innerHTML = `<p class="sa-empty">No conversations.</p>`; return; }
    listEl.innerHTML = res.data.map((t) => `
      <button class="sa-chat__item ${t.id === activeId ? 'is-active' : ''}" data-id="${t.id}">
        <div class="sa-chat__item-top"><strong>${escapeHtml(t.name || 'Visitor')}</strong> ${badge(t.status)}</div>
        <div class="muted text-sm">${escapeHtml(t.email || 'no email')} · ${fmtDateTime(t.lastMessageAt)}</div>
        ${t.unreadForAdmin ? `<span class="sa-chat__unread">${t.unreadForAdmin} new</span>` : ''}
      </button>`).join('');
    listEl.querySelectorAll('.sa-chat__item').forEach((b) => b.addEventListener('click', () => openThread(b.dataset.id)));
  }

  async function openThread(id) {
    activeId = id;
    listEl.querySelectorAll('.sa-chat__item').forEach((b) => b.classList.toggle('is-active', b.dataset.id === id));
    loading(viewEl);
    let t;
    try { t = await http.get('/platform/chat/' + id); } catch (err) { return errorBox(viewEl, err); }
    viewEl.innerHTML = `
      <div class="sa-chat__head">
        <div><strong>${escapeHtml(t.name || 'Visitor')}</strong><div class="muted text-sm">${escapeHtml(t.email || 'no email')} · ${escapeHtml(t.subject || '')}</div></div>
        <div class="sa-chat__head-actions">
          ${badge(t.status)}
          ${t.status !== 'closed' ? `<button class="btn btn--ghost btn--sm" id="c-close">Mark closed</button>` : `<button class="btn btn--ghost btn--sm" id="c-reopen">Reopen</button>`}
        </div>
      </div>
      <div class="sa-chat__thread" id="c-thread">
        ${(t.messages || []).map((m) => `<div class="sa-chat__msg sa-chat__msg--${m.from}"><span>${escapeHtml(m.text)}</span><time>${escapeHtml(m.by || '')} · ${fmtDateTime(m.at)}</time></div>`).join('')}
      </div>
      <form class="sa-chat__composer" id="c-form">
        <input class="input" id="c-text" placeholder="Write a reply…" autocomplete="off">
        <button class="btn btn--primary" type="submit">${icon('save', { size: 14 })} Send</button>
      </form>`;
    const thread = viewEl.querySelector('#c-thread');
    thread.scrollTop = thread.scrollHeight;
    viewEl.querySelector('#c-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = viewEl.querySelector('#c-text').value.trim();
      if (!text) return;
      try {
        await http.post(`/platform/chat/${id}/reply`, { text });
        openThread(id); loadList();
      } catch (err) { toast.error(err?.data?.message || 'Could not send'); }
    });
    viewEl.querySelector('#c-close')?.addEventListener('click', async () => { await http.patch('/platform/chat/' + id, { status: 'closed' }); openThread(id); loadList(); });
    viewEl.querySelector('#c-reopen')?.addEventListener('click', async () => { await http.patch('/platform/chat/' + id, { status: 'open' }); openThread(id); loadList(); });
  }
}
