/**
 * people.routes.js - customers, employees (users), roles & permissions.
 */

import db from '../db.js';
import { tdb, currentMerchantId, isLegacyMode } from './scope.js';
import { ok, created, notFound, badRequest, conflict, applyListQuery } from './router.js';
import { defineResource } from './resource.js';
import { audit } from './helpers.js';
import { getActor } from './context.js';
import { hashPassword } from '../../utils/crypto.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';

export default function register(router) {
  /* ------------------------------------------------------------ customers */
  defineResource(router, {
    base: '/customers',
    collection: 'customers',
    entity: 'customer',
    listOptions: {
      searchable: ['name', 'phone', 'email'],
      sortable: ['name', 'totalPurchases', 'outstandingBalance', 'loyaltyPoints', 'lastPurchaseAt', 'createdAt'],
      defaultSort: 'createdAt', defaultDir: 'desc',
      filters: { status: 'status' },
    },
    beforeCreate: (b) => {
      const phone = String(b.phone || '').trim();
      if (phone && tdb('customers').exists((c) => c.phone === phone)) {
        conflict('A customer with this phone number already exists.');
      }
      return {
        name: String(b.name || '').trim() || 'Unnamed Customer',
        phone, email: b.email || '', address: b.address || '',
        district: b.district || '', upazila: b.upazila || '',
        openingBalance: Math.trunc(b.openingBalance || 0),
        outstandingBalance: Math.trunc(b.openingBalance || 0),
        totalOrders: 0, totalPurchases: 0, loyaltyPoints: Number(b.loyaltyPoints) || 0,
        note: b.note || '', status: b.status || 'active', lastPurchaseAt: null,
      };
    },
    beforeUpdate: (patch, existing) => {
      if (patch.phone && patch.phone !== existing.phone) {
        if (tdb('customers').exists((c) => c.id !== existing.id && c.phone === patch.phone)) {
          conflict('Another customer already uses this phone number.');
        }
      }
      return patch;
    },
  });

  router.get('/customers/:id/history', ({ params }) => {
    const customer = tdb('customers').get(params.id);
    if (!customer) notFound('Customer');
    const sales = tdb('sales').find({ customerId: params.id }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const returns = tdb('sale_returns').find({ customerId: params.id });
    const ledger = tdb('customer_ledger').find({ customerId: params.id });
    return ok({ customer, sales, returns, ledger });
  });

  router.post('/customers/:id/balance', ({ params, body }) => {
    const customer = tdb('customers').get(params.id);
    if (!customer) notFound('Customer');
    const delta = Math.trunc(body?.amount || 0);
    const type = body?.type === 'payment' ? -Math.abs(delta) : delta;
    return db.tx(() => {
      tdb('customer_ledger').insert({
        id: uuid(), customerId: params.id, type: body?.type || 'adjustment', refType: 'manual', refId: null,
        amount: Math.abs(delta), balanceDelta: type, note: body?.note || '', at: now(),
      });
      const row = tdb('customers').update(params.id, (c) => ({ outstandingBalance: Math.max(0, (c.outstandingBalance || 0) + type) }));
      audit('update', 'customer', params.id, { meta: { field: 'balance', delta: type } });
      return ok(row);
    });
  });

  /* ------------------------------------------------------------ roles */
  router.get('/roles', ({ query }) => {
    const rows = db.collection('roles').all().map((r) => ({
      ...r,
      userCount: db.collection('users').count((u) => u.roleId === r.id),
    }));
    return ok(applyListQuery(rows, query, { searchable: ['name'], sortable: ['name'], defaultSort: 'name', defaultDir: 'asc', pageSize: 'all' }));
  });

  router.post('/roles', ({ body }) => {
    if (!body?.name) badRequest('Role name is required', { name: 'Required' });
    return db.tx(() => {
      const row = db.collection('roles').insert({
        id: uuid(), name: String(body.name).trim(), description: body.description || '',
        permissions: body.permissions || [], discountLimitPct: Number(body.discountLimitPct) || 0,
        system: false,
      });
      audit('create', 'role', row.id, { after: row });
      return created(row);
    });
  });

  router.patch('/roles/:id', ({ params, body }) => {
    const existing = db.collection('roles').get(params.id);
    if (!existing) notFound('Role');
    if (existing.system && body.permissions && !body.__allowSystemEdit) {
      // system roles: allow discount limit / description tweaks, guard permission wipes
      if (JSON.stringify(body.permissions) !== JSON.stringify(existing.permissions)) {
        conflict('Built-in role permissions are locked. Duplicate it to customise.');
      }
    }
    return db.tx(() => {
      const row = db.collection('roles').update(params.id, {
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        permissions: body.permissions ?? existing.permissions,
        discountLimitPct: body.discountLimitPct ?? existing.discountLimitPct,
      });
      audit('update', 'role', row.id, { before: existing, after: row });
      return ok(row);
    });
  });

  router.del('/roles/:id', ({ params }) => {
    const existing = db.collection('roles').get(params.id);
    if (!existing) notFound('Role');
    if (existing.system) conflict('Built-in roles cannot be deleted.');
    if (db.collection('users').exists((u) => u.roleId === params.id)) conflict('Reassign users before deleting this role.');
    return db.tx(() => {
      db.collection('roles').remove(params.id);
      audit('delete', 'role', params.id, { before: existing });
      return ok({ deleted: true });
    });
  });

  /* ------------------------------------------------------------ employees */
  // Employees = the current merchant's own non-platform users.
  const myUsers = () => {
    const mid = currentMerchantId();
    return db.collection('users').all().filter((u) => !u.platform && (isLegacyMode() || u.merchantId === mid));
  };
  const myUser = (id) => {
    const u = db.collection('users').get(id);
    const mid = currentMerchantId();
    if (!u || u.platform || (!isLegacyMode() && u.merchantId !== mid)) return null;
    return u;
  };

  router.get('/employees', ({ query }) => {
    const rows = myUsers().filter((u) => query.includeArchived === 'true' || !u.archivedAt).map((u) => {
      const emp = tdb('employees').findOne({ userId: u.id }) || {};
      const role = db.collection('roles').get(u.roleId);
      return {
        id: u.id, name: u.name, email: u.email, phone: u.phone || emp.phone || '',
        roleId: u.roleId, roleName: role?.name || '—', status: u.status,
        branchIds: emp.branchIds || [], joinDate: emp.joinDate || u.createdAt,
        lastLoginAt: u.lastLoginAt || null, avatar: u.avatar || null,
        permissionGrants: u.permissionGrants || [], permissionRevokes: u.permissionRevokes || [],
        archivedAt: u.archivedAt || null,
      };
    });
    let filtered = rows;
    if (query.roleId) filtered = filtered.filter((r) => r.roleId === query.roleId);
    if (query.branchId) filtered = filtered.filter((r) => r.branchIds.includes(query.branchId));
    if (query.status && query.status !== 'all') filtered = filtered.filter((r) => r.status === query.status);
    return ok(applyListQuery(filtered, query, {
      searchable: ['name', 'email', 'phone'], sortable: ['name', 'roleName', 'joinDate', 'lastLoginAt'],
      defaultSort: 'name', defaultDir: 'asc',
    }));
  });

  router.get('/employees/:id', ({ params }) => {
    const u = myUser(params.id);
    if (!u) notFound('Employee');
    const emp = tdb('employees').findOne({ userId: u.id }) || {};
    const salesCount = tdb('sales').count({ cashierId: u.id });
    return ok({
      id: u.id, name: u.name, email: u.email, phone: u.phone || emp.phone || '',
      roleId: u.roleId, status: u.status, branchIds: emp.branchIds || [],
      joinDate: emp.joinDate || u.createdAt, lastLoginAt: u.lastLoginAt,
      permissionGrants: u.permissionGrants || [], permissionRevokes: u.permissionRevokes || [],
      salesCount, avatar: u.avatar || null,
    });
  });

  router.post('/employees', async ({ body }) => {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!body?.name) badRequest('Name is required', { name: 'Required' });
    if (!email) badRequest('Email is required', { email: 'Required' });
    if (db.collection('users').exists((u) => u.email.toLowerCase() === email)) {
      conflict('An account with this email already exists.');
    }
    if (!body.roleId || !db.collection('roles').get(body.roleId)) badRequest('Select a valid role', { roleId: 'Required' });
    const passwordHash = await hashPassword(body.password || 'changeme123');

    return db.tx(() => {
      const user = db.collection('users').insert({
        id: uuid(), name: String(body.name).trim(), email, phone: body.phone || '',
        passwordHash, roleId: body.roleId, status: body.status || 'active',
        merchantId: isLegacyMode() ? null : currentMerchantId(),
        platform: false,
        permissionGrants: body.permissionGrants || [], permissionRevokes: body.permissionRevokes || [],
        avatar: body.avatar || null, lastLoginAt: null,
      });
      tdb('employees').insert({
        id: uuid(), userId: user.id, branchIds: body.branchIds || [], joinDate: body.joinDate || now(),
        phone: body.phone || '',
      });
      audit('create', 'employee', user.id, { after: { name: user.name, email, roleId: body.roleId } });
      return created({ id: user.id, name: user.name, email, roleId: body.roleId });
    });
  });

  router.patch('/employees/:id', async ({ params, body }) => {
    const user = myUser(params.id);
    if (!user) notFound('Employee');
    const emp = tdb('employees').findOne({ userId: user.id });
    const patch = {};
    if (body.name) patch.name = String(body.name).trim();
    if (body.phone != null) patch.phone = body.phone;
    if (body.roleId) patch.roleId = body.roleId;
    if (body.status) patch.status = body.status;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (body.permissionGrants) patch.permissionGrants = body.permissionGrants;
    if (body.permissionRevokes) patch.permissionRevokes = body.permissionRevokes;
    if (body.password) patch.passwordHash = await hashPassword(body.password);

    // Guard: don't let the last owner demote/deactivate themselves out of access
    if ((body.status === 'inactive' || body.roleId) && isLastOwner(user)) {
      conflict('You are the only Branch Owner. Assign another owner before changing this account.');
    }

    return db.tx(() => {
      const row = db.collection('users').update(user.id, patch);
      if (emp && body.branchIds) tdb('employees').update(emp.id, { branchIds: body.branchIds });
      if (emp && body.joinDate) tdb('employees').update(emp.id, { joinDate: body.joinDate });
      audit('update', 'employee', user.id, { before: { roleId: user.roleId, status: user.status }, after: patch });
      return ok({ id: row.id, name: row.name, roleId: row.roleId, status: row.status });
    });
  });

  router.del('/employees/:id', ({ params }) => {
    const user = myUser(params.id);
    if (!user) notFound('Employee');
    if (getActor()?.id === user.id) conflict('You cannot deactivate your own account.');
    if (isLastOwner(user)) conflict('Cannot deactivate the only Branch Owner.');
    return db.tx(() => {
      const row = db.collection('users').update(params.id, { status: 'inactive', archivedAt: now() });
      audit('archive', 'employee', params.id, { before: user });
      return ok({ archived: true, id: row.id });
    });
  });

  router.post('/employees/:id/restore', ({ params }) => {
    const user = myUser(params.id);
    if (!user) notFound('Employee');
    return db.tx(() => {
      const row = db.collection('users').update(params.id, { status: 'active', archivedAt: undefined });
      audit('update', 'employee', params.id, { meta: { action: 'restore' } });
      return ok({ id: row.id, status: 'active' });
    });
  });
}

function isLastOwner(user) {
  if (user.roleId !== 'role_owner') return false;
  const mid = user.merchantId;
  return db.collection('users').count(
    (u) => u.roleId === 'role_owner' && u.status === 'active' && u.merchantId === mid && !u.platform,
  ) <= 1;
}
