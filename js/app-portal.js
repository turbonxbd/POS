/**
 * app-portal.js - the POS TXbd merchant portal.
 *
 * The merchant signs in here with their own account (email + password). Once in,
 * they pick the Admin panel or the Cashier terminal - both open already
 * authenticated. Cashier-only staff only see the Cashier card.
 *
 * There is no shared access code: every merchant is isolated behind their own
 * login, and the Live-site signup flow lands here already signed in.
 */
import config from './config.js';
import { boot, toggleTheme } from './core/boot.js';
import { session } from './core/session.js';
import store from './core/store.js';
import { can } from './core/rbac.js';
import { icon } from './components/icons.js';
import { escapeHtml } from './utils/dom.js';
import { initials } from './utils/format.js';
import { mountLangSwitch } from './components/lang-switch.js';
import { openModal } from './components/modal.js';
import { toast } from './components/toast.js';
import { authService } from './services/auth-service.js';
import { platformService } from './services/platform-service.js';

const card = document.getElementById('portal-card');

document.getElementById('theme-toggle').addEventListener('click', () => toggleTheme());
document.getElementById('portal-version').textContent = `POS TXbd · v${config.app.version}`;

(async () => {
  await boot();
  mountLangSwitch(document.querySelector('.portal__foot'));
  import('./components/install-prompt.js').then((m) => m.startInstallPrompt()).catch(() => {});

  let user = null;
  try {
    if (await session.restore()) user = store.get('user');
  } catch { /* not signed in */ }

  if (user && !user.platform) renderPicker();
  else if (user && user.platform) {
    // A platform (Super Admin) account has no place in the merchant portal.
    // Drop the session and send them back to the merchant sign-in form - the
    // Super Admin panel is reachable only from its own dedicated URL.
    await session.logout({ redirect: false });
    renderLogin('That is a platform account. The Super Admin panel is on its own separate URL, not the merchant portal.');
  } else renderLogin();
})().catch((err) => {
  console.error(err);
  card.innerHTML = `<div class="alert alert--danger"><div class="alert__body">Could not start: ${escapeHtml(err.message)}. Serve the site over HTTP (see README).</div></div>`;
});

