/**
 * app-cashier.js - cashier terminal shell: register gate, top bar, POS, and
 * quick access to held sales / recent transactions / register close.
 */
import { boot, toggleTheme } from './core/boot.js';
import { session } from './core/session.js';
import store from './core/store.js';
import bus from './core/event-bus.js';
import { can } from './core/rbac.js';
import { icon } from './components/icons.js';
import { escapeHtml } from './utils/dom.js';
import { initials } from './utils/format.js';
import money from './utils/money.js';
import { fmtDateTime, fmtTime } from './utils/date.js';
import { toast } from './components/toast.js';
import { openModal } from './components/modal.js';
import { createForm } from './components/form.js';
import { attachMenu } from './components/dropdown.js';
import { printHtml } from './utils/print.js';
import cashRegisterService from './services/cash-register-service.js';
import salesService from './services/sales-service.js';
import settingsService from './services/settings-service.js';
import { renderPOS } from './pages/cashier/pos.js';
import { openExchangeReturn } from './pages/cashier/exchange-return.js';
import { langSwitchHTML, wireLangSwitch } from './components/lang-switch.js';
import { buildReceipt } from './pages/shared/receipt.js';
import { mountSyncStatus } from './pages/cashier/sync-status.js';
import { mountSubscriptionGuard } from './components/subscription-guard.js';
import { xReport, zReport } from './pages/shared/register-report.js';

const root = document.getElementById('pos-root');
let currentSession = null;
let posInstance = null;
let settings = {};

(async () => {
  await boot();
  const authed = await session.restore();
  if (!authed) {
    location.replace('login.html?next=cashier.html');
    return;
  }
  if (!can('pos.operate')) {
    root.innerHTML = gate('No POS access', 'Your role cannot operate the point of sale. Ask an administrator for the "pos.operate" permission.', [{ label: 'Go to Admin', href: 'admin.html' }]);
    return;
  }
  const access = store.get('access');
  if (access?.blocked) {
    root.innerHTML = gate(
      'Subscription needs attention',
      (access.reason || 'This business\'s POS TXbd subscription is not active.') + ' A business owner can settle it from Merchant Admin → Subscription & Billing.',
      [{ label: 'Open Merchant Admin', href: 'admin.html#/billing' }, { label: 'Back to portal', href: 'portal.html' }],
    );
    return;
  }
  settings = await settingsService.getSettings();
  await checkRegister();
})().catch((err) => {
  console.error(err);
  root.innerHTML = gate('Failed to start', err.message + '. Serve the app over HTTP (see README).');
});

async function checkRegister() {
  if (settings.pos?.requireOpenRegister) {
    currentSession = await cashRegisterService.getCurrent().catch(() => null);
    if (!currentSession) {
      renderRegisterGate();
      return;
    }
  } else {
    currentSession = await cashRegisterService.getCurrent().catch(() => null);
  }
  renderTerminal();
}

/* ------------------------------------------------------------- gates */
function gate(title, message, actions = []) {
  return `<div class="gate"><div class="empty-state" style="max-width:420px">
    <div class="empty-state__icon">${icon('drawer', { size: 26 })}</div>
    <h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>
    ${actions.map((a) => `<a class="btn btn--primary" href="${a.href}">${escapeHtml(a.label)}</a>`).join('')}
  </div></div>`;
}

