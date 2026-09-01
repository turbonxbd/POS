/**
 * payment.js - payment modal. Resolves with { payments, onAccount, redeemPoints }
 * or null. Cashier picks the tender directly: Cash, bKash, Nagad, Rocket, Bank,
 * Card, Other. Cash shows change; the rest take an optional reference / txn ID.
 * Split / mixed payment is supported. A customer with loyalty points can redeem
 * some against the total (a tender, so the sale total itself is unchanged).
 *
 * Stored record shape is unchanged so reports keep working:
 *   cash               -> { method: 'cash', amount }
 *   bkash/nagad/rocket  -> { method: 'mobile', provider, amount, reference }
 *   other              -> { method: 'mobile', provider: 'other', amount, reference }
 *   bank_transfer/card  -> { method, amount, reference }
 */
import { openModal } from '../../components/modal.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import money from '../../utils/money.js';
import config from '../../config.js';

const METHODS = [
  { id: 'cash', label: 'Cash', icon: 'banknote' },
  { id: 'bkash', label: 'bKash', icon: 'smartphone' },
  { id: 'nagad', label: 'Nagad', icon: 'smartphone' },
  { id: 'rocket', label: 'Rocket', icon: 'smartphone' },
  { id: 'bank_transfer', label: 'Bank', icon: 'building' },
  { id: 'card', label: 'Card', icon: 'credit-card' },
  { id: 'other', label: 'Other', icon: 'wallet' },
];

const MFS = new Set(['bkash', 'nagad', 'rocket', 'other']);

/** A chosen tender id -> the payment record piece (keeps the legacy shape). */
function toRecord(id, amount, reference) {
  const ref = reference ? String(reference).trim() || null : null;
  if (id === 'cash') return { method: 'cash', amount };
  if (MFS.has(id)) return { method: 'mobile', provider: id, amount, reference: ref };
  return { method: id, amount, reference: ref };
}

