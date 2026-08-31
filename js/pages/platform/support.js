/**
 * platform/support.js - support / sales enquiries from the Live panel and from
 * logged-in merchants. Reply and close.
 */
import platformService from '../../services/platform-service.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { icon } from '../../components/icons.js';
import { page, loading, errorBox, badge, fmtDateTime, liveRefresh } from './kit.js';

export default async function supportPage(ctx, mount) {
  const p = page(mount, { title: 'Support', subtitle: 'Enquiries from the website and from merchants' });
  const q = { ...ctx.query };

  const planNames = new Map();
  try { (await platformService.plans()).data.forEach((pl) => planNames.set(pl.id, pl.name)); } catch { /* offline */ }

  const bar = document.createElement('div');
  bar.className = 'sa-filterbar';
  bar.innerHTML = `<select class="select" id="sup-status">
    ${['all', 'open', 'answered', 'closed'].map((s) => `<option value="${s}"${(q.status || 'open') === s ? ' selected' : ''}>${s === 'all' ? 'Status: all' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
  </select>`;
  p.body.appendChild(bar);
  const list = document.createElement('div');
  list.className = 'sa-tickets';
  p.body.appendChild(list);
  bar.addEventListener('change', render);

  async function render() {
    loading(list);
    let res;
    try {
      const status = bar.querySelector('#sup-status').value;
      res = await platformService.support(status === 'all' ? {} : { status });
    } catch (err) {
      return errorBox(list, err);
    }
    if (!res.data.length) {
      list.innerHTML = `<div class="card card--pad"><p class="muted">No requests.</p></div>`;
      return;
    }
    list.innerHTML = res.data.map((t) => `
      <div class="card sa-ticket" data-id="${t.id}">
        <div class="sa-ticket__head">
          <div>
            <strong>${escapeHtml(t.subject || 'Enquiry')}</strong> ${badge(t.status)}
            <div class="muted text-sm">${escapeHtml(t.name || 'Visitor')} · ${escapeHtml(t.email)} · ${fmtDateTime(t.at)} · ${escapeHtml(t.source || 'public')}${t.planId ? ' · interested in ' + escapeHtml(planName(t.planId)) : ''}</div>
          </div>
        </div>
        <p class="sa-ticket__msg">${escapeHtml(t.message)}</p>
        ${(t.replies || []).map((r) => `<div class="sa-ticket__reply"><span>${escapeHtml(r.by)} · ${fmtDateTime(r.at)}</span><p>${escapeHtml(r.text)}</p></div>`).join('')}
        <div class="sa-ticket__actions">
          <input class="input js-reply" placeholder="Write a reply…">
          <button class="btn btn--primary btn--sm js-send">${icon('save', { size: 14 })} Send reply</button>
          ${t.status !== 'closed' ? `<button class="btn btn--ghost btn--sm js-close">Mark closed</button>` : ''}
        </div>
      </div>`).join('');

    list.querySelectorAll('.sa-ticket').forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('.js-send').addEventListener('click', async () => {
        const text = el.querySelector('.js-reply').value.trim();
        if (!text) return;
        try { await platformService.replySupport(id, text); toast.success('Reply sent'); render(); }
        catch (err) { toast.error(err?.data?.message || 'Could not send'); }
      });
      el.querySelector('.js-close')?.addEventListener('click', async () => {
        await platformService.setSupportStatus(id, 'closed'); toast.success('Closed'); render();
      });
    });
  }

  function planName(id) { return planNames.get(id) || 'a plan'; }
  await render();
  liveRefresh(p.body, render);
}
