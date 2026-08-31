/**
 * platform/settings.js - Super Admin -> Settings.
 *
 * Contact & Business Information (the WhatsApp number + business details the
 * Live/Public panel uses everywhere), billing defaults (grace period, default
 * additional-branch price) and the payment-gateway selection.
 *
 * One source of truth: change the WhatsApp number here and every "Talk to us" /
 * per-plan WhatsApp link on the Live site updates. Gateway SECRET keys are never
 * stored here - they live server-side only.
 */
import platformService from '../../services/platform-service.js';
import { createForm } from '../../components/form.js';
import { toast } from '../../components/toast.js';
import { page, loading, errorBox } from './kit.js';

export default async function settingsPage(ctx, mount) {
  const p = page(mount, { title: 'Settings', subtitle: 'Contact details, billing defaults & payment gateway — used across the whole platform' });
  loading(p.body);

  let s;
  try {
    s = await platformService.settings();
  } catch (err) {
    return errorBox(p.body, err);
  }

  p.body.innerHTML = `
    <div class="sa-detail-grid">
      <div class="card card--pad" id="sec-contact"><div class="form-section-title">Contact &amp; business information</div><div class="sa-form"></div></div>
      <div class="card card--pad" id="sec-billing"><div class="form-section-title">Billing defaults</div><div class="sa-form"></div></div>
    </div>
    <div class="card card--pad" style="margin-top:16px"><div class="form-section-title">Payment methods &amp; gateway</div>
      <p class="muted text-sm">Payment methods (bKash, Nagad, bank, card), their Bangla instructions and the gateway driver moved to <a href="#/payment-settings">Payment Settings</a>.</p></div>`;

  const save = (slice) => async (v) => {
    await platformService.updateSettings(slice(v));
    toast.success('Saved');
  };

  createForm(p.body.querySelector('#sec-contact .sa-form'), {
    fields: [
      { name: 'businessName', label: 'Business name', required: true, colSpan: 'full' },
      { name: 'whatsapp', label: 'Official WhatsApp number', required: true, hint: 'International format, no +, e.g. 8801XXXXXXXXX. Used for every WhatsApp link on the public site.' },
      { name: 'supportPhone', label: 'Support phone' },
      { name: 'email', label: 'Support email', type: 'email' },
      { name: 'salesEmail', label: 'Sales email', type: 'email' },
      { name: 'supportHours', label: 'Support hours' },
      { name: 'website', label: 'Website' },
      { name: 'address', label: 'Business address', type: 'textarea', rows: 2, colSpan: 'full' },
    ],
    values: { ...s.contact },
    submitLabel: 'Save contact info',
    onSubmit: save((v) => ({ contact: v })),
  });

  createForm(p.body.querySelector('#sec-billing .sa-form'), {
    fields: [
      { name: 'currency', label: 'Currency code', hint: 'e.g. BDT' },
      { name: 'currencySymbol', label: 'Currency symbol' },
      { name: 'graceDays', label: 'Grace days past due', type: 'number', min: 0, hint: 'How long a merchant keeps full access after a monthly payment is overdue before Admin + Cashier are blocked.' },
      { name: 'defaultExtraBranchPrice', label: 'Default additional-branch price', type: 'money', hint: 'Used when a plan does not set its own extra-branch price.' },
    ],
    values: {
      currency: s.billing.currency, currencySymbol: s.billing.currencySymbol,
      graceDays: s.billing.graceDays, defaultExtraBranchPrice: s.billing.defaultExtraBranchPrice,
    },
    submitLabel: 'Save billing defaults',
    onSubmit: save((v) => ({
      billing: {
        currency: v.currency, currencySymbol: v.currencySymbol,
        graceDays: Math.max(0, Math.trunc(Number(v.graceDays) || 0)),
        defaultExtraBranchPrice: v.defaultExtraBranchPrice === '' ? 0 : Number(v.defaultExtraBranchPrice),
      },
    })),
  });

}
