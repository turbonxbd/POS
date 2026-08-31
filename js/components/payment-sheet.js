/**
 * payment-sheet.js - the one centralized payment UI for POS TXbd.
 *
 * Used everywhere a merchant pays: initial plan purchase (Live signup),
 * additional branch, and the monthly server & backup charge. The amount is
 * fixed by the caller (computed server-side) and never editable. The merchant
 * picks a payment method configured by Super Admin, follows the Bangla
 * step-by-step instructions, submits the transaction details, and lands on a
 * "pending approval" success screen with a WhatsApp shortcut.
 *
 *   openPaymentSheet({ paymentType, amount, title, referenceLabel, submit, onDone })
 *     submit(fields) -> must resolve to { payment, whatsapp } (throws to show an error)
 *     fields = { methodId, method, accountNumber, reference, proofImage, note }
 */
import { openModal } from './modal.js';
import { toast } from './toast.js';
import money from '../utils/money.js';
import { escapeHtml } from '../utils/dom.js';
import { icon } from './icons.js';
import billingService from '../services/billing-service.js';

const MAX_PROOF = 2 * 1024 * 1024; // 2 MB
const TYPE_TITLE = {
  initial: 'Initial plan purchase',
  monthly: 'Monthly server & backup charge',
  branch: 'Additional branch',
};

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

