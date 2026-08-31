/**
 * app-admin.js - admin panel shell: layout, sidebar, topbar, router.
 */
import { boot, toggleTheme } from './core/boot.js';
import { session } from './core/session.js';
import store from './core/store.js';
import bus from './core/event-bus.js';
import { Router } from './core/router.js';
import { can } from './core/rbac.js';
import { icon } from './components/icons.js';
import { escapeHtml } from './utils/dom.js';
import { initials } from './utils/format.js';
import { attachMenu } from './components/dropdown.js';
import { openModal } from './components/modal.js';
import { toast } from './components/toast.js';
import notificationService from './services/notification-service.js';
import { NAV_GROUPS } from './admin-nav.js';
import { fmtRelative } from './utils/date.js';
import { PAGE_ROUTES } from './pages/admin/routes.js';
import { langSwitchHTML, wireLangSwitch } from './components/lang-switch.js';
import { mountSubscriptionGuard } from './components/subscription-guard.js';

const root = document.getElementById('app-root');

(async () => {
  await boot();
  const authed = await session.restore();
  if (!authed) {
    location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.hash));
    return;
  }
  if (!can('dashboard.view') && !can('*') && can('pos.operate')) {
    // Cashier-only accounts belong in the POS
    location.replace('cashier.html');
    return;
  }
  renderShell();
  startRouter();
  wireGlobal();
  notificationService.refreshBadge().catch(() => {});
})().catch((err) => {
  console.error(err);
  root.innerHTML = `<div class="page"><div class="alert alert--danger"><div class="alert__body"><div class="alert__title">Failed to start</div>${escapeHtml(err.message)}. Make sure the app is served over HTTP.</div></div></div>`;
});

