/**
 * services/base.js - shared helpers for the service layer.
 *
 * Every service is a thin domain API over http.js. Permission checks run HERE
 * (authoritative at the app logic level, per §27) via requirePermission, and the
 * mock/real backend re-checks integrity. UI code only ever imports services.
 */

import http from '../core/http.js';
import { requirePermission } from '../core/rbac.js';
import store from '../core/store.js';
import { assertValid } from '../utils/validate.js';

/** Attach the active branch to list/detail queries unless one is supplied. */
export function withBranch(params = {}) {
  const branchId = params.branchId || store.get('activeBranchId');
  return branchId ? { ...params, branchId } : { ...params };
}

/**
 * Build a standard CRUD service.
 *  perms: { view, create, edit, archive } permission strings (any may be null)
 *  schema: validation schema for create/update (optional)
 *  branchScoped: attach activeBranchId to list/get
 */
export function crudService(path, { perms = {}, schema = null, branchScoped = false } = {}) {
  const scope = (p) => (branchScoped ? withBranch(p) : p || {});
  return {
    async list(params = {}) {
      if (perms.view) requirePermission(perms.view);
      return http.get(path, { params: scope(params) });
    },
    async get(id, params = {}) {
      if (perms.view) requirePermission(perms.view);
      return http.get(`${path}/${id}`, { params: scope(params) });
    },
    async create(payload) {
      if (perms.create) requirePermission(perms.create);
      if (schema) payload = assertValid(payload, schema);
      return http.post(path, payload);
    },
    async update(id, payload) {
      if (perms.edit) requirePermission(perms.edit);
      if (schema) payload = { ...payload };
      return http.patch(`${path}/${id}`, payload);
    },
    async archive(id) {
      if (perms.archive || perms.edit) requirePermission(perms.archive || perms.edit);
      return http.del(`${path}/${id}`);
    },
    async restore(id) {
      if (perms.archive || perms.edit) requirePermission(perms.archive || perms.edit);
      return http.post(`${path}/${id}/restore`);
    },
    _http: http,
    _path: path,
  };
}
