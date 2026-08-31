/**
 * session.js - authentication session lifecycle.
 * Bridges auth-service <-> store <-> mock backend context, restores a session on
 * boot, resolves the effective permission set, and enforces an idle timeout.
 */

import config from '../config.js';
import store from './store.js';
import bus from './event-bus.js';
import { resolvePermissions } from './rbac.js';
import { mockContext } from './mock-server.js';
import authService from '../services/auth-service.js';

const SKEY = config.storage.sessionKey;

let idleTimer = null;

function saveSession(payload) {
  try {
    localStorage.setItem(SKEY, JSON.stringify({ token: payload.token, userId: payload.user.id, at: Date.now() }));
  } catch (err) {
    console.warn('[session] could not persist session', err);
  }
}
function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SKEY));
  } catch {
    return null;
  }
}
function clearStored() {
  localStorage.removeItem(SKEY);
}

function applySession(payload) {
  const permissions = resolvePermissions(payload.user, payload.role);
  const branchIds = payload.user.branchIds || payload.branches.map((b) => b.id);
  let activeBranchId = store.get('activeBranchId');
  if (!activeBranchId || !branchIds.includes(activeBranchId)) activeBranchId = branchIds[0] || null;

  mockContext.setActor({ ...payload.user });
  mockContext.setActiveBranch(activeBranchId);

  store.set({
    user: payload.user,
    session: { token: payload.token, expiresAt: payload.expiresAt },
    role: payload.role,
    business: payload.business,
    branches: payload.branches,
    subscription: payload.subscription || null,
    access: payload.access || null,
    activeBranchId,
    permissions,
  });
  store.persistPrefs(['activeBranchId']);
  resetIdleTimer();
  bus.emit('auth:changed', { user: payload.user });
}

export const session = {
  async login(email, password) {
    const payload = await authService.login(email, password);
    saveSession(payload);
    applySession(payload);
    return payload;
  },

  async restore() {
    const stored = readSession();
    if (!stored) return null;
    // In mock mode the "server" also needs its actor set before /auth/me.
    const user = peekStoredUser(stored.userId);
    if (user) mockContext.setActor(user);
    try {
      const payload = await authService.me();
      applySession({ ...payload, token: stored.token, expiresAt: new Date(Date.now() + config.security.sessionIdleTimeoutMin * 60000).toISOString() });
      return payload;
    } catch (err) {
      clearStored();
      return null;
    }
  },

  async logout({ redirect = true } = {}) {
    try {
      await authService.logout();
    } catch {
      /* ignore network errors on logout */
    }
    clearStored();
    clearTimeout(idleTimer);
    mockContext.clearContext();
    store.set({ user: null, session: null, role: null, permissions: new Set() });
    bus.emit('auth:changed', { user: null });
    if (redirect) location.href = 'portal.html';
  },

  setActiveBranch(branchId) {
    const branches = store.get('branches') || [];
    if (!branches.some((b) => b.id === branchId)) return;
    mockContext.setActiveBranch(branchId);
    store.set({ activeBranchId: branchId });
    store.persistPrefs(['activeBranchId']);
    bus.emit('branch:changed', { branchId });
  },

  isAuthenticated() {
    return !!store.get('user');
  },
};

function peekStoredUser(userId) {
  // Minimal actor so mock /auth/me can resolve; full hydration follows.
  return { id: userId, name: 'restoring', roleId: null, branchIds: [] };
}

function resetIdleTimer() {
  clearTimeout(idleTimer);
  const ms = (store.get('business')?.securityIdleMin || config.security.sessionIdleTimeoutMin) * 60000;
  idleTimer = setTimeout(() => {
    bus.emit('auth:idle-timeout');
    session.logout();
  }, ms);
}

['click', 'keydown', 'mousemove', 'touchstart'].forEach((evt) =>
  window.addEventListener(evt, () => {
    if (store.get('user')) resetIdleTimer();
  }, { passive: true }),
);

window.addEventListener('online', () => store.set({ online: true }));
window.addEventListener('offline', () => store.set({ online: false }));

export default session;
