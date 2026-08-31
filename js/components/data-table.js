/**
 * data-table.js - server-driven data table.
 *
 * createDataTable(mount, {
 *   columns: [{ key, label, sortable, align, render(row)->string|Node, width }],
 *   fetcher: async ({ search, sort, dir, page, pageSize, ...filters }) => { data, total, totalPages, page, ... },
 *   filters: [{ key, label, type:'select', options:[{value,label}], default }],
 *   searchable: true, searchPlaceholder,
 *   selectable: false, rowActions: (row) => [{ label, icon, onClick, danger }],
 *   onRowClick, pageSize, emptyState:{icon,title,message,action},
 *   toolbarExtra: Node|string, stacked:true (mobile card layout)
 * })
 * returns { reload, getState, setFilter, destroy, selection() }
 */
import { icon } from './icons.js';
import { escapeHtml, on } from '../utils/dom.js';
import { renderPagination } from './pagination.js';
import { renderEmptyState } from './empty-state.js';
import { tableSkeleton } from './skeleton.js';
import { debounce } from '../utils/debounce.js';
import config from '../config.js';
import bus from '../core/event-bus.js';

export function createDataTable(mount, opts) {
  const {
    columns, fetcher, filters = [], searchable = true, searchPlaceholder = 'Search…',
    selectable = false, rowActions, onRowClick, pageSize = config.pagination.defaultPageSize,
    emptyState = {}, toolbarExtra, stacked = true, initial = {}, rowKey = (r) => r.id,
  } = opts;

  const state = {
    search: initial.search || '',
    sort: initial.sort || null,
    dir: initial.dir || 'desc',
    page: 1,
    pageSize,
    filters: Object.fromEntries(filters.map((f) => [f.key, initial[f.key] ?? f.default ?? ''])),
    total: 0,
    totalPages: 1,
    rows: [],
    loading: true,
    selected: new Set(),
    extra: null,
  };

  mount.classList.add('data-table');
  mount.innerHTML = `
    <div class="table-toolbar">
      ${searchable ? `
      <div class="input-search grow">
        <span class="input-search__icon">${icon('search', { size: 16 })}</span>
        <input type="search" class="input js-dt-search" placeholder="${escapeHtml(searchPlaceholder)}" value="${escapeHtml(state.search)}" aria-label="Search">
      </div>` : '<div class="grow"></div>'}
      <div class="cluster js-dt-filters"></div>
      <div class="cluster js-dt-extra"></div>
    </div>
    <div class="js-dt-bulk" hidden></div>
    <div class="table-wrap"><div class="js-dt-body"></div></div>
    <div class="table-footer js-dt-footer"></div>`;

  const els = {
    search: mount.querySelector('.js-dt-search'),
    filters: mount.querySelector('.js-dt-filters'),
    extra: mount.querySelector('.js-dt-extra'),
    bulk: mount.querySelector('.js-dt-bulk'),
    body: mount.querySelector('.js-dt-body'),
    footer: mount.querySelector('.js-dt-footer'),
  };

  // filters
  els.filters.innerHTML = filters
    .map(
      (f) => `<select class="select js-dt-filter" data-key="${f.key}" aria-label="${escapeHtml(f.label)}" style="height:36px;width:auto">
        ${f.allowAll !== false ? `<option value="">${escapeHtml(f.label)}: All</option>` : ''}
        ${f.options.map((o) => `<option value="${escapeHtml(o.value)}" ${String(state.filters[f.key]) === String(o.value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>`,
    )
    .join('');
  if (toolbarExtra) {
    if (toolbarExtra instanceof Node) els.extra.appendChild(toolbarExtra);
    else els.extra.innerHTML = toolbarExtra;
  }

  const doSearch = debounce(() => {
    state.search = els.search.value.trim();
    state.page = 1;
    load();
  }, 260);
  els.search?.addEventListener('input', doSearch);

  on(els.filters, 'change', '.js-dt-filter', (e, el) => {
    state.filters[el.dataset.key] = el.value;
    state.page = 1;
    load();
  });

  // sort + row click + actions + selection (delegated)
  on(els.body, 'click', 'th.is-sortable', (e, th) => {
    const key = th.dataset.key;
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.sort = key;
      state.dir = 'asc';
    }
    load();
  });
  on(els.body, 'click', '.js-dt-row', (e, tr) => {
    if (e.target.closest('.js-row-check, a, button')) return;
    const row = state.rows.find((r) => String(rowKey(r)) === tr.dataset.k);
    if (row) onRowClick?.(row);
  });
  on(els.body, 'change', '.js-row-check', (e, cb) => {
    if (cb.value === '__all__') {
      state.rows.forEach((r) => (cb.checked ? state.selected.add(String(rowKey(r))) : state.selected.delete(String(rowKey(r)))));
    } else {
      cb.checked ? state.selected.add(cb.value) : state.selected.delete(cb.value);
    }
    renderBody();
    renderBulk();
  });

  on(els.footer, 'click', '.js-page', (e, btn) => {
    state.page = Number(btn.dataset.page);
    load();
  });
  on(els.footer, 'change', '.js-page-size', (e, sel) => {
    state.pageSize = Number(sel.value);
    state.page = 1;
    load();
  });

  async function load() {
    state.loading = true;
    renderBody();
    try {
      const res = await fetcher({
        search: state.search,
        sort: state.sort,
        dir: state.dir,
        page: state.page,
        pageSize: state.pageSize,
        ...state.filters,
      });
      state.rows = res.data || [];
      state.total = res.total ?? state.rows.length;
      state.totalPages = res.totalPages ?? 1;
      state.page = res.page ?? state.page;
      state.extra = res;
      state.loading = false;
      // drop selections no longer present
      const present = new Set(state.rows.map((r) => String(rowKey(r))));
      [...state.selected].forEach((id) => present.has(id) || state.selected.delete(id));
    } catch (err) {
      state.loading = false;
      state.rows = [];
      els.body.innerHTML = `<div class="loading-block"><span style="color:var(--danger-solid)">${icon('alert-circle', { size: 28 })}</span>
        <p class="text-danger">${escapeHtml(err?.data?.message || err.message || 'Failed to load data')}</p>
        <button class="btn btn--sm js-dt-retry">Retry</button></div>`;
      els.body.querySelector('.js-dt-retry')?.addEventListener('click', load);
      els.footer.innerHTML = '';
      opts.onError?.(err);
      return;
    }
    renderBody();
    renderFooter();
    renderBulk();
    opts.onLoad?.(state.extra);
  }

  function renderBody() {
    if (state.loading) {
      els.body.innerHTML = tableSkeleton(columns.length + (selectable ? 1 : 0), 6);
      return;
    }
    if (!state.rows.length) {
      els.body.innerHTML = `<div>${renderEmptyState({
        icon: emptyState.icon || 'inbox',
        title: emptyState.title || 'Nothing here yet',
        message: emptyState.message || (state.search || Object.values(state.filters).some(Boolean) ? 'No results match your filters.' : ''),
        action: !state.search && emptyState.action ? emptyState.action : null,
      })}</div>`;
      wireEmptyAction();
      return;
    }
    const allChecked = state.rows.every((r) => state.selected.has(String(rowKey(r))));
    const thead = `<thead><tr>
      ${selectable ? `<th style="width:36px"><label class="check"><input type="checkbox" class="js-row-check" value="__all__" ${allChecked ? 'checked' : ''} aria-label="Select all"></label></th>` : ''}
      ${columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''} ${c.sortable ? 'is-sortable' : ''}" data-key="${c.key}" ${c.sortable ? `aria-sort="${state.sort === c.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"` : ''} ${c.width ? `style="width:${c.width}"` : ''}>
        ${escapeHtml(c.label)}${c.sortable ? `<span class="sort-ind">${icon(state.sort === c.key && state.dir === 'desc' ? 'arrow-down' : 'arrow-up', { size: 12 })}</span>` : ''}</th>`).join('')}
      ${rowActions ? '<th style="width:48px"></th>' : ''}
    </tr></thead>`;

    const rows = state.rows
      .map((row) => {
        const k = String(rowKey(row));
        const checked = state.selected.has(k);
        const actions = rowActions?.(row) || [];
        return `<tr class="js-dt-row ${checked ? 'is-selected' : ''} ${onRowClick ? '' : ''}" data-k="${escapeHtml(k)}" ${onRowClick ? 'style="cursor:pointer"' : ''}>
          ${selectable ? `<td><label class="check"><input type="checkbox" class="js-row-check" value="${escapeHtml(k)}" ${checked ? 'checked' : ''} aria-label="Select row"></label></td>` : ''}
          ${columns.map((c) => {
            const content = c.render ? c.render(row) : escapeHtml(row[c.key] ?? '—');
            const val = content instanceof Node ? content.outerHTML : content;
            return `<td class="${c.align === 'right' ? 'num' : ''}" data-label="${escapeHtml(c.label)}">${val}</td>`;
          }).join('')}
          ${rowActions ? `<td class="actions">${actions.length ? `<div class="js-dt-menu-wrap">
            <button class="btn btn--icon btn--ghost btn--sm js-dt-menu" aria-label="Row actions">${icon('more-vertical', { size: 16 })}</button>
          </div>` : ''}</td>` : ''}
        </tr>`;
      })
      .join('');

    els.body.innerHTML = `<table class="table ${stacked ? 'is-stacked' : ''}">${thead}<tbody>${rows}</tbody></table>`;
    wireRowMenus();
  }

  function wireRowMenus() {
    els.body.querySelectorAll('.js-dt-menu').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = btn.closest('.js-dt-row');
        const row = state.rows.find((r) => String(rowKey(r)) === tr.dataset.k);
        const actions = rowActions(row) || [];
        import('./dropdown.js').then(({ openMenu }) => {
          openMenu(btn, actions.map((a) => ({
            label: a.label,
            icon: a.icon,
            danger: a.danger,
            disabled: a.disabled,
            onSelect: () => a.onClick?.(row),
          })));
        });
      });
    });
  }

  function wireEmptyAction() {
    const btn = els.body.querySelector('.js-empty-action');
    if (btn && emptyState.action) btn.addEventListener('click', emptyState.action.onClick);
  }

  function renderFooter() {
    els.footer.innerHTML = `
      <span>Showing <strong>${state.rows.length}</strong> of <strong>${state.total}</strong></span>
      <div class="cluster">
        <select class="select js-page-size" style="height:32px;width:auto" aria-label="Rows per page">
          ${config.pagination.pageSizeOptions.map((n) => `<option value="${n}" ${n === state.pageSize ? 'selected' : ''}>${n} / page</option>`).join('')}
        </select>
        ${renderPagination(state.page, state.totalPages)}
      </div>`;
  }

  function renderBulk() {
    if (!selectable || !state.selected.size) {
      els.bulk.hidden = true;
      els.bulk.innerHTML = '';
      opts.onSelectionChange?.([]);
      return;
    }
    els.bulk.hidden = false;
    els.bulk.className = 'js-dt-bulk alert alert--info';
    els.bulk.style.marginBottom = 'var(--sp-3)';
    const actions = opts.bulkActions?.([...state.selected]) || [];
    els.bulk.innerHTML = `<div class="alert__body row-between">
      <span><strong>${state.selected.size}</strong> selected</span>
      <div class="cluster">
        ${actions.map((a, i) => `<button class="btn btn--sm ${a.danger ? 'btn--danger' : ''} js-bulk" data-i="${i}">${escapeHtml(a.label)}</button>`).join('')}
        <button class="btn btn--sm btn--ghost js-bulk-clear">Clear</button>
      </div>
    </div>`;
    els.bulk.querySelectorAll('.js-bulk').forEach((b) =>
      b.addEventListener('click', () => actions[Number(b.dataset.i)].onClick([...state.selected])),
    );
    els.bulk.querySelector('.js-bulk-clear').addEventListener('click', () => {
      state.selected.clear();
      renderBody();
      renderBulk();
    });
    opts.onSelectionChange?.([...state.selected]);
  }

  load();

  /* live: when data changes (this tab or another), pull the newest rows to the
     top - but only on the default view (page 1, no active search) and while no
     modal is open, so we never disrupt someone mid-task. */
  const liveReload = debounce(() => {
    if (!mount.isConnected) { offLive.forEach((off) => off()); return; }
    if (state.page !== 1 || state.search) return;
    if (document.querySelector('.overlay')) return;
    if (document.visibilityState === 'hidden') return;
    load();
  }, 900);
  const offLive = [
    bus.on('db:changed', liveReload),
    bus.on('db:external-change', liveReload),
  ];

  return {
    reload: load,
    getState: () => ({ ...state, selected: [...state.selected], extra: state.extra }),
    setFilter: (key, value) => {
      state.filters[key] = value;
      state.page = 1;
      const sel = els.filters.querySelector(`[data-key="${key}"]`);
      if (sel) sel.value = value;
      load();
    },
    setSearch: (v) => {
      state.search = v;
      if (els.search) els.search.value = v;
      state.page = 1;
      load();
    },
    selection: () => [...state.selected],
    clearSelection: () => {
      state.selected.clear();
      renderBody();
      renderBulk();
    },
    lastResponse: () => state.extra,
    destroy: () => {
      offLive.forEach((off) => off());
      mount.innerHTML = '';
    },
  };
}
