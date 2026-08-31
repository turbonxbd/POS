/**
 * app-live.js - POS TXbd public / Live panel.
 *
 * Marketing site on the main domain. Explains the product, shows how it works,
 * lists features, and prices straight from the plans API (GET /plans - one
 * source of truth). "Get started" opens a signup form; on success the new
 * merchant lands in their Portal. "Talk to us" opens WhatsApp.
 *
 * No authentication. Merchant staff go to portal.html directly.
 */
import { boot } from './core/boot.js';
import config from './config.js';
import { session } from './core/session.js';
import http from './core/http.js';
import { platformService } from './services/platform-service.js';
import { openModal } from './components/modal.js';
import { createForm } from './components/form.js';
import { openPaymentSheet } from './components/payment-sheet.js';
import billingService from './services/billing-service.js';
import { toast } from './components/toast.js';
import money from './utils/money.js';
import { escapeHtml } from './utils/dom.js';
import { mountChatWidget } from './pages/live/chat-widget.js';

// Contact details come from Super Admin (GET /public-settings) - one source of
// truth. config.platform.* is only the fallback before that call resolves.
let NAME = config.platform.name;
let WA = config.platform.whatsapp;
let SALES_EMAIL = config.platform.salesEmail;
const waLink = (text) => `https://wa.me/${WA}?text=${encodeURIComponent(text)}`;

const STEPS = [
  ['Add products & stock', 'The merchant loads their catalogue and opening stock — per branch.', 'box'],
  ['Organised in the system', 'Products, prices, barcodes and inventory are kept together and always in sync.', 'database'],
  ['A customer walks in', 'They pick what they want and come to the counter.', 'user'],
  ['Scan the barcode', 'The cashier scans each item — no typing, no lookups.', 'barcode'],
  ['Added to the cart', 'The product drops straight into the POS cart at the right price.', 'cart'],
  ['Take payment', 'Cash, card, bKash, Nagad — with change and split payments handled.', 'wallet'],
  ['Invoice printed', 'A clean invoice / receipt is generated and printed on the spot.', 'receipt'],
  ['Stock goes down', 'The sold quantity is deducted from inventory automatically — no drift.', 'warehouse'],
  ['See the whole business', 'Sales, profit, stock, payments and staff performance on one dashboard.', 'chart'],
];

const FEATURES = [
  ['pos', 'POS sales terminal', 'Fast keyboard-first checkout built for a busy counter.'],
  ['barcode', 'Barcode scanning & printing', 'Scan to sell; generate and print barcode labels in bulk.'],
  ['box', 'Product management', 'Variants, categories, brands, MRP and wholesale pricing.'],
  ['warehouse', 'Inventory & branch stock', 'An immutable ledger — adjustments, transfers, valuation.'],
  ['building', 'Multi-branch', 'Run several outlets from one account, each with its own stock.'],
  ['users', 'Customers & loyalty', 'Customer accounts, due balances and loyalty points.'],
  ['user', 'Cashier management', 'Roles, permissions and per-cashier register reconciliation.'],
  ['receipt', 'Invoices & payments', 'Every sale keeps a snapshot; every payment is a transaction.'],
  ['rotate-ccw', 'Exchange & return', 'Return to stock, price replacements, settle the difference.'],
  ['chart', 'Reports & analytics', '16 report types plus a live dashboard from real transactions.'],
  ['print', 'Configurable printing', 'Invoice, receipt and barcode layouts you control.'],
  ['database', 'Your data, backed up', 'Self-hosted on your own server with scheduled backups.'],
];

const root = document.getElementById('app-root');

(async () => {
  await boot({ seedIfEmpty: true });

  try {
    const s = await platformService.publicSettings();
    if (s?.contact) {
      NAME = s.contact.businessName || NAME;
      WA = s.contact.whatsapp || WA;
      SALES_EMAIL = s.contact.salesEmail || s.contact.email || SALES_EMAIL;
    }
  } catch { /* fall back to config.platform.* */ }

  document.title = `${NAME} — Point of Sale software for retail`;

  let plans = [];
  try {
    plans = (await platformService.publicPlans()).data || [];
  } catch { /* still render the page without pricing */ }

  render(plans);
  mountChatWidget(NAME);
})().catch((err) => {
  console.error(err);
  render([]);
});

