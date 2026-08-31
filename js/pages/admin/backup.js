/**
 * backup.js - export / import / reset the dataset.
 */
import { pageShell, statStrip } from '../shared/page-kit.js';
import { blockLoader } from '../../components/skeleton.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDateTime } from '../../utils/date.js';
import { download, readFileAsText } from '../../utils/csv.js';
import { fileSize } from '../../utils/format.js';
import backupService from '../../services/backup-service.js';
import db from '../../core/db.js';

export default async function backupPage(ctx, mount) {
  mount.innerHTML = blockLoader('Loading…');
  const shell = pageShell(mount, {
    title: 'Backup / Data Management',
    subtitle: 'Export your full dataset, restore from a backup, or reset the demo.',
  });
  let auto = null;
  try { auto = await import('../../core/backup-auto.js'); } catch { /* ignore */ }
  render();

  async function render() {
    const stats = db.stats();
    const autoStatus = auto?.autoBackupStatus?.() || { supported: false };
    const autoSnaps = auto?.supported !== false && auto?.listSnapshots ? await auto.listSnapshots().catch(() => []) : [];
    const lastSnap = autoSnaps[0];
    shell.body.innerHTML = `
      ${statStrip([
        { label: 'Documents', value: stats.totalDocuments },
        { label: 'Collections', value: Object.keys(stats.collections).length },
        { label: 'Local storage used', value: fileSize(stats.storageBytes) },
        { label: 'Data seeded', value: stats.meta.seededAt ? fmtDateTime(stats.meta.seededAt) : '—' },
        { label: 'Auto-backup', value: autoStatus.supported ? (lastSnap ? fmtDateTime(lastSnap.at) : 'starting…') : 'off' },
      ])}
      ${autoStatus.supported ? `<div class="alert alert--info" style="margin-top:var(--sp-4)"><div class="alert__body text-sm">
        <strong>Automatic backups are on.</strong> A full snapshot is saved to this browser every
        ${Math.round(autoStatus.everyMs / 60000)} minutes and when you close the tab (newest ${autoStatus.keep} kept).
        ${lastSnap ? `Last snapshot: <strong>${fmtDateTime(lastSnap.at)}</strong>.` : ''}
        Still <strong>download a copy</strong> below and keep it off this device.
        ${autoSnaps.length ? `<button class="btn btn--ghost btn--sm js-dl-auto" style="margin-left:var(--sp-2)">Download latest snapshot</button>` : ''}
      </div></div>` : ''}
      <div class="field-grid" style="margin-top:var(--sp-4)">
        <div class="card card--pad">
          <div class="form-section-title">Export</div>
          <p class="text-sm muted">Download a complete JSON snapshot of every record. Store it somewhere safe.</p>
          <button class="btn btn--primary btn--block" id="export" style="margin-top:var(--sp-3)">Download backup (.json)</button>
        </div>
        <div class="card card--pad">
          <div class="form-section-title">Import / Restore</div>
          <p class="text-sm muted">Replace all current data with the contents of a backup file.</p>
          <label class="btn btn--outline btn--block" style="margin-top:var(--sp-3)">Choose backup file<input type="file" accept=".json,application/json" hidden id="import"></label>
        </div>
        <div class="card card--pad">
          <div class="form-section-title">Reset demo data</div>
          <p class="text-sm muted">Wipe everything and reload the sample "TX Demo" dataset.</p>
          <button class="btn btn--outline btn--block" id="reseed" style="margin-top:var(--sp-3)">Reload demo data</button>
        </div>
        <div class="card card--pad" style="border-color:var(--danger-500)">
          <div class="form-section-title" style="color:var(--danger-fg)">Start blank</div>
          <p class="text-sm muted">Wipe everything and start with an empty shop (one owner account, one branch).</p>
          <button class="btn btn--danger btn--block" id="blank" style="margin-top:var(--sp-3)">Wipe & start blank</button>
        </div>
      </div>
      <div class="table-wrap" style="margin-top:var(--sp-4)">
        <table class="table table--compact"><thead><tr><th>Collection</th><th class="num">Records</th></tr></thead>
        <tbody>${Object.entries(stats.collections).sort().map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${v}</td></tr>`).join('')}</tbody></table>
      </div>`;

    shell.body.querySelector('#export').addEventListener('click', async () => {
      const data = await backupService.exportData();
      download(`postxbd-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(data, null, 2), 'application/json');
      toast.success('Backup downloaded');
    });

    shell.body.querySelector('.js-dl-auto')?.addEventListener('click', async () => {
      const json = await auto.readSnapshot(lastSnap.at);
      if (!json) { toast.error('That snapshot could not be read.'); return; }
      download(`postxbd-auto-backup-${lastSnap.at.replace(/[:.]/g, '-')}.json`, json, 'application/json');
      toast.success('Snapshot downloaded');
    });

    shell.body.querySelector('#import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (!(await confirmDialog({ title: 'Restore this backup?', message: 'All current data will be replaced. Export a backup first if unsure.', danger: true, confirmLabel: 'Restore', requireText: 'RESTORE' }))) return;
      try {
        await backupService.importData(await readFileAsText(file));
        toast.success('Backup restored');
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        toast.error(err.message);
      }
    });

    shell.body.querySelector('#reseed').addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Reload demo data?', message: 'Everything currently stored will be replaced with the sample dataset.', danger: true, confirmLabel: 'Reload demo', requireText: 'RESET' }))) return;
      await backupService.reset({ mode: 'demo' });
      toast.success('Demo data reloaded');
      setTimeout(() => location.reload(), 800);
    });

    shell.body.querySelector('#blank').addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Wipe everything?', message: 'This permanently deletes all products, sales, customers and history in this browser.', danger: true, confirmLabel: 'Wipe & start blank', requireText: 'DELETE' }))) return;
      await backupService.reset({ mode: 'blank' });
      toast.success('Started blank');
      setTimeout(() => (location.href = 'login.html'), 800);
    });
  }
}