function renderRegisterGate() {
  const user = store.get('user');
  root.innerHTML = `<div class="register-gate">
    <div class="card card--pad stack" style="--stack-gap:var(--sp-4);max-width:420px;text-align:center">
      <span class="avatar avatar--lg" style="margin:0 auto">${escapeHtml(initials(user.name))}</span>
      <div><h2>Open your register</h2><p class="muted">Hi ${escapeHtml(user.name.split(' ')[0])} — enter your opening cash float to start selling.</p></div>
      <form class="stack js-open" style="--stack-gap:var(--sp-3)">
        <label class="field"><span class="label">Opening cash (${money.format(0).split(' ')[0]})</span>
          <input class="input js-opening" type="number" step="0.01" min="0" value="0" style="font-size:var(--fs-xl);height:52px;text-align:center"></label>
        <label class="field"><span class="label">Note <span class="opt">optional</span></span><input class="input js-note" placeholder="e.g. Morning float"></label>
        <button class="btn btn--primary btn--lg" type="submit">Open Register</button>
      </form>
      <button class="btn btn--ghost btn--sm js-signout">Sign out</button>
    </div>
  </div>`;
  root.querySelector('.js-open').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      currentSession = await cashRegisterService.openRegister({
        openingCash: money.toMinor(root.querySelector('.js-opening').value),
        note: root.querySelector('.js-note').value,
      });
      toast.success('Register opened');
      renderTerminal();
    } catch (err) {
      toast.fromError(err);
      btn.disabled = false;
      btn.textContent = 'Open Register';
    }
  });
  root.querySelector('.js-signout').addEventListener('click', () => session.logout());
}

