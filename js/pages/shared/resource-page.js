/**
 * resource-page.js - a full list + create/edit/archive page from a config.
 * Used by categories, brands, suppliers, customers, taxes, discounts, expenses.
 */
import { pageShell } from './page-kit.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { can } from '../../core/rbac.js';
import { exportCsv } from '../../utils/csv.js';

/**
 * config: {
 *   title, subtitle, entityLabel,
 *   service: { list, create, update, archive, restore },
 *   columns: [...data-table columns],
 *   filters: [...],
 *   formFields: (row|null) => [...form fields],
 *   toForm: (row) => values, fromForm: (values) => payload,
 *   perms: { create, edit, archive },
 *   searchPlaceholder, emptyState, exportColumns,
 *   rowActionsExtra: (row, ctx) => [...],
 *   canArchive: (row) => bool
 * }
 */
export function resourcePage(mount, config) {
  const {
    title, subtitle, entityLabel, service, columns, filters = [],
    formFields, toForm = (r) => r || {}, fromForm = (v) => v, perms = {},
    searchPlaceholder, emptyState = {}, exportColumns, rowActionsExtra,
    canArchive = () => true, modalSize = 'md',
  } = config;

  let table;
  const shell = pageShell(mount, {
    title,
    subtitle,
    actions: [
      exportColumns && { label: 'Export CSV', icon: 'download', variant: 'outline', onClick: doExport },
      perms.create && can(perms.create) && { label: `New ${entityLabel}`, icon: 'plus', variant: 'primary', onClick: () => openForm(null) },
    ].filter(Boolean),
  });

  table = createDataTable(shell.body, {
    columns,
    filters,
    searchPlaceholder: searchPlaceholder || `Search ${entityLabel.toLowerCase()}s…`,
    emptyState: {
      icon: emptyState.icon || 'inbox',
      title: emptyState.title || `No ${entityLabel.toLowerCase()}s yet`,
      message: emptyState.message,
      action: perms.create && can(perms.create) ? { label: `New ${entityLabel}`, icon: 'plus', onClick: () => openForm(null) } : null,
    },
    fetcher: (params) => service.list(params),
    onRowClick: config.onRowClick,
    rowActions: (row) => {
      const acts = [];
      if (perms.edit && can(perms.edit) && !row.archivedAt) acts.push({ label: 'Edit', icon: 'edit', onClick: () => openForm(row) });
      if (rowActionsExtra) acts.push(...rowActionsExtra(row, { reload: () => table.reload() }));
      if (perms.archive && can(perms.archive)) {
        if (row.archivedAt) acts.push({ label: 'Restore', icon: 'rotate-ccw', onClick: () => doRestore(row) });
        else if (canArchive(row)) acts.push({ label: 'Archive', icon: 'trash', danger: true, onClick: () => doArchive(row) });
      }
      return acts;
    },
  });

  async function openForm(row) {
    const isEdit = !!row;
    const m = openModal({
      title: isEdit ? `Edit ${entityLabel}` : `New ${entityLabel}`,
      size: modalSize,
      body: '<div></div>',
    });
    let full = row;
    if (isEdit && service.get) {
      try {
        full = await service.get(row.id);
      } catch {
        full = row;
      }
    }
    createForm(m.$('.modal__body'), {
      fields: formFields(full),
      values: toForm(full),
      submitLabel: isEdit ? 'Save changes' : `Create ${entityLabel}`,
      onCancel: () => m.close(),
      onSubmit: async (values) => {
        const payload = fromForm(values, full);
        if (isEdit) await service.update(row.id, payload);
        else await service.create(payload);
        m.close();
        toast.success(`${entityLabel} ${isEdit ? 'updated' : 'created'}`);
        table.reload();
      },
    });
  }

  async function doArchive(row) {
    const ok = await confirmDialog({
      title: `Archive this ${entityLabel.toLowerCase()}?`,
      message: `"${row.name || row.reference || row.description}" will be hidden from active lists. Historical records that reference it stay intact and you can restore it later.`,
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!ok) return;
    try {
      await service.archive(row.id);
      toast.success(`${entityLabel} archived`);
      table.reload();
    } catch (err) {
      toast.fromError(err);
    }
  }

  async function doRestore(row) {
    try {
      await service.restore(row.id);
      toast.success(`${entityLabel} restored`);
      table.reload();
    } catch (err) {
      toast.fromError(err);
    }
  }

  async function doExport() {
    try {
      const res = await service.list({ pageSize: 'all' });
      exportCsv(`${title.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}`, res.data || [], exportColumns);
      toast.success('Export ready');
    } catch (err) {
      toast.fromError(err);
    }
  }

  return { table, reload: () => table.reload(), openForm };
}