function render(plans) {
  root.className = 'live';
  root.innerHTML = `
  <header class="live-nav">
    <a class="live-nav__brand" href="#top">${logo()}<span>${escapeHtml(NAME)}</span></a>
    <nav class="live-nav__links">
      <a href="#how">How it works</a>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a class="btn btn--ghost btn--sm" href="portal.html">Merchant sign-in</a>
      <button class="btn btn--primary btn--sm" id="cta-top">Get started</button>
    </nav>
  </header>

  <section class="live-hero" id="top">
    <div class="live-hero__in">
      <span class="live-hero__eyebrow">Point of Sale · Inventory · Analytics</span>
      <h1>Run your shop on <span>${escapeHtml(NAME)}</span></h1>
      <p>A complete point-of-sale for Bangladesh retail — barcode checkout, branch-wise stock,
         invoices, exchange &amp; return, staff roles and a real-time dashboard. Self-hosted, so
         your business data stays yours.</p>
      <div class="live-hero__cta">
        <button class="btn btn--primary btn--lg" id="cta-hero">Get started</button>
        <a class="btn btn--ghost btn--lg" href="#pricing">View plans</a>
        <a class="btn btn--ghost btn--lg" href="${waLink(`Hi ${NAME}, I'd like to know more about your POS.`)}" target="_blank" rel="noopener">Talk to us on WhatsApp</a>
      </div>
      <div class="live-hero__points">
        <span>${tick()} No per-sale fees</span>
        <span>${tick()} Works on any device</span>
        <span>${tick()} Your own server &amp; backups</span>
      </div>
    </div>
  </section>

  <section class="live-sec" id="how">
    <h2>How ${escapeHtml(NAME)} works</h2>
    <p class="live-sec__lead">From stocking a product to seeing the profit — nine steps, fully automatic.</p>
    <ol class="live-steps">
      ${STEPS.map(([t, d, ic], i) => `
        <li class="live-step" style="--i:${i}">
          <span class="live-step__n">${i + 1}</span>
          <span class="live-step__icon">${iconSvg(ic)}</span>
          <div><h3>${escapeHtml(t)}</h3><p>${escapeHtml(d)}</p></div>
        </li>`).join('')}
    </ol>
  </section>

  <section class="live-sec live-sec--tint" id="features">
    <h2>Everything a retail counter needs</h2>
    <p class="live-sec__lead">Built from the real ${escapeHtml(NAME)} system — not a mock-up.</p>
    <div class="live-features">
      ${FEATURES.map(([ic, t, d]) => `
        <div class="live-feature">
          <span class="live-feature__icon">${iconSvg(ic)}</span>
          <h3>${escapeHtml(t)}</h3><p>${escapeHtml(d)}</p>
        </div>`).join('')}
    </div>
  </section>

  <section class="live-sec" id="pricing">
    <h2>Simple pricing</h2>
    <p class="live-sec__lead">Pick a plan, pay monthly. Prices update live from our system — no surprises.</p>
    <div class="live-plans">
      ${plans.length ? plans.map(planCard).join('') : `<p class="muted">Plans are loading — or <a href="${waLink('Hi, please send me your POS plans and pricing.')}" target="_blank" rel="noopener">ask us on WhatsApp</a>.</p>`}
    </div>
    <p class="live-plans__note">All plans include barcode checkout, invoices, exchange &amp; return, reports and printing.
      Need something custom? <a href="${waLink('Hi, I need a custom POS plan.')}" target="_blank" rel="noopener">Message us</a>.</p>
  </section>

  <section class="live-sec live-sec--cta" id="contact">
    <div class="live-cta">
      <h2>Ready to start selling on ${escapeHtml(NAME)}?</h2>
      <p>Create your account now — you'll be in your dashboard in under a minute.</p>
      <div class="live-cta__row">
        <button class="btn btn--primary btn--lg" id="cta-bottom">Get started</button>
        <a class="btn btn--ghost btn--lg" href="${waLink(`Hi ${NAME}, I want to buy a plan.`)}" target="_blank" rel="noopener">Buy via WhatsApp</a>
      </div>
      <p class="live-cta__contact">Or email <a href="mailto:${escapeHtml(SALES_EMAIL)}">${escapeHtml(SALES_EMAIL)}</a></p>
    </div>
  </section>

  <footer class="live-foot">
    <span>${escapeHtml(NAME)} · Point of Sale</span>
    <span><a href="portal.html">Merchant sign-in</a> · <a href="${waLink('Hi, I have a question about POS TXbd.')}" target="_blank" rel="noopener">Support</a></span>
    <span>&copy; ${new Date().getFullYear()} ${escapeHtml(NAME)}</span>
  </footer>`;

  const planIds = new Set(plans.map((p) => p.id));
  root.querySelectorAll('#cta-top,#cta-hero,#cta-bottom').forEach((b) => b.addEventListener('click', () => openSignup(null, plans)));
  root.querySelectorAll('.js-choose').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.plan;
    openSignup(planIds.has(id) ? id : null, plans);
  }));
  root.querySelectorAll('.js-wa').forEach((a) => { /* plain links, nothing to wire */ void a; });
}

/* ---------------------------------------------------------- plan card */
function planCard(p) {
  const monthly = p.monthlyPrice ?? p.price ?? 0;
  const setup = p.setupPrice || 0;
  const branches = p.includedBranches ?? 1;
  return `<div class="live-plan ${p.popular ? 'is-popular' : ''}">
    ${p.popular ? '<span class="live-plan__tag">Most popular</span>' : ''}
    <h3>${escapeHtml(p.name)}</h3>
    <div class="live-plan__price">${money.format(monthly)}<span>/ ${escapeHtml(p.billingPeriod === 'yearly' ? 'year' : 'month')}</span></div>
    <div class="live-plan__terms">
      <span>One-time setup <b>${money.format(setup)}</b></span>
      <span>${branches} branch${branches === 1 ? '' : 'es'} included</span>
      <span>Monthly charge covers hosting &amp; daily backups</span>
    </div>
    <p class="live-plan__desc">${escapeHtml(p.description || '')}</p>
    <ul>${(p.features || []).map((f) => `<li>${tick()} ${escapeHtml(f)}</li>`).join('')}</ul>
    <button class="btn btn--primary btn--block js-choose" data-plan="${escapeHtml(p.id)}">Choose ${escapeHtml(p.name)}</button>
    <a class="live-plan__wa" href="${waLink(`Hi ${NAME}, I want the ${p.name} plan — setup ${money.format(setup)}, then ${money.format(monthly)}/mo.`)}" target="_blank" rel="noopener">or ask on WhatsApp</a>
  </div>`;
}

/* ---------------------------------------------------------- signup */
function openSignup(planId, plans) {
  const chosen = plans.find((p) => p.id === planId);
  const planLabel = (p) => `${p.name} — setup ${money.format(p.setupPrice || 0)}, then ${money.format(p.monthlyPrice ?? p.price ?? 0)}/mo`;
  const m = openModal({
    title: 'Create your POS TXbd account',
    subtitle: chosen ? planLabel(chosen) : 'Start with any plan — change it any time',
    size: 'md', body: '<div></div>',
  });
  const sellable = (plans || []).filter((p) => p.status !== 'archived');
  if (!sellable.length) {
    m.setBody('<div class="alert alert--warning"><div class="alert__body">Plans are still loading — please refresh and try again, or message us on WhatsApp.</div></div>');
    return;
  }
  const form = createForm(m.$('.modal__body'), {
    fields: [
      { name: 'businessName', label: 'Business name', required: true },
      { name: 'ownerName', label: 'Your name' },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Choose a password', type: 'password', required: true, rules: [['minLength', 8]], hint: 'At least 8 characters' },
      { name: 'planId', label: 'Plan', type: 'select', required: true, placeholder: 'Choose a plan…',
        value: (planId && sellable.some((p) => p.id === planId)) ? planId : (sellable[0]?.id || ''),
        options: sellable.map((p) => ({ value: p.id, label: planLabel(p) })) },
    ],
    submitLabel: 'Create account & open my dashboard',
    onCancel: () => m.close(),
    onSubmit: async (v) => {
      if (!v.planId) { form.setError('planId', 'Choose a plan'); return; }
      try {
        await http.post('/signup', v);
      } catch (err) {
        if (err?.data?.errors) { Object.entries(err.data.errors).forEach(([f, msg]) => form.setError(f, msg)); return; }
        throw err;
      }
      // establish the session, then collect the plan's setup payment right here
      await session.login(v.email.trim().toLowerCase(), v.password);
      m.close();
      let summary = null;
      try { summary = await billingService.summary(); } catch { /* fall through to the portal */ }
      const sub = summary?.subscription;
      if (sub && (sub.setupPrice || 0) > 0 && !sub.setupPaid) {
        toast.success('Account created — complete your payment to activate.');
        await openPaymentSheet({
          paymentType: 'initial',
          amount: sub.setupPrice,
          title: `${sub.planName || 'Your plan'} — initial purchase`,
          referenceLabel: `${sub.planName || 'Plan'} plan · one-time setup`,
          submit: (f) => billingService.pay({ type: 'initial', ...f }),
          onDone: () => { location.href = 'portal.html'; },
        });
      } else {
        toast.success('Welcome to POS TXbd!');
        location.href = 'portal.html';
      }
    },
  });
}

/* ---------------------------------------------------------- tiny assets */
function iconSvg(name) {
  // reuse the app icon set
  return `<svg width="22" height="22" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ICON.box}</svg>`;
}
const ICON = {
  box: '<path d="M21 8v9l-9 5-9-5V8l9-5 9 5z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
  barcode: '<path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4A2 2 0 0 0 9.6 16h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  warehouse: '<path d="M3 21V8l9-5 9 5v13M3 21h18M7 21v-8h10v8"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l3-4 4 3 5-7"/>',
  pos: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 15h.01M12 15h4"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="1"/><path d="M9 22v-4h6v4"/>',
  'rotate-ccw': '<polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>',
  print: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
};
function tick() { return '<svg width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'; }
function logo() { return '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 15h.01M12 15h4"/></svg>'; }