/* --------------------------------------------------------------- shell */
function renderShell() {
  const user = store.get('user');
  const business = store.get('business');
  root.className = '';
  root.innerHTML = `
    <div class="app-shell ${store.get('sidebarCollapsed') ? 'is-sidebar-collapsed' : ''}" id="shell">
      <div class="sidebar-backdrop" id="sb-backdrop"></div>
      <aside class="sidebar" aria-label="Main navigation">
        <div class="sidebar__brand">
          <div class="sidebar__logo">${escapeHtml((business?.name || 'A')[0])}</div>
          <div class="sidebar__brand-text">
            <strong>${escapeHtml(business?.name || 'POS TXbd')}</strong>
            <span>Admin Console</span>
          </div>
        </div>
        <nav class="sidebar__nav" id="sidebar-nav"></nav>
        <div class="sidebar__footer">
          <button class="sidebar__collapse-btn" id="collapse-btn">
            ${icon('chevron-left')}<span>Collapse</span>
          </button>
        </div>
      </aside>

      <div class="app-main">
        <header class="topbar">
          <button class="topbar__icon-btn topbar__menu-btn" id="menu-btn" aria-label="Menu" aria-expanded="false">${icon('menu')}</button>
          <div class="topbar__search input-search">
            <span class="input-search__icon">${icon('search', { size: 16 })}</span>
            <input class="input" id="global-search" placeholder="Search products, invoices, customers…" aria-label="Global search">
          </div>
          <div class="topbar__title" id="topbar-title" aria-live="polite"></div>
          <div class="topbar__spacer"></div>
          <div class="topbar__actions">
            ${langSwitchHTML()}
            <button class="branch-switcher" id="branch-btn" aria-haspopup="true">
              ${icon('building')}<span id="branch-label" class="truncate">Branch</span>${icon('chevron-down', { size: 14 })}
            </button>
            <button class="topbar__icon-btn" id="theme-btn" aria-label="Toggle theme" data-tooltip="Theme">${icon('moon')}</button>
            <button class="topbar__icon-btn" id="notif-btn" aria-label="Notifications" data-tooltip="Notifications">
              ${icon('bell')}<span class="dot" id="notif-dot" hidden></span>
            </button>
            <button class="user-chip" id="user-btn" aria-haspopup="true">
              <span class="avatar avatar--sm">${escapeHtml(initials(user?.name))}</span>
              <span class="user-chip__meta">
                <strong>${escapeHtml(user?.name || 'User')}</strong>
                <span>${escapeHtml(user?.roleName || '')}</span>
              </span>
              ${icon('chevron-down', { size: 14 })}
            </button>
          </div>
        </header>
        <main class="app-content" id="main" tabindex="-1"></main>
      </div>
    </div>`;

  renderSidebar();
  wireLangSwitch(document);
  updateBranchLabel();
  updateThemeIcon();

  const mainEl = document.getElementById('main');
  mountSubscriptionGuard({ bannerBefore: mainEl, contentEl: mainEl, payHref: '#/billing' });

  const shell = document.getElementById('shell');
  document.getElementById('collapse-btn').addEventListener('click', () => {
    const collapsed = shell.classList.toggle('is-sidebar-collapsed');
    store.set({ sidebarCollapsed: collapsed });
    store.persistPrefs(['sidebarCollapsed']);
    bus.emit('layout:resize');
  });
  const menuBtn = document.getElementById('menu-btn');
  const setDrawer = (open) => {
    shell.classList.toggle('is-sidebar-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.addEventListener('click', () => setDrawer(!shell.classList.contains('is-sidebar-open')));
  document.getElementById('sb-backdrop').addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shell.classList.contains('is-sidebar-open')) setDrawer(false);
  });

  document.getElementById('theme-btn').addEventListener('click', () => {
    toggleTheme();
    updateThemeIcon();
  });

  document.getElementById('notif-btn').addEventListener('click', openNotifications);

  attachMenu(document.getElementById('branch-btn'), () => {
    const branches = store.get('branches') || [];
    const active = store.get('activeBranchId');
    return branches.map((b) => ({
      label: b.name + (b.id === active ? '  ✓' : ''),
      icon: 'building',
      onSelect: () => {
        session.setActiveBranch(b.id);
        updateBranchLabel();
        toast.info(`Switched to ${b.name}`);
      },
    }));
  }, { align: 'end' });

  attachMenu(document.getElementById('user-btn'), () => [
    { label: store.get('user')?.email || '', header: true },
    { label: 'My Profile', icon: 'user', onSelect: openProfile },
    { label: 'Change Password', icon: 'shield', onSelect: openChangePassword },
    { separator: true },
    { label: 'Open POS Terminal', icon: 'pos', onSelect: () => (location.href = 'cashier.html') },
    { label: 'Back to Portal', icon: 'grid', onSelect: () => (location.href = 'portal.html') },
    { separator: true },
    { label: 'Sign out', icon: 'logout', danger: true, onSelect: () => session.logout() },
  ], { align: 'end' });

  const gs = document.getElementById('global-search');
  gs.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && gs.value.trim()) {
      location.hash = `#/products?search=${encodeURIComponent(gs.value.trim())}`;
      gs.blur();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      gs.focus();
    }
  });
}

