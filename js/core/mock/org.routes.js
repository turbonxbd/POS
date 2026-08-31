/**
 * org.routes.js - branches, business settings, notifications, audit log,
 * and data export / backup.
 */

import db from '../db.js';
import { HttpError } from '../http.js';
import { tdb, currentMerchantId, isLegacyMode } from './scope.js';
import { ok, created, notFound, badRequest, conflict, applyListQuery } from './router.js';
import { audit } from './helpers.js';
import { getActor, isPlatformActor } from './context.js';
import { subscriptionFor, branchLimitFor, extraBranchPrice } from './platform-helpers.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';

export default function register(router) {
  /* ------------------------------------------------------------- branches */
  router.get('/branches', ({ query }) => {
    let rows = tdb('branches').all();
    if (query.includeArchived !== 'true') rows = rows.filter((b) => !b.archivedAt);
    const decorated = rows.map((b) => ({
      ...b,
      employeeCount: tdb('employees').count((e) => e.branchIds?.includes(b.id)),
      productsInStock: tdb('stock').count((s) => s.branchId === b.id && s.quantity > 0),
      openRegister: tdb('register_sessions').exists((s) => s.branchId === b.id && s.status === 'open'),
    }));
    return ok(applyListQuery(decorated, query, { searchable: ['name', 'code', 'address'], sortable: ['name', 'code'], defaultSort: 'name', defaultDir: 'asc', pageSize: query.pageSize || 'all' }));
  });

  router.post('/branches', ({ body }) => {
    if (!body?.name) badRequest('Branch name is required', { name: 'Required' });
    // Plan entitlement: additional branches beyond the plan's included count
    // must be purchased first (see POST /billing/branch-request).
    if (!isLegacyMode() && !isPlatformActor() && !body.__branchPurchase) {
      const mid = currentMerchantId();
      const activeBranches = tdb('branches').count((b) => !b.archivedAt);
      const limit = branchLimitFor(mid);
      if (activeBranches >= limit) {
        const sub = subscriptionFor(mid);
        throw new HttpError(402, 'This plan\'s branches are all in use. Purchase an additional branch to add another.', {
          message: 'Additional branch required',
          requiresPurchase: true,
          price: extraBranchPrice(sub),
          included: sub?.includedBranches ?? 1,
          used: activeBranches,
        });
      }
    }
    const code = String(body.code || body.name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'BR';
    if (tdb('branches').exists((b) => b.code === code)) conflict('That branch code is already in use.');
    return db.tx(() => {
      const row = tdb('branches').insert({
        id: uuid(), name: String(body.name).trim(), code,
        address: body.address || '', phone: body.phone || '', email: body.email || '',
        isDefault: tdb('branches').count() === 0, status: 'active',
      });
      audit('create', 'branch', row.id, { after: row });
      return created(row);
    });
  });

  router.patch('/branches/:id', ({ params, body }) => {
    const existing = tdb('branches').get(params.id);
    if (!existing) notFound('Branch');
    return db.tx(() => {
      const row = tdb('branches').update(params.id, {
        name: body.name ?? existing.name, address: body.address ?? existing.address,
        phone: body.phone ?? existing.phone, email: body.email ?? existing.email,
        status: body.status ?? existing.status,
      });
      audit('update', 'branch', row.id, { before: existing, after: row });
      return ok(row);
    });
  });

  router.del('/branches/:id', ({ params }) => {
    const existing = tdb('branches').get(params.id);
    if (!existing) notFound('Branch');
    if (existing.isDefault) conflict('The default branch cannot be archived.');
    if (tdb('stock').exists((s) => s.branchId === params.id && s.quantity > 0)) {
      conflict('Transfer out remaining stock before archiving this branch.');
    }
    return db.tx(() => {
      const row = tdb('branches').update(params.id, { archivedAt: now(), status: 'archived' });
      audit('archive', 'branch', row.id, { before: existing });
      return ok({ archived: true, id: row.id });
    });
  });

  /* ------------------------------------------------------------- settings */
  const settingsId = () => 'settings_' + (currentMerchantId() || 'singleton');

  router.get('/settings', () => {
    const doc = tdb('settings').get(settingsId());
    return ok(doc || { id: settingsId() });
  });

  // business fields that also live on the `businesses` row + drive the merchant name
  const BUSINESS_FIELDS = ['name', 'legalName', 'address', 'phone', 'email', 'website', 'vatNo', 'currency', 'currencySymbol', 'logoId'];

  router.put('/settings', ({ body }) => {
    return db.tx(() => {
      const id = settingsId();
      const existing = tdb('settings').get(id);
      const merged = deepMerge(existing || { id }, body || {});
      merged.id = id;
      const row = tdb('settings').upsert(merged);

      // Keep the merchant's identity in ONE consistent state: mirror
      // settings.business onto the `businesses` row (read by every panel via
      // /auth/me) and the `merchants` row (read by the Super Admin panel).
      const bp = (body && body.business) || {};
      const bizPatch = {};
      for (const k of BUSINESS_FIELDS) if (bp[k] !== undefined) bizPatch[k] = bp[k];
      if (Object.keys(bizPatch).length) {
        const biz = tdb('businesses').all()[0];
        if (biz) {
          const nextBiz = tdb('businesses').update(biz.id, bizPatch);
          const mid = currentMerchantId();
          if (mid && bizPatch.name != null) {
            const m = db.collection('merchants').get(mid);
            if (m && m.name !== nextBiz.name) db.collection('merchants').update(mid, { name: nextBiz.name });
          }
          audit('settings', 'business', biz.id, { after: nextBiz });
        }
      }

      audit('settings', 'settings', id, { before: existing, after: row });
      return ok(row);
    });
  });

  /* -------------------------------------------------------- notifications */
  router.get('/notifications', ({ query }) => {
    let rows = tdb('notifications').all().sort((a, b) => new Date(b.at) - new Date(a.at));
    if (query.unread === 'true') rows = rows.filter((n) => !n.read);
    if (query.type && query.type !== 'all') rows = rows.filter((n) => n.type === query.type);
    const unreadCount = tdb('notifications').count((n) => !n.read);
    const result = applyListQuery(rows, query, { sortable: ['at'], defaultSort: 'at', defaultDir: 'desc' });
    return ok({ ...result, unreadCount });
  });

  router.post('/notifications/:id/read', ({ params }) => {
    const n = tdb('notifications').get(params.id);
    if (!n) notFound('Notification');
    tdb('notifications').update(params.id, { read: true, readAt: now() });
    return ok({ ok: true });
  });

  router.post('/notifications/read-all', () => db.tx(() => {
    tdb('notifications').find((n) => !n.read).forEach((n) => tdb('notifications').update(n.id, { read: true, readAt: now() }));
    return ok({ ok: true });
  }));

  router.del('/notifications/:id', ({ params }) => {
    tdb('notifications').remove(params.id);
    return ok({ deleted: true });
  });

  /* ----------------------------------------------------------- audit logs */
  router.get('/audit-logs', ({ query }) => {
    const mid = currentMerchantId();
    let rows = db.collection('audit_logs').all();
    if (!isLegacyMode() && !isPlatformActor()) rows = rows.filter((l) => l.merchantId === mid);
    if (query.entity && query.entity !== 'all') rows = rows.filter((l) => l.entity === query.entity);
    if (query.action && query.action !== 'all') rows = rows.filter((l) => l.action === query.action);
    if (query.actorId && query.actorId !== 'all') rows = rows.filter((l) => l.actorId === query.actorId);
    if (query.branchId && query.branchId !== 'all') rows = rows.filter((l) => (l.meta?.branchId || l.branchId) === query.branchId);
    if (query.from || query.to) {
      const from = query.from ? new Date(query.from).getTime() : -Infinity;
      const to = query.to ? new Date(query.to).getTime() : Infinity;
      rows = rows.filter((l) => { const t = new Date(l.at).getTime(); return t >= from && t <= to; });
    }
    return ok(applyListQuery(rows, query, {
      searchable: ['actorName', 'entity', 'action', 'entityId'],
      sortable: ['at', 'action', 'entity'], defaultSort: 'at', defaultDir: 'desc',
    }));
  });

  /* -------------------------------------------------------------- backup */
  router.get('/backup/export', () => ok(db.export()));
  router.get('/backup/stats', () => ok(db.stats()));

  router.post('/backup/import', ({ body }) => {
    if (!body || !body.data || !body.data.collections) badRequest('Invalid backup file');
    db.import(body.data, { merge: body.merge === true });
    audit('settings', 'backup', null, { meta: { action: 'import', merge: !!body.merge } });
    return ok({ ok: true, stats: db.stats() });
  });

  router.post('/backup/reset', ({ body }) => {
    audit('settings', 'backup', null, { meta: { action: 'reset', keepUsers: !!body?.keepUsers } });
    db.import({ __v: 1, meta: {}, collections: {} }, { merge: false });
    return ok({ ok: true, actor: getActor()?.id || null });
  });
}

/* ------------------------------------------------------------ helpers */
function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