/* --------------------------------------------------------- terminal */
function renderTerminal() {
  const user = store.get('user');
  const branch = (store.get('branches') || []).find((b) => b.id === store.get('activeBranchId'));
  root.innerHTML = `
    <div class="pos-terminal" style="display:flex;flex-direction:column;height:100dvh;overflow:hidden">
      <div class="pos-topbar" id="pos-topbar">
        <div class="pos-brand"><span class="pos-brand__logo">${escapeHtml((store.get('business')?.name || 'A')[0])}</span> ${escapeHtml(store.get('business')?.name || 'POS TXbd')}</div>
        <span class="badge badge--neutral">${escapeHtml(branch?.name || 'Branch')}</span>
        ${currentSession ? `<span class="pos-session">${icon('drawer', { size: 14 })} ${escapeHtml(currentSession.reference || 'Register')} · ${fmtTime(currentSession.openedAt)}</span>` : ''}
        <div class="topbar__spacer"></div>
        ${langSwitchHTML()}
        ${can('sales.refund') ? `<button class="btn btn--ghost btn--sm js-return-btn">${icon('undo', { size: 15 })} <span class="js-hide-sm">Exchange / Return</span></button>` : ''}
        <button class="btn btn--ghost btn--sm js-txn-btn">${icon('history', { size: 15 })} <span class="js-hide-sm">Transactions</span></button>
        <span class="js-sync-mount" style="display:inline-flex"></span>
        <button class="topbar__icon-btn js-theme" aria-label="Theme">${icon('moon')}</button>
        <button class="user-chip js-user">
          <span class="avatar avatar--sm">${escapeHtml(initials(user.name))}</span>
          <span class="user-chip__meta"><strong>${escapeHtml(user.name)}</strong><span>Cashier</span></span>
          ${icon('chevron-down', { size: 14 })}
        </button>
      </div>
      <div class="pos" id="pos" style="flex:1;min-height:0;grid-template-rows:1fr"></div>
      <div class="pos-shortcuts">
        <span><kbd>F1</kbd> Search</span><span><kbd>F2</kbd> Barcode</span><span><kbd>F4</kbd> Customer</span>
        <span><kbd>F8</kbd> Hold</span><span><kbd>F9</kbd> Pay</span><span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> Complete</span><span><kbd>Esc</kbd> Close</span>
      </div>
    </div>`;
  const topbar = root.querySelector('#pos-topbar');
  wireLangSwitch(topbar);
  mountSyncStatus(topbar.querySelector('.js-sync-mount'));
  const mount = root.querySelector('#pos');

  // same subscription banner the Admin panel shows — a blocked subscription is
  // already handled before this render, so this only ever surfaces the soft
  // past-due / trial warning while the till keeps working.
  mountSubscriptionGuard({ bannerBefore: mount, payHref: 'admin.html#/billing' });

  topbar.querySelector('.js-theme').addEventListener('click', (e) => {
    toggleTheme();
    e.currentTarget.innerHTML = icon(document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon');
  });
  topbar.querySelector('.js-txn-btn').addEventListener('click', openTransactions);
  topbar.querySelector('.js-return-btn')?.addEventListener('click', openExchangeReturn);
  attachMenu(topbar.querySelector('.js-user'), () => [
    { label: user.email, header: true },
    can('register.operate') && currentSession && { label: 'Cash In / Out', icon: 'wallet', onSelect: cashMovement },
    can('register.view') && currentSession && { label: 'Print X-Report (mid-shift)', icon: 'receipt', onSelect: printXReport },
    can('register.operate') && currentSession && { label: 'Close Register', icon: 'drawer', onSelect: closeRegister },
    can('dashboard.view') && { label: 'Open Admin', icon: 'dashboard', onSelect: () => (location.href = 'admin.html') },
    { label: 'Back to Portal', icon: 'grid', onSelect: () => (location.href = 'portal.html') },
    { separator: true },
    { label: 'Sign out', icon: 'logout', danger: true, onSelect: () => session.logout() },
  ].filter(Boolean), { align: 'end' });

  renderPOS(mount, { onNeedRegister: renderRegisterGate }).then((inst) => (posInstance = inst));
}

/* keep the catalogue live when the merchant adds / edits products in another
   tab (cross-tab storage event -> data:products / data:product_stock) */
let catRefreshTimer = null;
['data:products', 'data:stock', 'data:inventory_transactions', 'data:categories'].forEach((evt) =>
  bus.on(evt, () => {
    clearTimeout(catRefreshTimer);
    catRefreshTimer = setTimeout(() => posInstance?.refresh?.(), 500);
  }),
);

/* ---------------------------------------------------- transactions */
async function openTransactions() {
  const m = openModal({ title: 'Recent Transactions', size: 'lg', body: '<div class="loading-block"><span class="spinner"></span></div>' });
  try {
    const res = await salesService.getSales({ pageSize: 25, cashierId: store.get('user').id, sort: 'createdAt', dir: 'desc' });
    const rows = res.data || [];
    m.setBody(rows.length ? `<div class="table-wrap"><table class="table table--compact">
      <thead><tr><th>Invoice</th><th>Time</th><th>Customer</th><th class="num">Total</th><th>Payment</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr>
        <td class="mono">${escapeHtml(s.invoiceNo)}</td><td>${fmtTime(s.createdAt)}</td>
        <td>${escapeHtml(s.customerName)}</td><td class="num">${money.format(s.grandTotal)}</td>
        <td><span class="badge badge--neutral">${escapeHtml(s.paymentSummary || '—')}</span></td>
        <td class="num"><button class="btn btn--icon btn--ghost btn--sm js-rp" data-id="${s.id}">${icon('print', { size: 14 })}</button></td>
      </tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><h3>No transactions yet today</h3></div>`);
    m.$$('.js-rp').forEach((b) => b.addEventListener('click', async () => {
      const full = await salesService.getSaleById(b.dataset.id);
      const s = await settingsService.getSettings();
      printHtml(buildReceipt(full, { settings: s }));
    }));
  } catch (err) {
    m.setBody(`<p class="text-danger">${escapeHtml(err.message)}</p>`);
  }
}

async function cashMovement() {
  const m = openModal({ title: 'Cash In / Out', size: 'sm', body: '<div></div>' });
  createForm(m.$('.modal__body'), {
    fields: [
      { name: 'direction', label: 'Type', type: 'select', required: true, options: [{ value: 'in', label: 'Cash In (add to drawer)' }, { value: 'out', label: 'Cash Out (remove from drawer)' }] },
      { name: 'amount', label: 'Amount', type: 'money', required: true },
      { name: 'reason', label: 'Reason', type: 'select', options: [{ value: 'cash_in', label: 'Float top-up' }, { value: 'petty_cash', label: 'Petty cash' }, { value: 'bank_deposit', label: 'Bank deposit' }, { value: 'correction', label: 'Correction' }] },
      { name: 'note', label: 'Note', type: 'textarea', rows: 2 },
    ],
    layout: 'stack',
    submitLabel: 'Record movement',
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      await cashRegisterService.addMovement(currentSession.id, v);
      m.close();
      toast.success('Cash movement recorded');
    },
  });
}