/* ------------------------------------------------------------------ login */
function renderLogin(message) {
  card.innerHTML = `
    <form class="portal-login" id="login-form" autocomplete="on" novalidate>
      <span class="portal-login__icon">${icon('shield', { size: 20 })}</span>
      <h2>Merchant sign in</h2>
      <p class="muted">Use your POS TXbd account to open your panels.</p>
      ${message ? `<div class="alert alert--danger" style="margin:8px 0"><div class="alert__body">${escapeHtml(message)}</div></div>` : ''}
      <label class="field"><span class="label">Email</span>
        <input class="input" type="email" name="email" autocomplete="username" required autofocus></label>
      <label class="field"><span class="label">Password</span>
        <input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <div class="portal-login__err" id="login-err" role="alert"></div>
      <button class="btn btn--primary btn--lg btn--block" type="submit">Sign in</button>
      <p class="portal-login__foot"><a href="#" id="forgot-link">Forgot your password?</a> · <a href="index.html">See our plans &rarr;</a></p>
    </form>`;

  const form = document.getElementById('login-form');
  const err = document.getElementById('login-err');
  document.getElementById('forgot-link').addEventListener('click', (e) => { e.preventDefault(); openForgot(emailEl.value.trim()); });
  const emailEl = form.querySelector('[name=email]');
  const pwEl = form.querySelector('[name=password]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner--invert"></span> Signing in…';
    try {
      await session.login(emailEl.value.trim(), pwEl.value);
      const u = store.get('user');
      if (u?.platform) {
        await session.logout({ redirect: false });
        renderLogin('That is a platform account. The Super Admin panel is on its own separate URL, not the merchant portal.');
        return;
      }
      renderPicker();
    } catch (e2) {
      err.textContent = e2?.data?.message || e2.message || 'Sign in failed.';
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
}

/* ------------------------------------------------------------- forgot */
async function openForgot(prefill) {
  let wa = null;
  try { wa = (await platformService.publicSettings())?.contact?.whatsapp || null; } catch { /* offline */ }
  const m = openModal({
    title: 'Reset your password',
    size: 'sm',
    body: `<p class="text-sm muted">Enter the email on your account. We'll send the request to the POS TXbd team, who will verify it and give you a temporary password.</p>
      <label class="field"><span class="label">Account email</span>
        <input class="input js-fp-email" type="email" value="${escapeHtml(prefill || '')}" autocomplete="username" autofocus></label>`,
    footer: `<button class="btn btn--ghost js-modal-close">Cancel</button><button class="btn btn--primary js-fp-send">Send request</button>`,
  });
  m.$('.js-fp-send').addEventListener('click', async () => {
    const email = m.$('.js-fp-email').value.trim();
    if (!email) { toast.warning('Enter your account email.'); return; }
    m.setBusy(true);
    try { await authService.forgotPassword(email); } catch { /* never reveal */ }
    const waLink = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(`Hi, I'm locked out of my POS TXbd account (${email}) and need a password reset.`)}` : null;
    m.setBody(`<div class="alert alert--success"><div class="alert__body">
      Request received. The team will verify it and contact you with a temporary password.
      ${waLink ? `<br><a href="${waLink}" target="_blank" rel="noopener">Message support on WhatsApp &rarr;</a>` : ''}
    </div></div>`);
    m.setFooter('<button class="btn btn--primary js-modal-close">Done</button>');
  });
}

/* -------------------------------------------------------------- picker */
function renderPicker() {
  const user = store.get('user');
  const business = store.get('business');
  const access = store.get('access');

  const canAdmin = can('dashboard.view') || can('*');
  const canPos = can('pos.operate') || can('*');

  const subNotice = (access && !['active', 'platform', 'none', undefined, null].includes(access.state))
    ? `<div class="alert alert--${access.blocked ? 'danger' : 'warning'}" style="margin-bottom:var(--sp-3)"><div class="alert__body">
        ${escapeHtml(access.reason || 'Your subscription needs attention.')}
        ${canAdmin ? '<a href="admin.html#/billing">Open billing &rarr;</a>' : ''}
      </div></div>`
    : '';

  card.innerHTML = `
    <div class="portal-session">
      <span class="avatar avatar--sm">${escapeHtml(initials(user.name))}</span>
      <div class="grow"><strong>${escapeHtml(business?.name || user.name)}</strong><br>
        <span class="muted">${escapeHtml(user.name)} · ${escapeHtml(user.roleName || '')}</span></div>
      <button class="btn btn--ghost btn--sm" id="signout">Sign out</button>
    </div>
    ${subNotice}

    <div class="portal-panels">
      ${canAdmin ? `<a class="panel-card panel-card--admin" href="admin.html">
        <span class="panel-card__icon">${icon('dashboard', { size: 22 })}</span>
        <h3>Merchant Admin</h3>
        <p>Products, inventory, barcodes, purchases, customers, staff, reports, billing &amp; settings.</p>
        <span class="panel-card__go">Open admin ${icon('arrow-left', { size: 14, cls: 'flip' })}</span>
      </a>` : ''}
      <a class="panel-card panel-card--pos" href="cashier.html">
        <span class="panel-card__icon">${icon('pos', { size: 22 })}</span>
        <h3>Cashier / POS</h3>
        <p>Fast checkout terminal — scan, add to cart, take payment, print the receipt.</p>
        <span class="panel-card__go">Open cashier ${icon('arrow-left', { size: 14 })}</span>
      </a>
    </div>
    ${!canPos && !canAdmin ? '<p class="muted" style="text-align:center">Your role has no panel access yet. Ask your business owner.</p>' : ''}`;

  document.querySelectorAll('.panel-card .flip').forEach((s) => (s.style.transform = 'rotate(180deg)'));
  document.getElementById('signout').addEventListener('click', async () => {
    await session.logout({ redirect: false });
    renderLogin();
  });
}
