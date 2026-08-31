/**
 * help.js - in-app help & support. FAQ + a real "contact POS TXbd" channel
 * (POST /support -> Super Admin -> Support, plus a WhatsApp shortcut using the
 * platform's configured number).
 */
import { pageShell } from '../shared/page-kit.js';
import { escapeHtml } from '../../utils/dom.js';
import { toast } from '../../components/toast.js';
import config from '../../config.js';
import store from '../../core/store.js';
import http from '../../core/http.js';

const FAQ = [
  ['How is stock kept accurate?', 'Every stock change (sale, purchase, return, adjustment, transfer) writes an immutable row to the inventory ledger and updates a cached balance in the same transaction. Refreshing the page never recalculates from screen state, so numbers cannot drift.'],
  ['Can a sale be duplicated by double-clicking?', 'No. Each checkout generates an idempotency key. The "Pay" button locks while processing, and a repeated submission with the same key returns the original sale instead of creating a new one.'],
  ['What happens to sales if I archive a product?', 'Nothing. Sale line items store a snapshot of the product name, SKU and price at the time of sale. Archiving only hides the product from the POS and active lists — history stays valid, and you can restore it.'],
  ['How do keyboard shortcuts work at the till?', 'F1 focuses search, F2 the barcode field, F4 opens customer selection, F8 holds the sale, F9 (or Ctrl+Enter) opens payment, and Esc closes dialogs.'],
  ['How do I switch branches?', 'Use the branch selector in the top bar. Stock, sales, purchases and registers are all scoped to the selected branch.'],
  ['How does billing work?', 'A one-time setup fee activates your account, then a monthly server & backup charge keeps it running. Pay and see your next billing date under Subscription & Billing. Extra branches beyond your plan are a one-off purchase.'],
  ['Is my data safe if I close the browser?', 'In this demo, data is stored locally in your browser and persists across refreshes and restarts. Export a JSON backup from Settings → Backup regularly. When connected to a real backend, data lives on the server.'],
];

export default async function helpPage(ctx, mount) {
  const shell = pageShell(mount, { title: 'Help & Support', subtitle: `${config.app.name} POS v${config.app.version} · ${config.app.build}` });

  let contact = {};
  try { contact = (await http.get('/public-settings')).contact || {}; } catch { /* offline */ }
  const wa = String(contact.whatsapp || config.platform.whatsapp || '').replace(/[^\d]/g, '');
  const supportEmail = contact.email || config.app.supportEmail;
  const biz = store.get('business')?.name || '';
  const waHref = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(`Hi POS TXbd, this is ${biz}. `)}` : '';

  shell.body.innerHTML = `
    <div class="form-layout">
      <div class="form-layout__main">
        <div class="card">
          <div class="card__header"><h3>Frequently asked questions</h3></div>
          <div class="card__body stack" style="--stack-gap:0">
            ${FAQ.map(([q, a]) => `<details style="border-bottom:1px solid var(--border-subtle);padding:var(--sp-3) 0">
              <summary style="font-weight:600;cursor:pointer">${escapeHtml(q)}</summary>
              <p class="muted text-sm" style="margin-top:var(--sp-2)">${escapeHtml(a)}</p>
            </details>`).join('')}
          </div>
        </div>
        <div class="card card--pad">
          <div class="form-section-title">Cashier quick reference</div>
          <div class="kbd-hints" style="gap:var(--sp-4)">
            <span><kbd>F1</kbd> Search</span><span><kbd>F2</kbd> Barcode</span><span><kbd>F4</kbd> Customer</span>
            <span><kbd>F8</kbd> Hold sale</span><span><kbd>F9</kbd> Payment</span>
            <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> Complete sale</span><span><kbd>Esc</kbd> Close dialog</span>
          </div>
        </div>
      </div>
      <div class="form-layout__side">
        <div class="card card--pad">
          <div class="form-section-title">Contact POS TXbd</div>
          <form id="help-support" class="stack" style="--stack-gap:var(--sp-2)">
            <label class="field"><span class="label">Subject</span>
              <input class="input" name="subject" placeholder="e.g. Question about billing" required></label>
            <label class="field"><span class="label">Message</span>
              <textarea class="textarea" name="message" rows="4" required></textarea></label>
            <button class="btn btn--primary btn--block" type="submit">Send to support</button>
          </form>
          ${waHref ? `<a class="btn btn--outline btn--block js-wa" href="${waHref}" target="_blank" rel="noopener" style="margin-top:var(--sp-2)">Message on WhatsApp</a>` : ''}
          <dl class="detail-list" style="margin-top:var(--sp-3)">
            <div class="detail-list__row"><dt>Email</dt><dd><a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></dd></div>
            ${contact.supportPhone ? `<div class="detail-list__row"><dt>Phone</dt><dd>${escapeHtml(contact.supportPhone)}</dd></div>` : ''}
            ${contact.supportHours ? `<div class="detail-list__row"><dt>Hours</dt><dd>${escapeHtml(contact.supportHours)}</dd></div>` : ''}
            <div class="detail-list__row"><dt>Business</dt><dd>${escapeHtml(biz || '—')}</dd></div>
          </dl>
        </div>
        <div class="card card--pad">
          <div class="form-section-title">Data mode</div>
          <p class="text-sm">${config.api.mode === 'mock' ? 'Running on the local demo database. Your changes are saved in this browser.' : `Connected to <span class="mono">${escapeHtml(config.api.baseUrl)}</span>`}</p>
          <a class="btn btn--outline btn--sm btn--block" href="#/backup" style="margin-top:var(--sp-2)">Backup / restore data</a>
        </div>
      </div>
    </div>`;

  const form = shell.body.querySelector('#help-support');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await http.post('/support', {
        name: store.get('user')?.name || '',
        email: store.get('user')?.email || supportEmail,
        subject: form.querySelector('[name=subject]').value.trim(),
        message: form.querySelector('[name=message]').value.trim(),
      });
      toast.success('Sent — the POS TXbd team will get back to you.');
      form.reset();
    } catch (err) {
      toast.error(err?.data?.message || 'Could not send. Try email or WhatsApp.');
    } finally {
      btn.disabled = false;
    }
  });
}