async function printXReport() {
  try {
    const s = await cashRegisterService.getSessionById(currentSession.id);
    printHtml(xReport(s));
  } catch (err) {
    toast.fromError(err);
  }
}

async function closeRegister() {
  const blind = settings.pos?.blindClose === true;
  const m = openModal({ title: 'Close Register', size: 'md', body: '<div class="loading-block"><span class="spinner"></span></div>' });
  const s = await cashRegisterService.getSessionById(currentSession.id);

  const breakdown = blind
    ? `<p class="muted text-sm" style="margin-bottom:var(--sp-4)">Count everything in the drawer and enter the total. The expected amount and any difference are only shown on the Z-Report after you close.</p>`
    : `<div class="stat-strip" style="margin-bottom:var(--sp-4)">
        <div class="stat-strip__item"><div class="label">Opening cash</div><div class="value">${money.format(s.openingCash)}</div></div>
        <div class="stat-strip__item"><div class="label">Cash sales</div><div class="value">${money.format(s.cashSales)}</div></div>
        <div class="stat-strip__item"><div class="label">Cash refunds</div><div class="value">${money.format(s.cashRefunds)}</div></div>
        <div class="stat-strip__item"><div class="label">Cash expenses</div><div class="value">${money.format(s.cashExpenses)}</div></div>
        <div class="stat-strip__item"><div class="label">Cash in / out</div><div class="value">${money.format(s.cashIn - s.cashOut)}</div></div>
        <div class="stat-strip__item"><div class="label">Expected in drawer</div><div class="value">${money.format(s.expectedCash)}</div></div>
      </div>`;

  m.setBody(`
    ${breakdown}
    <label class="field"><span class="label">Counted cash in drawer</span>
      <input class="input js-counted" type="number" step="0.01" min="0" style="font-size:var(--fs-xl);height:52px" value="${blind ? '' : money.toMajor(s.expectedCash)}" placeholder="0.00" ${blind ? 'autofocus' : ''}></label>
    ${blind ? '' : `<div class="alert js-diff" style="margin-top:var(--sp-3)"><div class="alert__body">Difference: <strong class="js-diff-v">৳ 0.00</strong></div></div>`}
    <label class="field" style="margin-top:var(--sp-3)"><span class="label">Closing note</span><textarea class="textarea js-cnote" rows="2"></textarea></label>`);
  m.setFooter(`<button class="btn btn--ghost js-cancel">Cancel</button><button class="btn btn--primary js-do">Close & Print Z-Report</button>`);
  const counted = m.$('.js-counted');
  if (!blind) {
    const diffV = m.$('.js-diff-v');
    const diffBox = m.$('.js-diff');
    const recalc = () => {
      const d = money.toMinor(counted.value) - s.expectedCash;
      diffV.textContent = money.format(d);
      diffBox.className = 'alert js-diff ' + (d === 0 ? 'alert--success' : d > 0 ? 'alert--info' : 'alert--danger');
    };
    counted.addEventListener('input', recalc);
    recalc();
  }
  m.$('.js-cancel').addEventListener('click', () => m.close());
  m.$('.js-do').addEventListener('click', async () => {
    if (blind && counted.value === '') { toast.warning('Enter the counted cash amount.'); return; }
    m.setBusy(true);
    try {
      const closed = await cashRegisterService.closeRegister(currentSession.id, {
        countedCash: money.toMinor(counted.value || 0),
        note: m.$('.js-cnote').value,
      });
      m.close();
      toast.success('Register closed');
      printHtml(zReport(closed));
      currentSession = null;
      renderRegisterGate();
    } catch (err) {
      m.setBusy(false);
      toast.fromError(err);
    }
  });
}

bus.on('pos:sale-completed', () => {
  // keep the header session badge fresh, no full re-render
});
