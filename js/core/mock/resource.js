/**
 * mock/resource.js - generic REST resource factory over a db collection.
 * Handles list (with search/filter/sort/paginate), get, create, update,
 * archive (soft delete) + restore, and writes audit entries. Domain endpoints
 * with special transactional behaviour are defined explicitly elsewhere.
 */

import db from '../db.js';
import { tdb } from './scope.js';
import { ok, created, notFound, badRequest, applyListQuery } from './router.js';
import { audit } from './helpers.js';
import { now } from '../../utils/date.js';
import { assertValid } from '../../utils/validate.js';

export function defineResource(router, opts) {
  const {
    base, // '/products'
    collection, // 'products'
    entity, // 'product'
    schema = null,
    listOptions = {},
    softDelete = true,
    beforeCreate = (b) => b,
    beforeUpdate = (b, existing) => b,
    afterCreate = () => {},
    afterUpdate = () => {},
    afterArchive = () => {},
    decorate = (row) => row, // shape a row for output (denormalize)
    scopeList = (rows) => rows, // e.g. branch scoping
    allowHardDelete = false,
  } = opts;

  // tenant-scoped: reads filter by the caller's merchant, writes stamp it
  const col = () => tdb(collection);

  router.get(base, ({ query }) => {
    let rows = col().all();
    if (softDelete && query.includeArchived !== 'true' && query.status !== 'archived') {
      rows = rows.filter((r) => !r.archivedAt);
    }
    rows = scopeList(rows, query);
    const result = applyListQuery(rows, query, listOptions);
    return ok({ ...result, data: result.data.map(decorate) });
  });

  router.get(`${base}/:id`, ({ params }) => {
    const row = col().get(params.id);
    if (!row) notFound(cap(entity));
    return ok(decorate(row, { full: true }));
  });

  router.post(base, ({ body }) => {
    let payload = { ...(body || {}) };
    if (schema) payload = assertValid(payload, schema);
    payload = beforeCreate(payload) || payload;
    return db.tx(() => {
      const row = col().insert(payload);
      afterCreate(row);
      audit('create', entity, row.id, { after: row });
      return created(decorate(row, { full: true }));
    });
  });

  router.patch(`${base}/:id`, ({ params, body }) => {
    const existing = col().get(params.id);
    if (!existing) notFound(cap(entity));
    let patch = { ...(body || {}) };
    delete patch.id;
    delete patch.createdAt;
    if (schema) {
      const merged = assertValid({ ...existing, ...patch }, schema);
      patch = Object.fromEntries(Object.keys(patch).map((k) => [k, merged[k]]));
    }
    patch = beforeUpdate(patch, existing) || patch;
    return db.tx(() => {
      const row = col().update(params.id, patch);
      afterUpdate(row, existing);
      audit('update', entity, row.id, { before: existing, after: row });
      return ok(decorate(row, { full: true }));
    });
  });

  router.del(`${base}/:id`, ({ params, query }) => {
    const existing = col().get(params.id);
    if (!existing) notFound(cap(entity));
    return db.tx(() => {
      if (softDelete && query.hard !== 'true') {
        const row = col().update(params.id, { archivedAt: now(), status: 'archived' });
        afterArchive(row, existing);
        audit('archive', entity, row.id, { before: existing, after: row });
        return ok({ archived: true, id: row.id });
      }
      if (!allowHardDelete && query.hard === 'true') {
        badRequest('This record cannot be permanently deleted; it is archived instead to protect history.');
      }
      col().remove(params.id);
      audit('delete', entity, params.id, { before: existing });
      return ok({ deleted: true, id: params.id });
    });
  });

  if (softDelete) {
    router.post(`${base}/:id/restore`, ({ params }) => {
      const existing = col().get(params.id);
      if (!existing) notFound(cap(entity));
      return db.tx(() => {
        const row = col().update(params.id, { archivedAt: undefined, status: 'active' });
        audit('update', entity, row.id, { before: existing, after: row, meta: { action: 'restore' } });
        return ok(decorate(row, { full: true }));
      });
    });
  }
}

function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
