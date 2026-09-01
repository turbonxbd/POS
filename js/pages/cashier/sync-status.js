/**
 * sync-status.js - cashier topbar indicator for the offline sales queue.
 *
 * The queue itself lives in js/core/sync-queue.js: a sale that fails because the
 * network is down is stored locally with its idempotency key and replayed on
 * reconnect. This is the visible surface — online/offline state, how many sales
 * are waiting, and a panel to retry or dismiss stuck items.
 */
import syncQueue from '../../core/sync-queue.js';
import store from '../../core/store.js';
import bus from '../../core/event-bus.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';

const STATUS_TONE = { queued: 'neutral', syncing: 'info', done: 'success', conflict: 'danger', failed: 'danger' };

export function mountSyncStatus(host) {
  const btn = document.createElement('button');
  btn.className = 'btn btn--ghost btn--sm js-sync-status';
  btn.type = 'button';
  host.appendChild(btn);

  const paint = () => {
    const items = syncQueue.list();
    const pending = items.filter((i) => i.status === 'queued' || i.status === 'syncing').length;
    const stuck = items.filter((i) => i.status === 'conflict' || i.status === 'failed').length;
    const online = store.get('online') !== false;

    if (online && pending === 0 && stuck === 0) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    if (stuck) {
      btn.className = 'btn btn--sm js-sync-status btn--danger';
      btn.innerHTML = `${icon('alert-triangle', { size: 14 })} ${stuck} need${stuck === 1 ? 's' : ''} attention`;
    } else if (!online) {
      btn.className = 'btn btn--sm js-sync-status btn--outline';
      btn.innerHTML = `<span class="sync-dot sync-dot--off"></span> Offline${pending ? ` · ${pending} queued` : ''}`;
    } else {
      btn.className = 'btn btn--sm js-sync-status btn--outline';
      btn.innerHTML = `<span class="spinner"></span> Syncing ${pending}`;
    }
  };

  btn.addEventListener('click', openPanel);
  const offStore = store.watch('syncPending', paint);
  const offOnline = store.watch('online', paint);
  const offEnq = bus.on('sync:enqueued', paint);
  const offFlush = bus.on('sync:flushed', paint);
  const offConflict = bus.on('sync:conflict', () => { paint(); toast.warning('A queued sale conflicts with the server — open the sync panel to resolve it.', { duration: 8000 }); });
  const offFailed = bus.on('sync:item-failed', () => { paint(); toast.error('A queued sale was rejected by the server — open the sync panel.', { duration: 8000 }); });
  const offSynced = bus.on('sync:item-synced', () => { paint(); });

  paint();

  return () => { offStore(); offOnline(); offEnq(); offFlush(); offConflict(); offFailed(); offSynced(); btn.remove(); };
}

function openPanel() {
  const m = openModal({ title: 'Offline sales queue', size: 'md', body: '<div></div>' });
  const render = () => {
    const items = syncQueue.list().slice().reverse();
    const online = store.get('online') !== false;
    m.setBody(`
      <p class="text-sm muted">${online
        ? 'Connected. Queued sales sync automatically; use Retry to push them now.'
        : 'You are offline. Sales you complete are saved here and will sync when the connection returns.'}</p>
      ${items.length ? `<div class="table-wrap"><table class="table table--compact">
        <thead><tr><th>Sale</th><th>Queued</th><th>Status</th><th></th></tr></thead>
        <tbody>${items.map((i) => `<tr>
          <td>${escapeHtml(i.result?.invoiceNo || i.body?.idempotencyKey?.slice(0, 8) || i.kind)}${i.lastError ? `<br><span class="muted text-xs">${escapeHtml(i.lastError)}</span>` : ''}</td>
          <td class="text-xs">${fmtDateTime(i.createdAt)}${i.attempts ? ` · ${i.attempts} tr${i.attempts === 1 ? 'y' : 'ies'}` : ''}</td>
          <td><span class="badge badge--${STATUS_TONE[i.status] || 'neutral'}">${i.status}</span></td>
          <td class="num">${['conflict', 'failed', 'done'].includes(i.status) ? `<button class="btn btn--ghost btn--sm js-drop" data-id="${i.id}">Dismiss</button>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted text-sm">Nothing queued — every sale has been saved to the server.</p>'}`);
    m.setFooter(`
      <button class="btn btn--ghost js-clear">Clear synced</button>
      <button class="btn btn--primary js-retry" ${online ? '' : 'disabled'}>Retry now</button>
      <button class="btn btn--ghost js-modal-close">Close</button>`);
    m.$('.js-retry').addEventListener('click', async () => {
      m.setBusy(true);
      const res = await syncQueue.flush().catch(() => ({ flushed: 0 }));
      m.setBusy(false);
      if (res.flushed) toast.success(`${res.flushed} sale${res.flushed === 1 ? '' : 's'} synced`);
      render();
    });
    m.$('.js-clear').addEventListener('click', () => { syncQueue.clearResolved(); render(); });
    m.$$('.js-drop').forEach((b) => b.addEventListener('click', () => { syncQueue.remove(b.dataset.id); render(); }));
  };
  const off = bus.on('sync:item-synced', render);
  const off2 = bus.on('sync:flushed', render);
  const origClose = m.close;
  m.close = () => { off(); off2(); origClose.call(m); };
  render();
}

export default mountSyncStatus;