export async function openPaymentSheet({ paymentType, amount, title, referenceLabel, submit, onDone }) {
  const m = openModal({
    title: title || TYPE_TITLE[paymentType] || 'Make a payment',
    subtitle: referenceLabel || '',
    size: 'md',
    body: '<div class="loading-block"><span class="spinner"></span></div>',
    onClose: () => { if (done) onDone?.(); },
  });

  let done = false;
  let methods = [];
  let manual = true;
  try {
    const s = await billingService.summary();
    methods = (s.paymentMethods || []).filter((x) => x.status !== 'disabled');
    manual = (s.gateway?.driver || 'manual') !== 'mock';
  } catch (err) {
    m.setBody(`<div class="alert alert--danger"><div class="alert__body">${escapeHtml(err?.data?.message || err.message || 'Could not load payment options.')}</div></div>`);
    return;
  }
  if (!methods.length) {
    m.setBody('<div class="alert alert--warning"><div class="alert__body">No payment methods are available right now. Please contact POS TXbd support.</div></div>');
    return;
  }

  let selected = methods[0].id;

  renderForm();

  function renderForm() {
    const total = money.format(amount);
    m.setBody(`
      <div class="payment-sheet">
        <div class="payment-methods">
          ${methods.map((mm) => `
            <button type="button" class="payment-method ${mm.id === selected ? 'is-selected' : ''}" data-id="${escapeHtml(mm.id)}">
              <span class="payment-method__name">${escapeHtml(mm.name)}</span>
              <span class="payment-method__type">${escapeHtml(mm.type === 'bank' ? 'Bank' : mm.type === 'card' ? 'Card' : 'Mobile')}</span>
            </button>`).join('')}
        </div>

        <div class="payment-bill">
          <div class="payment-bill__row"><span>${escapeHtml(referenceLabel || TYPE_TITLE[paymentType] || '')}</span><span></span></div>
          <div class="payment-bill__row payment-bill__row--total"><span>সর্বমোট বিল / Total payable</span><b>${total}</b></div>
        </div>

        <div id="payment-method-detail"></div>

        <form id="payment-form" class="payment-form" novalidate>
          <label class="field"><span class="label">ট্রানজেকশন আইডি / Transaction ID${manual ? ' *' : ''}</span>
            <input class="input" name="reference" autocomplete="off" placeholder="ENTER TRANSACTION ID"></label>
          <label class="field"><span class="label">পেমেন্ট নম্বর / Payment phone or account${manual ? ' *' : ''}</span>
            <input class="input" name="accountNumber" autocomplete="off" placeholder="01XXXXXXXXX"></label>
          <label class="field"><span class="label">পেমেন্ট প্রুফ / Screenshot <span class="muted">(optional)</span></span>
            <input class="input" name="proof" type="file" accept="image/*"></label>
          <label class="field"><span class="label">নোট / Note <span class="muted">(optional)</span></span>
            <textarea class="input" name="note" rows="2"></textarea></label>
          <div class="payment-form__err" id="payment-err" role="alert"></div>
          <button class="btn btn--primary btn--lg btn--block" type="submit">অর্ডার কনফার্ম করুন / Submit payment request</button>
        </form>
      </div>`);

    m.$$('.payment-method').forEach((b) => b.addEventListener('click', () => {
      selected = b.dataset.id;
      m.$$('.payment-method').forEach((x) => x.classList.toggle('is-selected', x.dataset.id === selected));
      renderDetail();
    }));
    renderDetail();

    const form = m.$('#payment-form');
    const err = m.$('#payment-err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const method = methods.find((x) => x.id === selected);
      const reference = form.querySelector('[name=reference]').value.trim();
      const accountNumber = form.querySelector('[name=accountNumber]').value.trim();
      const note = form.querySelector('[name=note]').value.trim();
      if (manual && !reference) { err.textContent = 'ট্রানজেকশন আইডি দিন — Enter the transaction ID.'; return; }
      if (manual && !accountNumber) { err.textContent = 'যে নম্বর থেকে পেমেন্ট করেছেন সেটি দিন — Enter the payment number.'; return; }

      let proofImage = null;
      const file = form.querySelector('[name=proof]').files[0];
      if (file) {
        if (file.size > MAX_PROOF) { err.textContent = 'ছবি ২ MB এর কম হতে হবে — Image must be under 2 MB.'; return; }
        try { proofImage = await readFileAsDataUrl(file); } catch { err.textContent = 'Could not read the image.'; return; }
      }

      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner spinner--invert"></span> Submitting…';
      try {
        const res = await submit({ methodId: method.id, method: method.name, accountNumber, reference, proofImage, note });
        renderSuccess(res);
      } catch (e2) {
        err.textContent = e2?.data?.message || e2.message || 'Could not submit the payment request.';
        btn.disabled = false;
        btn.textContent = 'অর্ডার কনফার্ম করুন / Submit payment request';
      }
    });
  }

  function renderDetail() {
    const method = methods.find((x) => x.id === selected);
    const box = m.$('#payment-method-detail');
    if (!method) { box.innerHTML = ''; return; }
    const steps = String(method.instructionsBn || method.instructionsEn || '').split('\n').map((s) => s.trim()).filter(Boolean);
    box.innerHTML = `
      <div class="payment-detail">
        ${method.accountNumber ? `
          <div class="payment-number">
            <div>
              <span class="payment-number__label">${escapeHtml(method.name)}${method.accountType ? ` · ${escapeHtml(method.accountType)}` : ''}</span>
              <span class="payment-number__value">${escapeHtml(method.accountNumber)}</span>
              ${method.accountName ? `<span class="payment-number__name">${escapeHtml(method.accountName)}</span>` : ''}
            </div>
            <button type="button" class="btn btn--ghost btn--sm" id="payment-copy">${icon('copy', { size: 14 })} Copy</button>
          </div>` : ''}
        ${steps.length ? `<ol class="payment-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
        ${method.note ? `<p class="muted text-sm">${escapeHtml(method.note)}</p>` : ''}
      </div>`;
    m.$('#payment-copy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(method.accountNumber); toast.success('Number copied'); }
      catch { toast.error('Could not copy'); }
    });
  }

  function renderSuccess(res) {
    done = true;
    const p = res?.payment || {};
    m.setBody(`
      <div class="payment-success">
        <div class="payment-success__icon">🎉</div>
        <h3>Congratulations!</h3>
        <p>Your payment request has been submitted successfully.</p>
        <div class="payment-success__facts">
          <div><span>Amount</span><b>${money.format(p.amount ?? amount)}</b></div>
          ${p.reference ? `<div><span>Transaction ID</span><b>${escapeHtml(p.reference)}</b></div>` : ''}
          <div><span>Status</span><b>${p.status === 'paid' ? 'Approved' : 'Pending approval'}</b></div>
        </div>
        <p class="muted">${p.status === 'paid'
          ? 'Your payment is confirmed and your service is active.'
          : 'Your request has been sent to the POS TXbd administration team. Once your payment is verified and approved, your requested service / access will be activated.'}</p>
        <div class="payment-success__actions">
          ${res?.whatsapp ? `<a class="btn btn--primary btn--block" href="${escapeHtml(res.whatsapp)}" target="_blank" rel="noopener">${icon('smartphone', { size: 15 })} Contact via WhatsApp</a>` : ''}
          <button class="btn btn--ghost btn--block" id="payment-done">Done</button>
        </div>
      </div>`);
    m.$('#payment-done').addEventListener('click', () => m.close());
  }
}

export default openPaymentSheet;
