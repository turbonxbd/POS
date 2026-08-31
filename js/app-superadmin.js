/**
 * app-superadmin.js - POS TXbd Super Admin panel shell.
 *
 * Separate entry (superadmin.html). Own login gate, requires a platform actor
 * (user.platform === true). Never linked from the merchant portal.
 */
import { boot, toggleTheme } from './core/boot.js';
import { session } from './core/session.js';
import store from './core/store.js';
import bus from './core/event-bus.js';
import config from './config.js';
import { Router } from './core/router.js';
import { icon } from './components/icons.js';
import { escapeHtml } from './utils/dom.js';
import { initials } from './utils/format.js';
import { attachMenu } from './components/dropdown.js';
import { openModal } from './components/modal.js';
import { toast } from './components/toast.js';
import platformNotificationService from './services/platform-notification-service.js';
import platformService from './services/platform-service.js';

const PLATFORM = config.app.name || 'POS TXbd';

const NAV = [
  { path: '/', label: 'Dashboard', icon: 'dashboard' },
  { path: '/approvals', label: 'Approvals', icon: 'check-circle', badge: true },
  { path: '/merchants', label: 'Merchants', icon: 'building' },
  { path: '/subscriptions', label: 'Subscriptions', icon: 'rotate-ccw' },
  { path: '/plans', label: 'Plans', icon: 'tag' },
  { path: '/payments', label: 'Payment Requests', icon: 'credit-card' },
  { path: '/revenue', label: 'Revenue', icon: 'banknote' },
  { path: '/payment-settings', label: 'Payment Settings', icon: 'settings' },
  { path: '/support', label: 'Support', icon: 'help' },
  { path: '/chat', label: 'Chat', icon: 'inbox' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];

const ROUTES = [
  { path: '/', title: 'Dashboard', load: () => import('./pages/platform/dashboard.js') },
  { path: '/approvals', title: 'Approvals', load: () => import('./pages/platform/approvals.js') },
  { path: '/merchants', title: 'Merchants', load: () => import('./pages/platform/merchants.js') },
  { path: '/merchants/:id', title: 'Merchant', load: () => import('./pages/platform/merchant-detail.js') },
  { path: '/subscriptions', title: 'Subscriptions', load: () => import('./pages/platform/subscriptions.js') },
  { path: '/payments', title: 'Payment Requests', load: () => import('./pages/platform/payments.js') },
  { path: '/plans', title: 'Plans', load: () => import('./pages/platform/plans.js') },
  { path: '/revenue', title: 'Revenue', load: () => import('./pages/platform/revenue.js') },
  { path: '/payment-settings', title: 'Payment Settings', load: () => import('./pages/platform/payment-settings.js') },
  { path: '/support', title: 'Support', load: () => import('./pages/platform/support.js') },
  { path: '/chat', title: 'Chat', load: () => import('./pages/platform/chat.js') },
  { path: '/settings', title: 'Settings', load: () => import('./pages/platform/settings.js') },
];

const root = document.getElementById('app-root');

(async () => {
  await boot({ seedIfEmpty: true });
  document.title = `${PLATFORM} · Super Admin`;

  let user = null;
  const restored = await session.restore();
  if (restored) user = store.get('user');

  if (!user) {
    renderLogin();
    return;
  }
  if (!user.platform) {
    renderDenied(user);
    return;
  }
  renderShell(user);
  startRouter();
})().catch((err) => {
  console.error(err);
  root.innerHTML = `<div class="page"><div class="alert alert--danger"><div class="alert__body"><div class="alert__title">Failed to start</div>${escapeHtml(err.message)}</div></div></div>`;
});

/* --------------------------------------------------------------- login gate */
function renderLogin() {
  root.className = 'sa-auth';
  root.innerHTML = `
    <div class="sa-auth__card">
      <div class="sa-auth__brand">${icon('shield', { size: 22 })}<span>${escapeHtml(PLATFORM)}</span></div>
      <h1>Super Admin</h1>
      <p class="muted">Platform control for ${escapeHtml(PLATFORM)} owners.</p>
      <form id="sa-login" class="stack" novalidate>
        <label class="field"><span>Email</span><input class="input" type="email" name="email" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
        <div class="alert alert--danger" id="sa-login-err" hidden><div class="alert__body"></div></div>
        <button class="btn btn--primary btn--block" type="submit">Sign in</button>
      </form>
      ${config.api.mode === 'mock' ? `<p class="sa-auth__demo">Demo: <button type="button" id="sa-demo">superadmin@postxbd.app / superadmin123</button></p>` : ''}
      <p class="sa-auth__foot"><a href="portal.html">Merchant sign-in &rarr;</a></p>
    </div>`;
  root.querySelector('#sa-demo')?.addEventListener('click', () => {
    root.querySelector('#sa-login [name=email]').value = 'superadmin@postxbd.app';
    root.querySelector('#sa-login [name=password]').value = 'superadmin123';
    root.querySelector('#sa-login').requestSubmit();
  });
  const form = root.querySelector('#sa-login');
  const err = root.querySelector('#sa-login-err');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button');
    btn.disabled = true; btn.innerHTML = '<span class="spinner spinner--invert"></span> Signing in…';
    try {
      await session.login(form.querySelector('[name=email]').value.trim(), form.querySelector('[name=password]').value);
      const u = store.get('user');
      if (!u?.platform) throw new Error('This account is not a Super Admin.');
      location.reload();
    } catch (e2) {
      err.hidden = false;
      err.querySelector('.alert__body').textContent = e2?.data?.message || e2.message || 'Sign in failed.';
      btn.disabled = false; btn.textContent = 'Sign in';
      if (store.get('user') && !store.get('user').platform) await session.logout({ redirect: false });
    }
  });
}

