/**
 * mock/context.js - request context for the mock backend.
 *
 * In a real backend the caller identity comes from the session cookie / JWT and
 * the server derives the tenant from it. Here the auth layer registers the
 * active user; mock handlers read the tenant scope from THIS module, never from
 * client input (see mock/scope.js).
 */

let actor = null; // { id, name, roleId, merchantId, platform, branchIds, ... }
let activeBranchId = null;
let supportSession = null; // { id, merchantId, superAdminId, expiresAt } - platform support access

/** Sentinel returned by getScopeMerchantId() for an unrestricted platform view. */
export const ALL_TENANTS = Symbol('all-tenants');

export function setActor(user) {
  actor = user || null;
}
export function getActor() {
  return actor;
}
export function isPlatformActor() {
  return !!actor?.platform;
}

export function setActiveBranch(branchId) {
  activeBranchId = branchId || null;
}
export function getActiveBranch() {
  return activeBranchId;
}

export function setSupportSession(s) {
  supportSession = s || null;
}
export function getSupportSession() {
  if (supportSession && supportSession.expiresAt && Date.now() > new Date(supportSession.expiresAt).getTime()) {
    supportSession = null;
  }
  return supportSession;
}

/**
 * The merchant id every tenant-scoped query must be filtered by.
 *  - normal user  -> their own merchantId
 *  - platform admin, no support session -> ALL_TENANTS (see everything)
 *  - platform admin, active support session -> the merchant being supported
 *  - unauthenticated -> null (handlers should have already rejected)
 */
export function getScopeMerchantId() {
  if (!actor) return null;
  if (actor.platform) {
    const s = getSupportSession();
    return s ? s.merchantId : ALL_TENANTS;
  }
  return actor.merchantId || null;
}

/** The merchant id to STAMP on newly created tenant records. */
export function getWriteMerchantId() {
  const scope = getScopeMerchantId();
  if (scope === ALL_TENANTS || scope == null) {
    // A platform admin with no support session should not be creating tenant data.
    return null;
  }
  return scope;
}

export function clearContext() {
  actor = null;
  activeBranchId = null;
  supportSession = null;
}
