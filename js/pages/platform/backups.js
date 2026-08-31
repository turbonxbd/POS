/**
 * platform/backups.js — Super Admin → Backups.
 *
 * Mock mode: shows the automatic IndexedDB snapshots (js/core/backup-auto.js),
 * with backup-now / download / restore / delete. This is the owner's safety net
 * against a cleared browser on the demo/self-hosted-without-a-server case.
 *
 * A real (rest) deployment shows the same page fed from the PHP backend's
 * `bin/backup.php` dumps + the cron schedule — the authoritative story for
 * "no merchant data is ever lost".
 */
import { page, tableCard, loading, errorBox, fmtDateTime } from './kit.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { icon } from '../../components/icons.js';
import bus from '../../core/event-bus.js';
import config from '../../config.js';
import platformService from '../../services/platform-service.js';

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

export default async function backupsPage(ctx, mount) {
  const p = page(mount, {
    title: 'Backups',
    subtitle: 'Automatic snapshots of the full dataset — download a copy off-device and restore any time.',
  });
  loading(p.body);

  if (config.api?.mode === 'rest') {
    return renderServer(p);
  }

  let auto;
  try {
    auto = await import('../../core/backup-auto.js');
  } catch (err) {
    return errorBox(p.body, err);
  }

  async function render() {
    const status = auto.autoBackupStatus();
    const snaps = await auto.listSnapshots();

    p.setActions(status.supported ? [{
      label: 'Back up now', icon: 'database', onClick: async () => {
        const r = await auto.snapshotNow({ force: true, reason: 'manual' });
        toast[r ? 'success' : 'info'](r ? 'Snapshot saved' : 'A snapshot was just taken — try again in a minute.');
        render();
      },
    }] : []);

    const statusCard = `
      <div class="card sa-card" style="padding:var(--sp-4);margin-bottom:var(--sp-4)">
        <div class="row" style="gap:var(--sp-3);align-items:flex-start;flex-wrap:wrap">
          <span style="color:var(--${status.supported ? 'success' : 'warning'}-fg, var(--text-muted))">${icon(status.supported ? 'check-circle' : 'alert-triangle', { size: 26 })}</span>
          <div class="grow" style="min-width:220px">
            <div class="strong">${status.supported ? 'Automatic backups are ON' : 'Automatic local backups unavailable'}</div>
            <p class="text-sm muted" style="margin:2px 0 0">
              ${status.supported
                ? `A full snapshot is taken every ${Math.round(status.everyMs / 60000)} minutes while the panel is open, and once more when it closes. The newest ${status.keep} are kept in this browser.`
                : 'This browser has no IndexedDB (private window / very old browser), or the site runs against a live server — in that case use the server backup (see below).'}
            </p>
          </div>
        </div>
        <div class="alert alert--info" style="margin-top:var(--sp-3)"><div class="alert__body text-sm">
          <strong>Off-device copy:</strong> a browser snapshot is lost if this computer or its storage is wiped.
          Click <em>Download</em> on the newest snapshot regularly and keep the file somewhere safe (cloud drive / email).
          For a hosted deployment, the PHP backend's <code>bin/backup.php</code> cron writes daily database dumps to
          <code>storage/backups/</code> — wire it in hPanel → Cron Jobs and copy them off-server.
        </div></div>
      </div>`;

    const rows = snaps.map((s) => {
      const cols = Object.entries(s.collections || {}).filter(([, n]) => n > 0);
      const total = cols.reduce((a, [, n]) => a + n, 0);
      return `<tr data-at="${escapeHtml(s.at)}">
        <td>${fmtDateTime(s.at)}<div class="text-xs muted">${escapeHtml(s.reason || 'auto')}</div></td>
        <td class="num">${total.toLocaleString()} records</td>
        <td class="num">${fmtBytes(s.bytes)}</td>
        <td class="num" style="white-space:nowrap">
          <button class="btn btn--ghost btn--sm js-dl">${icon('download', { size: 13 })} Download</button>
          <button class="btn btn--ghost btn--sm js-restore">${icon('rotate-ccw', { size: 13 })} Restore</button>
          <button class="btn btn--icon btn--ghost btn--sm js-del" aria-label="Delete">${icon('trash', { size: 13 })}</button>
        </td>
      </tr>`;
    });

    p.body.innerHTML = statusCard + tableCard({
      head: ['Taken', { label: 'Contents', num: true }, { label: 'Size', num: true }, { label: '', num: true }],
      rows,
      empty: status.supported ? 'No snapshots yet — the first is taken ~20 s after the panel opens.' : 'Automatic snapshots are off.',
    });

    p.body.querySelectorAll('tr[data-at]').forEach((tr) => {
      const at = tr.dataset.at;
      tr.querySelector('.js-dl').addEventListener('click', () => download(at));
      tr.querySelector('.js-restore').addEventListener('click', () => restore(at));
      tr.querySelector('.js-del').addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete this snapshot?', message: 'It cannot be recovered.', confirmLabel: 'Delete', danger: true }))) return;
        await auto.deleteSnapshot(at);
        toast.success('Snapshot deleted');
        render();
      });
    });
  }

  async function download(at) {
    const json = await auto.readSnapshot(at);
    if (!json) { toast.error('That snapshot could not be read.'); return; }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `postxbd-backup-${at.replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success('Backup file downloaded');
  }

  async function restore(at) {
    const ok = await confirmDialog({
      title: 'Restore from this snapshot?',
      message: 'Every merchant, product, sale and setting will be replaced with the state from this snapshot. The current data is overwritten. A fresh snapshot is taken first so you can undo.',
      confirmLabel: 'Restore', danger: true,
    });
    if (!ok) return;
    try {
      await auto.snapshotNow({ force: true, reason: 'pre-restore' });
      await auto.restoreSnapshot(at);
      toast.success('Data restored from snapshot');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      toast.error(err?.message || 'Restore failed');
    }
  }

  const off = bus.on('backup:auto-snapshot', () => {
    if (!p.root.isConnected) { off(); return; }
    if (!document.querySelector('.overlay')) render();
  });

  render();
}

/* ---- rest deployment: server-side database dumps from bin/backup.php ---- */
async function renderServer(p) {
  async function render() {
    loading(p.body);
    let data;
    try {
      data = await platformService.backups();
    } catch (err) {
      return errorBox(p.body, err);
    }
    p.setActions([{
      label: 'Back up now', icon: 'database', onClick: async () => {
        p.setActions([]);
        try {
          await platformService.runBackup();
          toast.success('Database dump written');
        } catch (err) {
          toast.error(err?.data?.message || 'Backup failed');
        }
        render();
      },
    }]);

    const rows = (data.files || []).map((f) => `<tr>
      <td>${fmtDateTime(f.at)}</td>
      <td>${escapeHtml(f.name)}</td>
      <td class="num">${fmtBytes(f.bytes)}</td>
      <td class="num" style="white-space:nowrap">
        <a class="btn btn--ghost btn--sm" href="/api/platform/backups/download?file=${encodeURIComponent(f.name)}">${icon('download', { size: 13 })} Download</a>
        <button class="btn btn--icon btn--ghost btn--sm js-del" data-f="${escapeHtml(f.name)}" aria-label="Delete">${icon('trash', { size: 13 })}</button>
      </td></tr>`);

    p.body.innerHTML = `
      <div class="alert alert--${data.mysqldump ? 'info' : 'warning'}" style="margin-bottom:var(--sp-4)"><div class="alert__body text-sm">
        ${data.mysqldump ? '<strong>mysqldump available</strong> — full transactional dumps.' : '<strong>mysqldump not on PATH</strong> — a portable PHP dump is used instead (slower, still complete).'}
        Dumps are written to <code>${escapeHtml(data.dir || 'storage/backups')}</code>; the newest ${data.retain || 14} are kept.
        <br><strong>${escapeHtml(data.note || '')}</strong>
      </div></div>
      ${tableCard({
        head: ['Written', 'File', { label: 'Size', num: true }, { label: '', num: true }],
        rows,
        empty: 'No dumps yet — click "Back up now" or wait for the cron.',
      })}`;

    p.body.querySelectorAll('.js-del').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Delete ${b.dataset.f}?`, message: 'The dump file is removed from the server.', confirmLabel: 'Delete', danger: true }))) return;
      try { await platformService.deleteBackup(b.dataset.f); toast.success('Deleted'); render(); }
      catch (err) { toast.error(err?.data?.message || 'Delete failed'); }
    }));
  }
  render();
}