function renderDenied(user) {
  root.className = 'sa-auth';
  root.innerHTML = `
    <div class="sa-auth__card">
      <div class="sa-auth__brand">${icon('shield', { size: 22 })}<span>${escapeHtml(PLATFORM)}</span></div>
      <h1>Not authorised</h1>
      <p class="muted">${escapeHtml(user.name)} is a merchant account, not a ${escapeHtml(PLATFORM)} Super Admin.</p>
      <a class="btn btn--primary btn--block" href="portal.html">Go to the Merchant Portal</a>
      <button class="btn btn--ghost btn--block" id="sa-signout" style="margin-top:8px">Sign out</button>
    </div>`;
  root.querySelector('#sa-signout').addEventListener('click', async () => { await session.logout({ redirect: false }); location.href = 'superadmin.html'; });
}

/* --------------------------------------------------------------- shell */
let router;
function renderShell(user) {
  root.className = '';
  root.innerHTML = `
    <div class="app-shell" id="shell">
      <div class="sidebar-backdrop" id="sb-backdrop"></div>
      <aside class="sidebar" aria-label="Super Admin navigation">
        <div class="sidebar__brand">
          <div class="sidebar__logo">${icon('shield', { size: 18 })}</div>
          <div class="sidebar__brand-text"><strong>${escapeHtml(PLATFORM)}</strong><span>Super Admin</span></div>
        </div>
        <nav class="sidebar__nav">
          ${NAV.map((n) => `<a class="sidebar__link" href="#${n.path}" data-path="${n.path}">${icon(n.icon, { size: 18 })}<span>${escapeHtml(n.label)}</span>${n.badge ? '<span class="sidebar__count" id="sa-approve-count" hidden></span>' : ''}</a>`).join('')}
        </nav>
        <div class="sidebar__foot">
          <button class="sidebar__link" id="sa-theme">${icon('moon', { size: 18 })}<span>Theme</span></button>
        </div>
      </aside>
      <div class="app-main">
        <header class="topbar">
          <button class="topbar__menu-btn" id="sa-hamburger" aria-label="Menu">${icon('menu', { size: 20 })}</button>
          <div class="topbar__title" id="sa-title">Dashboard</div>
          <div class="topbar__spacer"></div>
          <button class="topbar__icon-btn" id="sa-notif-btn" aria-label="Notifications" data-tooltip="Notifications">
            ${icon('bell')}<span class="dot" id="sa-notif-dot" hidden></span>
          </button>
          <button class="sa-user" id="sa-user">
            <span class="avatar avatar--sm">${escapeHtml(initials(user.name))}</span>
            <span class="sa-user__name">${escapeHtml(user.name)}</span>
            ${icon('chevron-down', { size: 14 })}
          </button>
        </header>
        <main class="app-content" id="main" tabindex="-1">
          <div class="loading-block"><span class="spinner"></span></div>
        </main>
      </div>
    </div>`;

  root.querySelector('#sa-theme').addEventListener('click', toggleTheme);
  root.querySelector('#sa-hamburger').addEventListener('click', () => document.getElementById('shell').classList.toggle('is-sidebar-open'));
  root.querySelector('#sb-backdrop').addEventListener('click', () => document.getElementById('shell').classList.remove('is-sidebar-open'));
  root.querySelectorAll('.sidebar__link[href]').forEach((a) => a.addEventListener('click', () => document.getElementById('shell').classList.remove('is-sidebar-open')));

  attachMenu(root.querySelector('#sa-user'), () => [
    { label: 'Merchant Portal', icon: 'external-link', onClick: () => (location.href = 'portal.html') },
    { label: 'Sign out', icon: 'logout', onClick: async () => { await session.logout({ redirect: false }); location.href = 'superadmin.html'; } },
  ]);

  bus.on('router:after', () => {
    const cur = router?.current();
    const active = cur ? cur.path : '/';
    root.querySelectorAll('.sidebar__link[data-path]').forEach((a) => {
      a.classList.toggle('is-active', a.dataset.path === (active.startsWith('/merchants') ? '/merchants' : active));
    });
    const meta = ROUTES.find((r) => r.path === cur?.path);
    root.querySelector('#sa-title').textContent = meta?.title || 'Super Admin';
    refreshNotifBadge();
    refreshApproveCount();
  });

  /* notification bell */
  const dot = root.querySelector('#sa-notif-dot');
  const applyBadge = (n) => { if (dot) dot.hidden = !(n > 0); };
  applyBadge(store.get('platformNotificationsUnread'));
  store.watch('platformNotificationsUnread', applyBadge);
  bus.on('platform-notifications:changed', refreshNotifBadge);
  // live: a new payment request / notification (this tab or another) updates
  // the bell + the Approvals count within a second, no reload
  let liveT = null;
  const liveTick = () => { clearTimeout(liveT); liveT = setTimeout(() => { refreshNotifBadge(); refreshApproveCount(); }, 800); };
  ['data:platform_notifications', 'data:subscription_payments', 'data:subscriptions', 'data:merchants', 'db:external-change'].forEach((e) => bus.on(e, liveTick));
  root.querySelector('#sa-notif-btn').addEventListener('click', openNotifications);
  refreshNotifBadge();
  refreshApproveCount();
  setInterval(() => { refreshNotifBadge(); refreshApproveCount(); }, 60000);
}

