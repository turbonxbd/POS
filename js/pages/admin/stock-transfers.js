/**
 * stock-transfers.js — move stock between branches.
 * Backend (mock inventory.routes.js + PHP Inventory.php) was already complete:
 * POST /inventory/transfers writes a transfer_out at the source and a
 * transfer_in at the destination in one transaction. This is the missing UI.
 */
import { pageShell } from '../shared/page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce } from '../../utils/debounce.js';
import { fmtDateTime } from '../../utils/date.js';
import inventoryService from '../../services/inventory-service.js';
import productService from '../../services/product-service.js';
import branchService from '../../services/branch-service.js';
import { can } from '../../core/rbac.js';
import store from '../../core/store.js';

export default async function stockTransfersPage(ctx, mount) {
  const branchRes = await branchService.getBranches({ pageSize: 'all' }).catch(() => ({ data: [] }));
  const branches = (branchRes.data || branchRes || []).filter((b) => !b.archivedAt);

  const shell = pageShell(mount, {
    title: 'Stock Transfers',
    subtitle: 'Move stock from one branch to another. Each transfer writes a movement out and a movement in.',
    actions: [
      can('inventory.transfer') && branches.length >= 2 && { label: 'New Transfer', icon: 'plus', variant: 'primary', onClick: openForm },
    ].filter(Boolean),
  });

  const bn = (id) => branches.find((b) => b.id === id)?.name || '—';

  const table = createDataTable(shell.body, {
    columns: [
      { key: 'at', label: 'Date', sortable: true, render: (r) => fmtDateTime(r.at) },
      { key: 'reference', label: 'Reference', render: (r) => `<span class="mono">${escapeHtml(r.reference)}</span>` },
      { key: 'route', label: 'Route', render: (r) => `${escapeHtml(r.fromName || bn(r.fromBranchId))} <span class="muted">&rarr;</span> ${escapeHtml(r.toName || bn(r.toBranchId))}` },
      { key: 'lines', label: 'Items', align: 'right', render: (r) => `${(r.lines || []).length} line${(r.lines || []).length === 1 ? '' : 's'}` },
      { key: 'qty', label: 'Units', align: 'right', render: (r) => (r.lines || []).reduce((s, l) => s + Math.abs(Number(l.qty) || 0), 0) },
      { key: 'note', label: 'Note', render: (r) => escapeHtml(r.note || '—') },
    ],
    searchPlaceholder: 'Search reference or branch…',
    stacked: true,
    emptyState: {
      icon: 'truck', title: 'No transfers yet',
      message: branches.length < 2 ? 'You need at least two branches to transfer stock.' : 'Move stock between your branches and keep every movement on record.',
      action: can('inventory.transfer') && branches.length >= 2 ? { label: 'New Transfer', icon: 'plus', onClick: openForm } : null,
    },
    fetcher: (params) => inventoryService.getTransfers(params),
    onRowClick: (row) => showDetail(row),
    rowActions: (row) => [{ label: 'View', icon: 'eye', onClick: () => showDetail(row) }],
  });

  function showDetail(row) {
    openModal({
      title: row.reference,
      subtitle: `${row.fromName || bn(row.fromBranchId)} → ${row.toName || bn(row.toBranchId)} · ${fmtDateTime(row.at)}`,
      size: 'md',
      body: `<div class="table-wrap"><table class="table table--compact">
        <thead><tr><th>Product</th><th class="num">Units moved</th></tr></thead>
        <tbody>${(row.lines || []).map((l) => `<tr><td>${escapeHtml(l.productName || l.productId)}${l.variantLabel ? ` · ${escapeHtml(l.variantLabel)}` : ''}</td><td class="num">${Math.abs(Number(l.qty) || 0)}</td></tr>`).join('')}</tbody>
      </table></div>${row.note ? `<p class="muted text-sm" style="margin-top:var(--sp-3)">${escapeHtml(row.note)}</p>` : ''}`,
      footer: '<button class="btn btn--primary js-modal-close">Close</button>',
    });
  }

  function openForm() {
    const lines = [];
    let fromId = store.get('activeBranchId') || branches[0].id;
    let toId = branches.find((b) => b.id !== fromId)?.id || '';

    const m = openModal({
      title: 'New Stock Transfer', size: 'lg',
      body: `<div class="stack" style="--stack-gap:var(--sp-4)">
        <div class="field-grid">
          <label class="field"><span class="label">From branch</span>
            <select class="select js-from">${branches.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')}</select></label>
          <label class="field"><span class="label">To branch</span>
            <select class="select js-to">${branches.map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span class="label">Note</span><input class="input js-note" placeholder="Optional — e.g. restock request from Second Shop"></label>
        <div>
          <div class="input-search"><span class="input-search__icon">${icon('search', { size: 16 })}</span>
            <input class="input js-search" placeholder="Search a product to add…" autocomplete="off"></div>
          <div class="js-results stack" style="--stack-gap:2px;margin-top:var(--sp-2)"></div>
        </div>
        <div class="js-lines"></div>
      </div>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--primary js-save" disabled>Transfer stock</button>`,
    });

    const fromSel = m.$('.js-from');
    const toSel = m.$('.js-to');
    fromSel.value = fromId;
    toSel.value = toId;
    syncToOptions();

    function syncToOptions() {
      [...toSel.options].forEach((o) => (o.disabled = o.value === fromSel.value));
      if (toSel.value === fromSel.value) {
        const first = [...toSel.options].find((o) => !o.disabled);
        if (first) toSel.value = first.value;
      }
      fromId = fromSel.value;
      toId = toSel.value;
    }
    fromSel.addEventListener('change', () => { syncToOptions(); lines.length = 0; renderLines(); });
    toSel.addEventListener('change', () => { toId = toSel.value; });

    const results = m.$('.js-results');
    const linesEl = m.$('.js-lines');
    const runSearch = debounce(async () => {
      const term = m.$('.js-search').value.trim();
      if (!term) { results.innerHTML = ''; return; }
      const res = await productService.getProducts({ search: term, pageSize: 8, status: 'all', branchId: fromId });
      const data = res.data || [];
      results.innerHTML = data.map((p) => `<button class="btn btn--ghost js-add" data-id="${p.id}" style="justify-content:space-between" ${p.stock <= 0 ? 'disabled' : ''}>
        <span>${escapeHtml(p.name)}</span><span class="muted">${bn(fromId)}: ${p.stock}</span></button>`).join('') || '<p class="muted text-sm">No products found.</p>';
      results.querySelectorAll('.js-add').forEach((b) => b.addEventListener('click', () => {
        const p = data.find((x) => x.id === b.dataset.id);
        if (!p || lines.some((l) => l.productId === p.id)) return;
        lines.push({ productId: p.id, variantId: null, productName: p.name, available: p.stock, qty: 0 });
        m.$('.js-search').value = '';
        results.innerHTML = '';
        renderLines();
      }));
    }, 220);
    m.$('.js-search').addEventListener('input', runSearch);

    function renderLines() {
      linesEl.innerHTML = lines.length ? `<table class="table table--compact">
        <thead><tr><th>Product</th><th class="num">Available (from)</th><th class="num">Move</th><th class="num">Left</th><th></th></tr></thead>
        <tbody>${lines.map((l, i) => `<tr data-i="${i}">
          <td>${escapeHtml(l.productName)}</td>
          <td class="num">${l.available}</td>
          <td class="num"><input class="input js-qty" type="number" min="0" max="${l.available}" value="${l.qty}" style="width:90px;text-align:right"></td>
          <td class="num">${Math.max(0, l.available - l.qty)}</td>
          <td class="num"><button class="btn btn--icon btn--ghost btn--sm js-rm">${icon('x', { size: 14 })}</button></td>
        </tr>`).join('')}</tbody></table>` : '<p class="muted text-sm">Search and add at least one product.</p>';

      linesEl.querySelectorAll('tr[data-i]').forEach((tr) => {
        const i = Number(tr.dataset.i);
        tr.querySelector('.js-qty').addEventListener('input', (e) => {
          let q = Math.max(0, Math.trunc(Number(e.target.value) || 0));
          if (q > lines[i].available) { q = lines[i].available; e.target.value = q; }
          lines[i].qty = q;
          tr.querySelector('td:nth-child(4)').textContent = Math.max(0, lines[i].available - q);
          updateSave();
        });
        tr.querySelector('.js-rm').addEventListener('click', () => { lines.splice(i, 1); renderLines(); });
      });
      updateSave();
    }
    function updateSave() {
      m.$('.js-save').disabled = !lines.some((l) => l.qty > 0) || fromId === toId;
    }
    renderLines();

    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-save').addEventListener('click', async () => {
      const payload = {
        fromBranchId: fromId, toBranchId: toId,
        note: m.$('.js-note').value.trim(),
        lines: lines.filter((l) => l.qty > 0).map((l) => ({ productId: l.productId, variantId: l.variantId, qty: l.qty, productName: l.productName })),
      };
      if (!payload.lines.length) return;
      const units = payload.lines.reduce((s, l) => s + l.qty, 0);
      if (!(await confirmDialog({
        title: 'Transfer this stock?',
        message: `${units} unit${units === 1 ? '' : 's'} across ${payload.lines.length} product${payload.lines.length === 1 ? '' : 's'} will move from ${bn(fromId)} to ${bn(toId)} immediately.`,
        confirmLabel: 'Transfer',
      }))) return;
      m.setBusy(true);
      try {
        await inventoryService.transferStock(payload);
        m.close();
        toast.success('Stock transferred');
        table.reload();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }
}