export function openPayment({ total, customer, loyalty }) {
  return new Promise((resolve) => {
    let mixed = false;
    let method = 'cash';
    const amounts = Object.fromEntries(METHODS.map((mt) => [mt.id, 0]));
    let cashReceived = 0;
    let settled = false;
    let onAccount = false;
    let redeemPoints = 0;

    const perPoint = loyalty && loyalty.perPoint > 0 ? loyalty.perPoint : 0;
    const custPoints = loyalty?.points || 0;
    const minRedeem = Math.max(1, loyalty?.minRedeem || 1);
    const canRedeem = !!customer && perPoint > 0 && custPoints >= minRedeem && total >= perPoint * minRedeem;
    const maxRedeemPoints = canRedeem ? Math.min(custPoints, Math.floor(total / perPoint)) : 0;

    const payable = () => Math.max(0, total - redeemPoints * perPoint);

    const m = openModal({
      title: 'Take Payment',
      size: 'lg',
      onClose: () => !settled && resolve(null),
      body: `<div class="pay-grid">
        <div class="pay-total-box">
          <span class="label">Amount to pay</span>
          <div class="amount js-payable">${money.format(total)}</div>
        </div>
        <div class="row" style="grid-column:1/-1;justify-content:space-between">
          <label class="switch"><input type="checkbox" class="js-mixed"><span class="switch__track"><span class="switch__thumb"></span></span><span>Split / mixed payment</span></label>
          ${customer ? `<span class="badge badge--brand">${escapeHtml(customer.name)}</span>` : ''}
        </div>
        ${canRedeem ? `<label class="field field--row" style="grid-column:1/-1;align-items:center">
          <span class="label" style="width:auto">Redeem points <span class="opt">${custPoints} available · ${money.format(perPoint)}/pt</span></span>
          <input class="input js-redeem" type="number" inputmode="numeric" min="0" max="${maxRedeemPoints}" step="1" placeholder="0" style="width:100px">
          <button type="button" class="btn btn--ghost btn--sm js-redeem-max">Max</button>
          <span class="js-redeem-val muted"></span>
        </label>` : ''}
        ${customer ? `<label class="switch" style="grid-column:1/-1"><input type="checkbox" class="js-account"><span class="switch__track"><span class="switch__thumb"></span></span><span>Charge the remainder to ${escapeHtml(customer.name)}'s account (due)</span></label>` : ''}
        <div class="pay-method-grid js-methods">
          ${METHODS.map((mt) => `<button type="button" class="pay-method ${mt.id === 'cash' ? 'is-active' : ''}" data-m="${mt.id}">${icon(mt.icon, { size: 20 })}${mt.label}</button>`).join('')}
        </div>
        <div class="js-single" style="grid-column:1/-1">
          <div class="js-cash-block">
            <label class="field"><span class="label">Cash received</span>
              <input class="input js-cash-received" type="number" inputmode="decimal" step="0.01" placeholder="0.00" style="font-size:var(--fs-xl);height:52px">
            </label>
            <div class="quick-cash js-quick" style="margin-top:var(--sp-2)"></div>
          </div>
          <label class="field js-ref-field" hidden style="margin-top:var(--sp-3)"><span class="label">Reference / txn ID <span class="opt">optional</span></span>
            <input class="input js-ref" placeholder="e.g. bKash TrxID, card auth code">
          </label>
        </div>
        <div class="js-mixed-block" hidden style="grid-column:1/-1">
          ${METHODS.map((mt) => `<label class="field field--row" style="margin-bottom:var(--sp-2)">
            <span class="label" style="width:120px">${mt.label}</span>
            <input class="input js-mix" data-m="${mt.id}" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
          </label>`).join('')}
        </div>
        <div class="change-box js-change" style="grid-column:1/-1">
          <span>Change due</span><span class="amount js-change-amt">${money.format(0)}</span>
        </div>
      </div>`,
      footer: `<button class="btn btn--ghost js-cancel">Cancel</button>
        <button class="btn btn--success btn--lg js-confirm">${icon('check', { size: 18 })} Confirm Payment</button>`,
    });

    const $ = (s) => m.$(s);
    const quick = $('.js-quick');
    (config.pos.quickCashDenominations || [100, 500, 1000]).forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = money.format(money.toMinor(d), { withSymbol: false });
      b.addEventListener('click', () => {
        $('.js-cash-received').value = d;
        recalc();
      });
      quick.appendChild(b);
    });
    const exactBtn = document.createElement('button');
    exactBtn.type = 'button';
    exactBtn.textContent = 'Exact';
    exactBtn.addEventListener('click', () => {
      $('.js-cash-received').value = money.toMajor(payable());
      recalc();
    });
    quick.appendChild(exactBtn);

    $('.js-redeem')?.addEventListener('input', (e) => {
      redeemPoints = Math.max(0, Math.min(maxRedeemPoints, Math.trunc(Number(e.target.value) || 0)));
      if (String(redeemPoints) !== e.target.value) e.target.value = redeemPoints || '';
      recalc();
    });
    $('.js-redeem-max')?.addEventListener('click', () => {
      redeemPoints = maxRedeemPoints;
      $('.js-redeem').value = maxRedeemPoints;
      recalc();
    });

    $('.js-mixed').addEventListener('change', (e) => {
      mixed = e.target.checked;
      $('.js-single').hidden = mixed;
      $('.js-methods').style.opacity = mixed ? '0.4' : '1';
      $('.js-methods').style.pointerEvents = mixed ? 'none' : 'auto';
      $('.js-mixed-block').hidden = !mixed;
      recalc();
    });

    $('.js-methods').addEventListener('click', (e) => {
      const btn = e.target.closest('.pay-method');
      if (!btn) return;
      method = btn.dataset.m;
      m.$$('.pay-method').forEach((x) => x.classList.toggle('is-active', x === btn));
      $('.js-cash-block').hidden = method !== 'cash';
      $('.js-ref-field').hidden = method === 'cash';
      recalc();
    });

    $('.js-cash-received').addEventListener('input', recalc);
    m.$$('.js-mix').forEach((i) => i.addEventListener('input', recalc));
    $('.js-account')?.addEventListener('change', (e) => { onAccount = e.target.checked; recalc(); });

    function recalc() {
      const due = payable();
      $('.js-payable').textContent = money.format(due);
      if ($('.js-redeem-val')) $('.js-redeem-val').textContent = redeemPoints ? `−${money.format(redeemPoints * perPoint)}` : '';

      let paid = 0;
      if (mixed) {
        m.$$('.js-mix').forEach((i) => {
          const v = money.toMinor(i.value || 0);
          amounts[i.dataset.m] = v;
          paid += v;
        });
      } else if (method === 'cash') {
        cashReceived = money.toMinor($('.js-cash-received').value || 0);
        paid = cashReceived;
      } else {
        paid = due;
      }
      const effectivePaid = mixed ? paid : (method === 'cash' ? cashReceived : due);
      const change = Math.max(0, (method === 'cash' && !mixed ? cashReceived : effectivePaid) - due);
      const short = Math.max(0, due - effectivePaid);
      const box = $('.js-change');
      if (short > 0) {
        box.classList.add('is-due');
        box.querySelector('span').textContent = onAccount ? 'Goes on account' : 'Still due';
        $('.js-change-amt').textContent = money.format(short);
      } else {
        box.classList.remove('is-due');
        box.querySelector('span').textContent = 'Change due';
        $('.js-change-amt').textContent = money.format(change);
      }
      $('.js-confirm').disabled = short > 0.0001 && !onAccount;
    }

    $('.js-cancel').addEventListener('click', () => m.close());
    $('.js-confirm').addEventListener('click', () => {
      const due = payable();
      const payments = [];
      if (mixed) {
        for (const mt of METHODS) {
          const v = amounts[mt.id];
          if (v > 0) payments.push(toRecord(mt.id, v));
        }
      } else if (method === 'cash') {
        const amt = onAccount ? Math.min(cashReceived, due) : cashReceived;
        if (amt > 0 || !onAccount) payments.push(toRecord('cash', amt));
      } else if (!onAccount) {
        payments.push(toRecord(method, due, $('.js-ref').value));
      }
      settled = true;
      resolve({ payments: payments.filter((p) => p.amount > 0 || !onAccount), onAccount, redeemPoints });
      m.close();
    });

    setTimeout(() => $('.js-cash-received')?.focus(), 100);
    recalc();
  });
}

export default openPayment;