function refreshNotifBadge() {
  platformNotificationService.refreshBadge().catch(() => {});
}

async function refreshApproveCount() {
  const el = document.getElementById('sa-approve-count');
  if (!el) return;
  try {
    const d = await platformService.dashboard();
    const a = d.attention || {};
    const n = (a.accounts || 0) + (a.payments || 0) + (a.overdue || 0);
    el.textContent = String(n);
    el.hidden = n === 0;
  } catch { /* leave as-is */ }
}

async function openNotifications() {
  const m = openModal({ title: 'Notifications', size: 'md', body: '<div class="loading-block"><span class="spinner"></span></div>' });
  try {
    const res = await platformNotificationService.list({ pageSize: 30 });
    const list = res.data || [];
    m.setBody(list.length
      ? `<div style="margin:calc(var(--sp-5) * -1)">${list.map((n) => `
          <div class="notif-item ${n.read ? '' : 'is-unread'}">
            <span class="notif-item__icon">${icon(n.level === 'danger' ? 'alert-circle' : n.level === 'warning' ? 'alert-triangle' : 'info', { size: 15 })}</span>
            <div class="notif-item__body">
              <strong>${escapeHtml(n.title)}</strong>
              <p>${escapeHtml(n.message)}</p>
              <time>${escapeHtml(new Date(n.at).toLocaleString())}</time>
            </div>
            ${n.link ? `<a class="btn btn--ghost btn--sm js-notif-open" data-id="${escapeHtml(n.id)}" href="${escapeHtml(n.link)}">Open</a>` : ''}
          </div>`).join('')}</div>`
      : `<div class="empty-state"><div class="empty-state__icon">${icon('bell', { size: 24 })}</div><h3>No notifications</h3></div>`);
    m.setFooter('<button class="btn btn--primary js-read-all">Mark all read</button>');
    m.$('.js-read-all')?.addEventListener('click', async () => {
      await platformNotificationService.markAllRead();
      m.close();
      toast.success('All notifications marked read');
    });
    m.el.addEventListener('click', async (e) => {
      const open = e.target.closest('.js-notif-open');
      if (open) {
        await platformNotificationService.markRead(open.dataset.id).catch(() => {});
        m.close();
      }
    });
  } catch (err) {
    m.setBody(`<p class="text-danger">${escapeHtml(err.message)}</p>`);
  }
}

function startRouter() {
  const outlet = document.getElementById('main');
  router = new Router({ outlet });
  ROUTES.forEach((r) => {
    router.add(r.path, async (ctx, mount) => {
      const mod = await r.load();
      return mod.default(ctx, mount);
    }, { title: r.title });
  });
  router.setNotFound((ctx, mount) => { mount.innerHTML = `<div class="page"><h1>Not found</h1><p class="muted">No such page.</p></div>`; });
  router.start();
}
