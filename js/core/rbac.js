/**
 * rbac.js - effective-permission resolution + enforcement helpers.
 *
 * Effective set = role.permissions
 *               + user.permissionGrants   (extra allow)
 *               - user.permissionRevokes  (explicit deny wins)
 * '*' in the role means "all permissions".
 *
 * Services import { requirePermission } and call it before mutating anything -
 * this is the authoritative check. UI imports { can } to hide/disable controls.
 */

import { SUPER } from '../data/permissions.js';
import store from './store.js';

export class ForbiddenError extends Error {
  constructor(permission) {
    super(`You do not have permission to perform this action (${permission}).`);
    this.name = 'ForbiddenError';
    this.status = 403;
    this.permission = permission;
  }
}

/** Build the effective Set<string> for a user given its role. */
export function resolvePermissions(user, role) {
  const set = new Set();
  const rolePerms = role?.permissions || [];
  if (rolePerms.includes(SUPER)) set.add(SUPER);
  else rolePerms.forEach((p) => set.add(p));
  (user?.permissionGrants || []).forEach((p) => set.add(p));
  (user?.permissionRevokes || []).forEach((p) => set.delete(p));
  return set;
}

/** Check against the current session's permission set (from store). */
export function can(permission) {
  const set = store.get('permissions');
  if (!set) return false;
  if (set.has(SUPER)) return true;
  if (Array.isArray(permission)) return permission.some((p) => set.has(p));
  return set.has(permission);
}

export function canAll(permissions) {
  return permissions.every((p) => can(p));
}

/** Throwing guard for the service layer. */
export function requirePermission(permission) {
  if (!can(permission)) throw new ForbiddenError(Array.isArray(permission) ? permission.join('|') : permission);
}

/** The max discount % the current user's role allows (before override perm). */
export function discountLimitPct() {
  return store.get('user')?.discountLimitPct ?? 0;
}

/**
 * Validate a requested discount percentage against the role limit.
 * Returns { allowed, limit, needsOverride }.
 */
export function checkDiscountPct(pct) {
  const limit = discountLimitPct();
  if (pct <= limit) return { allowed: true, limit, needsOverride: false };
  return { allowed: can('sales.discount.override'), limit, needsOverride: true };
}

export default { can, canAll, requirePermission, resolvePermissions, checkDiscountPct, ForbiddenError };