function renderSidebar() {
  const nav = document.getElementById('sidebar-nav');
  nav.innerHTML = NAV_GROUPS.map((group) => {
    const items = group.items.filter((it) => !it.permission || can(it.permission));
    if (!items.length) return '';
    return `
      ${group.label ? `<div class="sidebar__group-label">${escapeHtml(group.label)}</div>` : ''}
      <div class="sidebar__group">
        ${items
          .map((it) => {
            const href = it.external ? it.external : `#${it.path}`;
            return `<a class="nav-link" href="${href}" data-path="${it.path}" data-label="${escapeHtml(it.label)}" ${it.external ? '' : ''}>
              ${icon(it.icon)}<span>${escapeHtml(it.label)}</span>
              ${it.path === '/notifications' ? '<span class="nav-link__badge" id="notif-badge" hidden>0</span>' : ''}
            </a>`;
          })
          .join('')}
      </div>`;
  }).join('');

  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) document.getElementById('shell').classList.remove('is-sidebar-open');
  });
}

function setActiveNav(path) {
  document.querySelectorAll('.nav-link').forEach((a) => {
    const p = a.dataset.path;
    const active = p === '/' ? path === '/' : path.startsWith(p);
    a.classList.toggle('is-active', active);
  });
}

function updateBranchLabel() {
  const b = (store.get('branches') || []).find((x) => x.id === store.get('activeBranchId'));
  const el = document.getElementById('branch-label');
  if (el) el.textContent = b?.name || 'All Branches';
}
function updateThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  document.getElementById('theme-btn').innerHTML = icon(dark ? 'sun' : 'moon');
}

/* -------------------------------------------------------------- router */
function startRouter() {
  const outlet = document.getElementById('main');
  const router = new Router({ outlet });
  router.setGuard((route) => !route.meta.permission || can(route.meta.permission));
  router.setNotFound(() => notFoundView());
  router.setForbidden(() => forbiddenView());

  for (const route of PAGE_ROUTES) {
    router.add(route.path, async (ctx, mount) => {
      setActiveNav(ctx.pathname);
      const tt = document.getElementById('topbar-title');
      if (tt) tt.textContent = route.title || 'POS TXbd';
      setProgress(true);
      try {
        const mod = await route.load();
        mount.replaceChildren();
        await mod.default(ctx, mount);
      } finally {
        setProgress(false);
      }
    }, { permission: route.permission, title: route.title });
  }

  router.beforeEach(() => {
    document.getElementById('shell')?.classList.remove('is-sidebar-open');
    return true;
  });

  // Always land on the dashboard showing TODAY: a stale ?preset=/from=/to= in
  // the URL from a previous session must not carry over on a fresh load.
  const h = location.hash || '';
  if (/^#\/(\?.*)?$/.test(h) && /[?&](preset|from|to)=/.test(h)) {
    history.replaceState(null, '', location.pathname + '#/');
  }

  router.start();
  window.__router = router;
  bus.on('branch:changed', () => router.resolve());
}

function setProgress(active) {
  const bar = document.getElementById('app-progress');
  if (!bar) return;
  bar.classList.toggle('is-active', active);
  bar.style.transform = active ? 'scaleX(0.7)' : 'scaleX(1)';
  if (!active) setTimeout(() => (bar.style.transform = 'scaleX(0)'), 240);
}

function notFoundView() {
  return `<div class="page"><div class="empty-state">
    <div class="empty-state__icon">${icon('search', { size: 26 })}</div>
    <h3>Page not found</h3><p>The page you’re looking for doesn’t exist.</p>
    <a class="btn btn--primary" href="#/">Back to dashboard</a>
  </div></div>`;
}
function forbiddenView() {
  return `<div class="page"><div class="empty-state">
    <div class="empty-state__icon">${icon('shield', { size: 26 })}</div>
    <h3>Access denied</h3><p>Your role doesn’t have permission to view this page. Contact an administrator if you need access.</p>
    <a class="btn" href="#/">Back to dashboard</a>
  </div></div>`;
}

/* ------------------------------------------------------------- globals */
function wireGlobal() {
  const applyBadge = (n) => {
    const dot = document.getElementById('notif-dot');
    const badge = document.getElementById('notif-badge');
    if (dot) dot.hidden = !n;
    if (badge) {
      badge.hidden = !n;
      badge.textContent = n > 99 ? '99+' : n;
    }
  };
  applyBadge(store.get('notificationsUnread'));
  store.watch('notificationsUnread', applyBadge);
  bus.on('notifications:changed', () => notificationService.refreshBadge().catch(() => {}));
  bus.on('theme:changed', updateThemeIcon);
  bus.on('business:changed', (b) => {
    const name = b?.name || 'POS TXbd';
    const nameEl = document.querySelector('.sidebar__brand-text strong');
    const logoEl = document.querySelector('.sidebar__logo');
    if (nameEl) nameEl.textContent = name;
    if (logoEl) logoEl.textContent = name[0];
  });
  bus.on('auth:idle-timeout', () => toast.info('Signed out due to inactivity.'));
  bus.on('data:notifications', () => notificationService.refreshBadge().catch(() => {}));

  // keep badge fresh
  setInterval(() => notificationService.refreshBadge().catch(() => {}), 60000);
}

async function openNotifications() {
  const m = openModal({ title: 'Notifications', size: 'md', body: '<div class="loading-block"><span class="spinner"></span></div>' });
  try {
    const res = await notificationService.getNotifications({ pageSize: 30 });
    const list = res.data || [];
    m.setBody(
      list.length
        ? `<div style="margin:calc(var(--sp-5) * -1)">${list
            .map(
              (n) => `<div class="notif-item ${n.read ? '' : 'is-unread'}">
                <span class="notif-item__icon">${icon(n.level === 'danger' ? 'alert-circle' : n.level === 'warning' ? 'alert-triangle' : n.type === 'sale' ? 'receipt' : 'info', { size: 15 })}</span>
                <div class="notif-item__body">
                  <strong>${escapeHtml(n.title)}</strong>
                  <p>${escapeHtml(n.message)}</p>
                  <time>${fmtRelative(n.at)}</time>
                </div>
                ${n.link ? `<a class="btn btn--ghost btn--sm" href="${escapeHtml(n.link)}">Open</a>` : ''}
              </div>`,
            )
            .join('')}</div>`
        : `<div class="empty-state"><div class="empty-state__icon">${icon('bell', { size: 24 })}</div><h3>No notifications</h3></div>`,
    );
    m.setFooter(`<a class="btn btn--ghost" href="#/notifications">View all</a><button class="btn btn--primary js-read-all">Mark all read</button>`);
    m.$('.js-read-all')?.addEventListener('click', async () => {
      await notificationService.markAllRead();
      m.close();
      toast.success('All notifications marked read');
    });
    m.el.addEventListener('click', (e) => {
      if (e.target.closest('a[href^="#/"]')) m.close();
    });
  } catch (err) {
    m.setBody(`<p class="text-danger">${escapeHtml(err.message)}</p>`);
  }
}

function openProfile() {
  const u = store.get('user');
  const b = store.get('business');
  openModal({
    title: 'My Profile',
    body: `<dl class="detail-list">
      <div class="detail-list__row"><dt>Name</dt><dd>${escapeHtml(u.name)}</dd></div>
      <div class="detail-list__row"><dt>Email</dt><dd>${escapeHtml(u.email)}</dd></div>
      <div class="detail-list__row"><dt>Role</dt><dd>${escapeHtml(u.roleName)}</dd></div>
      <div class="detail-list__row"><dt>Business</dt><dd>${escapeHtml(b?.name || '—')}</dd></div>
      <div class="detail-list__row"><dt>Branches</dt><dd>${(store.get('branches') || []).filter((x) => u.branchIds?.includes(x.id)).map((x) => escapeHtml(x.name)).join(', ') || 'All'}</dd></div>
      <div class="detail-list__row"><dt>Discount limit</dt><dd>${u.discountLimitPct}%</dd></div>
    </dl>`,
    footer: `<button class="btn btn--primary js-modal-close">Close</button>`,
  });
}

async function openChangePassword() {
  const { createForm } = await import('./components/form.js');
  const authService = (await import('./services/auth-service.js')).default;
  const m = openModal({ title: 'Change Password', size: 'sm', body: '<div></div>' });
  createForm(m.$('.modal__body'), {
    fields: [
      { name: 'currentPassword', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'newPassword', label: 'New password', type: 'password', required: true, rules: [['minLength', 8]], hint: 'At least 8 characters', autocomplete: 'new-password' },
      { name: 'confirm', label: 'Confirm new password', type: 'password', required: true, custom: (v, all) => (v !== all.newPassword ? 'Passwords do not match' : null) },
    ],
    layout: 'stack',
    submitLabel: 'Update password',
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      await authService.changePassword(v.currentPassword, v.newPassword);
      m.close();
      toast.success('Password updated');
    },
  });
}
