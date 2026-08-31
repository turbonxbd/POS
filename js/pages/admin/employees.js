/**
 * employees.js - staff accounts + roles & permissions.
 */
import { pageShell, statusBadge } from '../shared/page-kit.js';
import { createTabs } from '../../components/tabs.js';
import { createDataTable } from '../../components/data-table.js';
import { openModal } from '../../components/modal.js';
import { createForm } from '../../components/form.js';
import { confirmDialog } from '../../components/confirm.js';
import { toast } from '../../components/toast.js';
import { escapeHtml } from '../../utils/dom.js';
import { fmtDate, fmtRelative } from '../../utils/date.js';
import { initials } from '../../utils/format.js';
import { PERMISSION_GROUPS } from '../../data/permissions.js';
import employeeService from '../../services/employee-service.js';
import branchService from '../../services/branch-service.js';
import { can } from '../../core/rbac.js';

export default async function employeesPage(ctx, mount) {
  const [rolesRes, branchRes] = await Promise.all([
    employeeService.getRoles(),
    branchService.getBranches({ pageSize: 'all' }),
  ]);
  const roles = rolesRes.data || rolesRes;
  const branches = branchRes.data || branchRes;

  const shell = pageShell(mount, {
    title: 'Employees',
    subtitle: 'Staff accounts, roles, and per-user permission overrides.',
  });

  createTabs(shell.body, {
    tabs: [
      { id: 'staff', label: 'Staff', render: (el) => renderStaff(el) },
      can('roles.manage') && { id: 'roles', label: `Roles (${roles.length})`, render: (el) => renderRoles(el) },
    ].filter(Boolean),
  });

  function renderStaff(el) {
    const host = document.createElement('div');
    el.appendChild(host);
    const table = createDataTable(host, {
      columns: [
        { key: 'name', label: 'Employee', sortable: true, render: (r) => `<div class="cell-product"><span class="avatar avatar--sm">${escapeHtml(initials(r.name))}</span><div class="cell-product__meta"><strong>${escapeHtml(r.name)}</strong><span>${escapeHtml(r.email)}</span></div></div>` },
        { key: 'roleName', label: 'Role', sortable: true, render: (r) => `<span class="badge badge--brand">${escapeHtml(r.roleName)}</span>` },
        { key: 'branchIds', label: 'Branches', render: (r) => escapeHtml(branches.filter((b) => r.branchIds?.includes(b.id)).map((b) => b.name).join(', ') || 'All') },
        { key: 'joinDate', label: 'Joined', sortable: true, render: (r) => fmtDate(r.joinDate) },
        { key: 'lastLoginAt', label: 'Last login', render: (r) => r.lastLoginAt ? fmtRelative(r.lastLoginAt) : 'Never' },
        { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
      ],
      filters: [
        { key: 'roleId', label: 'Role', options: roles.map((r) => ({ value: r.id, label: r.name })) },
        { key: 'status', label: 'Status', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
      ],
      searchPlaceholder: 'Search name or email…',
      stacked: true,
      toolbarExtra: can('employees.manage') ? actionBtn('New Employee', () => openForm(null, table)) : null,
      emptyState: { icon: 'user', title: 'No employees' },
      fetcher: (params) => employeeService.getEmployees(params),
      rowActions: (row) => can('employees.manage') ? [
        { label: 'Edit', icon: 'edit', onClick: () => openForm(row, table) },
        { label: 'Permissions', icon: 'shield', onClick: () => openPermissions(row, table) },
        row.status === 'active'
          ? { label: 'Deactivate', icon: 'x', danger: true, onClick: () => setStatus(row, table) }
          : { label: 'Reactivate', icon: 'check', onClick: () => reactivate(row, table) },
      ] : [],
    });
  }

  function openForm(row, table) {
    const isEdit = !!row;
    const m = openModal({ title: isEdit ? `Edit ${row.name}` : 'New Employee', size: 'md', body: '<div></div>' });
    createForm(m.$('.modal__body'), {
      fields: [
        { name: 'name', label: 'Full name', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true, disabled: isEdit },
        { name: 'phone', label: 'Phone', type: 'tel' },
        { name: 'roleId', label: 'Role', type: 'select', required: true, options: roles.map((r) => ({ value: r.id, label: r.name })) },
        { name: 'branchIds', label: 'Assigned branches', type: 'multiselect', options: branches.map((b) => ({ value: b.id, label: b.name })), colSpan: 'full' },
        { name: 'joinDate', label: 'Join date', type: 'date' },
        { name: 'password', label: isEdit ? 'Reset password' : 'Password', type: 'password', required: !isEdit, hint: isEdit ? 'Leave blank to keep current' : 'At least 8 characters', rules: isEdit ? [] : [['minLength', 8]] },
        { name: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], value: 'active' },
      ],
      values: isEdit ? { ...row, joinDate: row.joinDate?.slice(0, 10) } : { joinDate: new Date().toISOString().slice(0, 10) },
      submitLabel: isEdit ? 'Save' : 'Create employee',
      onCancel: () => m.close(),
      onSubmit: async (v) => {
        if (isEdit) await employeeService.updateEmployee(row.id, v);
        else await employeeService.createEmployee(v);
        m.close();
        toast.success(isEdit ? 'Employee updated' : 'Employee created');
        table.reload();
      },
    });
  }

  function openPermissions(row, table) {
    const grants = new Set(row.permissionGrants || []);
    const revokes = new Set(row.permissionRevokes || []);
    const role = roles.find((r) => r.id === row.roleId);
    const rolePerms = new Set(role?.permissions || []);
    const isSuper = rolePerms.has('*');
    const m = openModal({
      title: `Permissions — ${row.name}`, size: 'lg',
      body: `<p class="text-sm muted">Role <strong>${escapeHtml(row.roleName)}</strong> grants a baseline. Toggle overrides below.</p>
        ${isSuper ? '<div class="alert alert--info" style="margin-top:var(--sp-3)"><div class="alert__body">This role has full access (super permission). Overrides are ignored.</div></div>' : ''}
        <div class="stack" style="--stack-gap:var(--sp-4);margin-top:var(--sp-4)">
          ${PERMISSION_GROUPS.map((g) => `<div>
            <div class="form-section-title">${escapeHtml(g.label)}</div>
            <div class="field-grid">${g.permissions.map(([p, label]) => {
              const fromRole = rolePerms.has(p);
              const effective = isSuper || (fromRole && !revokes.has(p)) || grants.has(p);
              return `<label class="check" style="align-items:flex-start"><input type="checkbox" data-p="${p}" ${effective ? 'checked' : ''} ${isSuper ? 'disabled' : ''}>
                <span>${escapeHtml(label)}<br><span class="text-xs muted">${fromRole ? 'from role' : 'not in role'}</span></span></label>`;
            }).join('')}</div>
          </div>`).join('')}
        </div>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--primary js-save">Save overrides</button>`,
    });
    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-save').addEventListener('click', async () => {
      const g = [];
      const rv = [];
      m.$$('input[data-p]').forEach((cb) => {
        const p = cb.dataset.p;
        const inRole = rolePerms.has(p);
        if (cb.checked && !inRole) g.push(p);
        if (!cb.checked && inRole) rv.push(p);
      });
      m.setBusy(true);
      try {
        await employeeService.updateEmployee(row.id, { permissionGrants: g, permissionRevokes: rv });
        m.close();
        toast.success('Permissions updated');
        table.reload();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }

  async function setStatus(row, table) {
    if (!(await confirmDialog({ title: `Deactivate ${row.name}?`, message: 'They will no longer be able to sign in. History is kept.', danger: true, confirmLabel: 'Deactivate' }))) return;
    try {
      await employeeService.deactivateEmployee(row.id);
      toast.success('Employee deactivated');
      table.reload();
    } catch (err) {
      toast.fromError(err);
    }
  }
  async function reactivate(row, table) {
    await employeeService.restoreEmployee(row.id);
    toast.success('Employee reactivated');
    table.reload();
  }

  function renderRoles(el) {
    const refresh = () => renderRoles(el);
    el.innerHTML = `<div class="row-between" style="margin-bottom:var(--sp-4)">
      <p class="muted text-sm">Built-in roles are locked; duplicate one to customise.</p>
      <button class="btn btn--primary btn--sm js-new-role">New Role</button></div>
      <div class="field-grid">${roles.map((r) => `<div class="card card--pad">
        <div class="row-between"><h4>${escapeHtml(r.name)}</h4>${r.system ? '<span class="badge badge--neutral">Built-in</span>' : ''}</div>
        <p class="muted text-sm" style="margin:var(--sp-1) 0 var(--sp-2)">${escapeHtml(r.description || '')}</p>
        <p class="text-xs muted">${r.permissions?.includes('*') ? 'Full access' : (r.permissions?.length || 0) + ' permissions'} · ${r.userCount || 0} users · ${r.discountLimitPct}% discount limit</p>
        <div class="row" style="margin-top:var(--sp-3)">
          <button class="btn btn--sm btn--outline js-edit-role" data-id="${r.id}">${r.system ? 'View' : 'Edit'}</button>
          ${!r.system ? `<button class="btn btn--sm btn--ghost js-del-role" data-id="${r.id}" style="color:var(--danger-fg)">Delete</button>` : ''}
        </div>
      </div>`).join('')}</div>`;

    el.querySelector('.js-new-role').addEventListener('click', () => editRole(null, refresh));
    el.querySelectorAll('.js-edit-role').forEach((b) => b.addEventListener('click', () => editRole(roles.find((r) => r.id === b.dataset.id), refresh)));
    el.querySelectorAll('.js-del-role').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Delete this role?', danger: true, confirmLabel: 'Delete' }))) return;
      try {
        await employeeService.deleteRole(b.dataset.id);
        toast.success('Role deleted');
        location.reload();
      } catch (err) {
        toast.fromError(err);
      }
    }));
  }

  function editRole(role, refresh) {
    const perms = new Set(role?.permissions || []);
    const readOnly = role?.system;
    const m = openModal({
      title: role ? role.name : 'New Role', size: 'lg',
      body: `<div class="field-grid" style="margin-bottom:var(--sp-4)">
          <label class="field"><span class="label">Name</span><input class="input js-name" value="${escapeHtml(role?.name || '')}" ${readOnly ? 'disabled' : ''}></label>
          <label class="field"><span class="label">Discount limit (%)</span><input class="input js-limit" type="number" min="0" max="100" value="${role?.discountLimitPct ?? 0}"></label>
          <label class="field" style="grid-column:1/-1"><span class="label">Description</span><input class="input js-desc" value="${escapeHtml(role?.description || '')}"></label>
        </div>
        <div class="stack" style="--stack-gap:var(--sp-3)">
        ${PERMISSION_GROUPS.map((g) => `<div><div class="form-section-title">${escapeHtml(g.label)}</div>
          <div class="field-grid">${g.permissions.map(([p, label]) => `<label class="check"><input type="checkbox" data-p="${p}" ${perms.has(p) || perms.has('*') ? 'checked' : ''} ${readOnly ? 'disabled' : ''}> ${escapeHtml(label)}</label>`).join('')}</div></div>`).join('')}
        </div>`,
      footer: readOnly
        ? `<button class="btn btn--outline js-dup">Duplicate to edit</button><button class="btn btn--primary js-modal-close">Close</button>`
        : `<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--primary js-save">${role ? 'Save' : 'Create role'}</button>`,
    });
    if (readOnly) {
      m.$('.js-dup').addEventListener('click', async () => {
        const created = await employeeService.createRole({ name: role.name + ' (Copy)', description: role.description, permissions: [...perms].filter((x) => x !== '*'), discountLimitPct: role.discountLimitPct });
        m.close();
        toast.success('Role duplicated');
        location.reload();
      });
      return;
    }
    m.$('.js-cancel').addEventListener('click', () => m.close());
    m.$('.js-save').addEventListener('click', async () => {
      const payload = {
        name: m.$('.js-name').value.trim(),
        description: m.$('.js-desc').value.trim(),
        discountLimitPct: Number(m.$('.js-limit').value) || 0,
        permissions: m.$$('input[data-p]:checked').map((c) => c.dataset.p),
      };
      m.setBusy(true);
      try {
        if (role) await employeeService.updateRole(role.id, payload);
        else await employeeService.createRole(payload);
        m.close();
        toast.success('Role saved');
        location.reload();
      } catch (err) {
        m.setBusy(false);
        toast.fromError(err);
      }
    });
  }
}

function actionBtn(label, onClick) {
  const b = document.createElement('button');
  b.className = 'btn btn--primary btn--sm';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
