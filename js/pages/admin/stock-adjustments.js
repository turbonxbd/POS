/**
 * stock-adjustments.js - list past adjustments + create a new one (multi-line).
 */
import { pageShell, moneyCell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce } from '../../utils/debounce.js';
import { fmtDateTime } from '../../utils/date.js';
import { titleCase } from '../../utils/format.js';
import { ADJUSTMENT_REASONS } from '../../data/schema.js';
import inventoryService from '../../services/inventory-service.js';
import productService from '../../services/product-service.js';
import { can } from '../../core/rbac.js';

export default async function stockAdjustmentsPage(ctx, mount) {
  const shell = pageShell(mount, {
    title: 'Stock Adjustments',
    subtitle: 'Correct stock for recounts, damage, loss or expiry. Every line writes an inventory movement.',
    actions: [can('inventory.adjust') && { label: 'New Adjustment', icon: 'plus', variant: 'primary', onClick: openForm }].filter(Boolean),
  });

  const table = createDataTable(shell.body, {
    columns: [
      { key: 'at', label: 'Date', sortable: true, render: (r) => fmtDateTime(r.at) },
      { key: 'reference', label: 'Reference', render: (r) => `<span class="mono">${escapeHtml(r.reference)}</span>` },
      { key: 'type', label: 'Direction', render: (r) => `<span class="badge badge--${r.type === 'increase' ? 'success' : 'danger'}">${titleCase(r.type)}</span>` },
      { key: 'reason', label: 'Reason', render: (r) => `<span class="badge badge--neutral">${titleCase(r.reason)}</span>` },
      { key: 'netUnits', label: 'Net units', align: 'right', render: (r) => `${r.netUnits > 0 ? '+' : ''}${r.netUnits}` },
      { key: 'valueImpact', label: 'Value impact', align: 'right', render: (r) => moneyCell(r.valueImpact) },
      { key: 'note', label: 'Note', render: (r) => escapeHtml(r.note || '—') },
    ],
    filters: [{ key: 'reason', label: 'Reason', options: ADJUSTMENT_REASONS }],
    searchPlaceholder: 'Search reference or note…',
    stacked: true,
    emptyState: { icon: 'sliders', title: 'No adjustments yet', action: can('inventory.adjust') ? { label: 'New Adjustment', icon: 'plus', onClick: openForm } : null },
    fetcher: (params) => inventoryService.getAdjustments(params),
    onRowClick: (row) => showDetail(row),
    rowActions: (row) => [{ label: 'View', icon: 'eye', onClick: () => showDetail(row) }],
  });

  function showDetail(row) {
    openModal({
      title: row.reference, subtitle: `${titleCase(row.reason)} · ${fmtDateTime(row.at)}`, size: 'md',
      body: `<div class="table-wrap"><table class="table table--compact"><thead><tr><th>Product</th><th class="num">Δ Qty</th><th>Note</th></tr></thead>
        <tbody>${row.lines.map((l) => `<tr><td>${escapeHtml(l.productName || l.productId)}</td><td class="num">${l.deltaQty > 0 ? '+' : ''}${l.deltaQty}</td><td>${escapeHtml(l.note || '—')}</td></tr>`).join('')}</tbody></table></div>
        ${row.note ? `<p class="muted text-sm" style="margin-top:var(--sp-3)">${escapeHtml(row.note)}</p>` : ''}`,
      footer: '<button class="btn btn--primary js-modal-close">Close</button>',
    });
  }

  function openForm() {
    const lines = [];
    const m = openModal({
      title: 'New Stock Adjustment', size: 'lg',
      body: `<div class="stack" style="--stack-gap:var(--sp-4)">
        <div class="field-grid">
          <label class="field"><span class="label">Reason</span>
            <select class="select js-reason">${ADJUSTMENT_REASONS.map((r) => `<option value="${r.value}">${r.label}</option>`).join('')}</select></label>
          <label class="field"><span class="label">Note</span><input class="input js-note" placeholder="Optional"></label>
        </div>
        <div>
          <div class="input-search"><span class="input-search__icon">${icon('search', { size: 16 })}</span>
            <input class="input js-search" placeholder="Search a product to add…" autocomplete="off"></div>
          <div class="js-results stack" style="--stack-gap:2px;margin-top:var(--sp-2)"></div>
        </div>
        <div class="js-lines"></div>
      </div>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--primary js-save" disabled>Post Adjustment</button>`,
    });

    const results = m.$('.js-results');
    const linesEl = m.$('.js-lines');
    const search = debounce(async () => {
      const term = m.$('.js-search').value.trim();
      if (!term) { results.innerHTML = ''; return; }
      const res = await productService.getProducts({ search: term, pageSize: 8, status: 'all' });
      results.innerHTML = (res.data || []).map((p) => `<button class="btn btn--ghost js-add" data-id="${p.id}" style="justify-content:space-between">
        <span>${escapeHtml(p.name)}</span><span class="muted">on hand: ${p.stock}</span></button>`).join('');
      results.querySelectorAll('.js-add').forEach((b) => b.addEventListener('click', () => {
        const p = res.data.find((x) => x.id === b.dataset.id);
        if (lines.some((l) => l.productId === p.id)) return;
        lines.push({ productId: p.id, variantId: null, productName: p.name, currentStock: p.stock, deltaQty: 0, note: '' });
        m.$('.js-search').value = '';
        results.innerHTML = '';
        renderLines();
      }));
    }, 220);
    m.$('.js-search').addEventListener('input', search);

    function renderLines() {
      linesEl.innerHTML = lines.length ? `<table class="table table--compact"><thead><tr><th>Product</th><th class="num">On hand</th><th class="num">Change (+/−)</th><th class="num">New</th><th></th></tr></thead>
        <tbody>${lines.map((l, i) => `<tr data-i="${i}">
          <td>${escapeHtml(l.productName)}</td><td class="num">${l.currentStock}</td>
          <td class="num"><input class="input js-delta" type="number" value="${l.deltaQty}" style="width:90px;text-align:right"></td>
          <td class="num">${l.currentStock + l.deltaQty}</td>
          <td class="num"><button class="btn btn--icon btn--ghost btn--sm js-rm">${icon('x', { size: 14 })}</button></td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted text-sm">Add at least one product.</p>';
      linesEl.querySelectorAll('tr[data-i]').forEach((tr) => {
        const i = Number(tr.dataset.i);
        tr.querySelector('.js-delta').addEventListener('input', (e) => {
          lines[i].deltaQty = Math.trunc(Number(e.target.value) || 0);
          tr.querySelector('td:nth-child(4)').textContent = lines[i].currentStock + lines[i].deltaQty;
          m.$('.js-save').disabled = !lines.some((l) => l.deltaQty !== 0);
        });
        tr.querySelector('.js-rm').addEventListener('click', () => { lines.splice(i, 1); renderLines(); });
      });
      m.$('.js-save').disabled = !lines.some((l) => l.deltaQty !== 0);
    }
    renderLines();

    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-save').addEventListener('click', async () => {
      const payload = { reason: m.$('.js-reason').value, note: m.$('.js-note').value, lines: lines.filter((l) => l.deltaQty !== 0) };
      if (!(await confirmDialog({ title: 'Post this adjustment?', message: `${payload.lines.length} line(s) will change stock immediately and be recorded in the ledger.`, confirmLabel: 'Post' }))) return;
      m.setBusy(true);
      try {
        await inventoryService.adjustStock(payload);
        m.close();
        toast.success('Adjustment posted');
        table.reload();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }
}
