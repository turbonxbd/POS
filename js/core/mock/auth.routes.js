/**
 * auth.routes.js - mock authentication endpoints.
 * Real deployments replace these with a backend that issues signed sessions,
 * enforces rate limiting server-side, and stores argon2/bcrypt hashes.
 */

import db from '../db.js';
import { tdb } from './scope.js';
import { ok, fail, notFound, badRequest } from './router.js';
import { audit } from './helpers.js';
import { setActor, getActor } from './context.js';
import { hashPassword, verifyPassword, issueToken } from '../../utils/crypto.js';
import { now } from '../../utils/date.js';
import config from '../../config.js';
import { liveStatus, dueAmount, isBlocked, graceDays, notifyPlatform } from './platform-helpers.js';

function hydrateUser(user) {
  const role = db.collection('roles').get(user.roleId) || null;
  const isPlatform = !!user.platform;
  const employee = db.collection('employees').findOne({ userId: user.id });
  const ownBranches = db.collection('branches').all().filter((b) => user.merchantId == null || b.merchantId === user.merchantId);
  const branchIds = isPlatform ? [] : (employee?.branchIds || ownBranches.map((b) => b.id));
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      avatar: user.avatar || null,
      roleId: user.roleId,
      roleName: role?.name || 'User',
      status: user.status,
      merchantId: user.merchantId ?? null,
      platform: isPlatform,
      isPlatformAdmin: isPlatform,
      permissionGrants: user.permissionGrants || [],
      permissionRevokes: user.permissionRevokes || [],
      discountLimitPct: role?.discountLimitPct ?? 0,
      branchIds,
      lastLoginAt: user.lastLoginAt || null,
    },
    role,
  };
}

/** Access state derived from the subscription - drives the merchant panels' banner + lockout. */
export function accessFor(subscription) {
  const state = liveStatus(subscription);
  if (!subscription) return { state: 'none', blocked: false, dueAmount: 0, nextBillingAt: null, graceUntil: null, reason: null };
  const blocked = isBlocked(subscription, state);
  let graceUntil = null;
  if (subscription.expiresAt) {
    graceUntil = new Date(new Date(subscription.expiresAt).getTime() + graceDays() * 86400000).toISOString();
  }
  const reason = state === 'suspended' ? 'Your account has been suspended by POS TXbd.'
    : state === 'expired' ? 'Your subscription has lapsed. Pay the outstanding server charge to restore access.'
      : state === 'cancelled' ? 'Your subscription was cancelled.'
        : state === 'past_due' ? 'Your monthly server & backup charge is overdue.'
          : state === 'pending' && !subscription.setupPaid ? 'Pay the one-time setup fee to activate your account.'
            : null;
  return {
    state, blocked,
    dueAmount: dueAmount(subscription, state),
    nextBillingAt: subscription.nextBillingAt || subscription.expiresAt || null,
    graceUntil, reason,
  };
}

/** Business / branches / subscription for the active actor, tenant-scoped. */
function orgContext() {
  const actor = getActor();
  if (actor?.platform) {
    return { business: null, branches: [], subscription: null, access: { state: 'platform', blocked: false } };
  }
  const subscription = tdb('subscriptions').all()[0] || null;
  return {
    business: tdb('businesses').all()[0] || null,
    branches: tdb('branches').find((b) => !b.archivedAt),
    subscription,
    access: accessFor(subscription),
  };
}

export default function register(router) {
  router.post('/auth/login', async ({ body }) => {
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!email || !password) badRequest('Email and password are required', { email: !email ? 'Required' : undefined, password: !password ? 'Required' : undefined });

    const user = db.collection('users').findOne((u) => u.email.toLowerCase() === email);
    // Constant-ish response to avoid user enumeration in the demo.
    if (!user) {
      await hashPassword(password);
      return fail(401, 'Incorrect email or password');
    }
    if (user.status !== 'active') return fail(403, 'This account is deactivated. Contact an administrator.');

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      audit('login_failed', 'user', user.id, { meta: { email } });
      return fail(401, 'Incorrect email or password');
    }

    db.collection('users').update(user.id, { lastLoginAt: now() });
    const token = issueToken(user.id);
    const hydrated = hydrateUser(db.collection('users').get(user.id));
    setActor({ ...hydrated.user });
    audit('login', 'user', user.id, { meta: { email } });

    return ok({
      token,
      expiresAt: new Date(Date.now() + config.security.sessionIdleTimeoutMin * 60000).toISOString(),
      ...hydrated,
      ...orgContext(),
    });
  });

  router.get('/auth/me', async () => {
    const actor = getActor();
    if (!actor) return fail(401, 'Not authenticated');
    const user = db.collection('users').get(actor.id);
    if (!user) return fail(401, 'Session user no longer exists');
    const hydrated = hydrateUser(user);
    // session.restore() sets only a minimal placeholder actor; upgrade it to the
    // full record (merchantId, platform, ...) so tenant scoping resolves.
    setActor({ ...hydrated.user });
    return ok({ ...hydrated, ...orgContext() });
  });

  router.post('/auth/logout', async () => {
    const actor = getActor();
    if (actor) audit('logout', 'user', actor.id);
    setActor(null);
    return ok({ ok: true });
  });

  router.post('/auth/change-password', async ({ body }) => {
    const actor = getActor();
    if (!actor) return fail(401, 'Not authenticated');
    const user = db.collection('users').get(actor.id);
    if (!user) notFound('User');

    const current = String(body?.currentPassword || '');
    const next = String(body?.newPassword || '');
    if (next.length < config.security.passwordMinLength) {
      badRequest('Password too short', { newPassword: `Use at least ${config.security.passwordMinLength} characters` });
    }
    if (!(await verifyPassword(current, user.passwordHash))) {
      badRequest('Current password is incorrect', { currentPassword: 'Incorrect' });
    }
    db.collection('users').update(user.id, { passwordHash: await hashPassword(next) });
    audit('update', 'user', user.id, { meta: { field: 'password' } });
    return ok({ ok: true });
  });

  /**
   * Forgot password. No email infrastructure, so this raises a request for the
   * Super Admin, who resets the account and shares a temporary password. Always
   * returns ok so the response can never confirm whether an email exists.
   */
  router.post('/auth/forgot', async ({ body }) => {
    const email = String(body?.email || '').trim().toLowerCase();
    if (!email) badRequest('Enter your account email.');
    const user = db.collection('users').findOne((u) => u.email.toLowerCase() === email && !u.platform);
    if (user) {
      const biz = db.collection('businesses').all().find((b) => b.merchantId === user.merchantId)?.name
        || db.collection('merchants').get(user.merchantId)?.name || 'A merchant';
      const recent = db.collection('platform_notifications').all().find(
        (n) => n.type === 'password_reset' && n.meta?.userId === user.id && !n.read
          && Date.now() - new Date(n.at).getTime() < 3600000,
      );
      if (!recent) {
        notifyPlatform({
          type: 'password_reset',
          title: 'Password reset requested',
          message: `${user.name} (${user.email}) at ${biz} asked to reset their password.`,
          level: 'warning',
          link: `#/merchants/${user.merchantId}`,
          meta: { userId: user.id, merchantId: user.merchantId, email: user.email },
        });
      }
      audit('update', 'user', user.id, { meta: { action: 'reset_requested' } });
    }
    return ok({ ok: true });
  });
}
