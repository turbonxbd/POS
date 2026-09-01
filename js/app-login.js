/**
 * app-login.js - sign-in screen controller.
 */
import { boot } from './core/boot.js';
import { session } from './core/session.js';
import store from './core/store.js';
import db from './core/db.js';
import { escapeHtml } from './utils/dom.js';
import { toast } from './components/toast.js';
import { mountLangSwitch } from './components/lang-switch.js';

// Only accounts that actually exist in the seeded DB are shown; the demo
// merchant "TX Demo" ships with just the Branch Owner - add Cashier / Manager /
// etc. from Merchant Admin -> Employees.
const DEMO = [
  ['admin@txdemo.shop', 'Afia Rahman', 'Branch Owner'],
  ['manager@txdemo.shop', 'Tania Islam', 'Manager'],
  ['cashier@txdemo.shop', 'Rakib Hasan', 'Cashier'],
  ['inventory@txdemo.shop', 'Sabbir Ahmed', 'Inventory Manager'],
  ['accounts@txdemo.shop', 'Farhana Akter', 'Accountant'],
];

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submitBtn = form.querySelector('button[type="submit"]');

document.getElementById('year').textContent = new Date().getFullYear();

(async () => {
  await boot();
  import('./components/install-prompt.js').then((m) => m.startInstallPrompt()).catch(() => {});
  const corner = document.createElement('div');
  corner.style.cssText = 'position:fixed;top:16px;right:16px;z-index:50';
  document.body.appendChild(corner);
  mountLangSwitch(corner);
  // already signed in? go straight through
  const restored = await session.restore();
  if (restored) {
    routeIn();
    return;
  }
  renderDemoList();
})();

function renderDemoList() {
  const list = document.getElementById('demo-list');
  // Only show accounts that actually exist in the seeded DB
  const existing = new Set(db.collection('users').all().map((u) => u.email));
  list.innerHTML = DEMO.filter(([email]) => existing.has(email))
    .map(
      ([email, name, role]) =>
        `<button type="button" class="js-demo" data-email="${escapeHtml(email)}">
          <span>${escapeHtml(name)} <span class="muted">· ${escapeHtml(role)}</span></span>
          <span class="badge badge--brand">use</span>
        </button>`,
    )
    .join('');
  list.querySelectorAll('.js-demo').forEach((b) =>
    b.addEventListener('click', () => {
      form.email.value = b.dataset.email;
      form.password.value = 'demo1234';
      form.requestSubmit();
    }),
  );
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.hidden = true;
  const email = form.email.value.trim();
  const password = form.password.value;
  if (!email || !password) {
    showError('Enter your email and password.');
    return;
  }
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner spinner--invert"></span> Signing in…';
  try {
    await session.login(email, password);
    toast.success('Signed in');
    routeIn();
  } catch (err) {
    showError(err?.data?.message || err?.message || 'Sign in failed. Check your credentials.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
  }
});

function showError(msg) {
  errorBox.hidden = false;
  errorBox.querySelector('.alert__body').textContent = msg;
}

function routeIn() {
  const perms = store.get('permissions');
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  if (next && /^(admin|cashier)\.html/.test(next)) {
    location.replace(next);
    return;
  }
  const cashierOnly = perms.has('pos.operate') && !perms.has('dashboard.view') && !perms.has('*');
  location.replace(cashierOnly ? 'cashier.html' : 'admin.html');
}
