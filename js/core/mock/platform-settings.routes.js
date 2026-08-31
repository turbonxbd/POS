/**
 * platform-settings.routes.js - one platform-wide settings record (id 'platform').
 *
 *   GET   /public-settings     PUBLIC  - safe subset for the Live/Public panel
 *   GET   /platform/settings   Super Admin - full record
 *   PATCH /platform/settings   Super Admin - deep-merged update
 *
 * Holds the official contact details (WhatsApp, business name, support number,
 * email, address), billing defaults (grace days, default extra-branch price) and
 * the payment-gateway selection. NEVER stores gateway secret keys - those live
 * server-side only. One source of truth: the Live panel reads /public-settings,
 * Super Admin edits this record.
 */
import db from '../db.js';
import { ok } from './router.js';
import { audit } from './helpers.js';
import { requirePlatform } from './platform-helpers.js';
import { now } from '../../utils/date.js';

const ID = 'platform';
const col = () => db.collection('platform_settings');

export const DEFAULT_PLATFORM_SETTINGS = {
  id: ID,
  contact: {
    businessName: 'POS TXbd',
    whatsapp: '8801700000000',
    supportPhone: '',
    email: 'support@postxbd.app',
    salesEmail: 'sales@postxbd.app',
    address: '',
    supportHours: 'Sat–Thu, 10am–7pm (GMT+6)',
    website: '',
  },
  billing: {
    currency: 'BDT',
    currencySymbol: '৳',
    graceDays: 7,
    defaultExtraBranchPrice: 200000,
  },
  gateway: {
    driver: 'manual',
    displayName: 'Manual / bank transfer',
    instructions: 'Send the payment to our bKash / bank account, then enter the transaction ID below. We activate your account once we confirm it.',
  },
  paymentMethods: [
    {
      id: 'bkash', name: 'bKash', type: 'mfs', accountType: 'personal',
      accountName: 'POS TXbd', accountNumber: '01700000000',
      instructionsBn: 'বিকাশে পেমেন্ট করার নিয়ম:\nবিকাশ পার্সোনাল নম্বরে অ্যাপ থেকে সেন্ড মানি করুন\n১. bKash অ্যাপ খুলুন\n২. "Send Money" অপশনে ট্যাপ করুন\n৩. নিচের নম্বরটি কপি করে পেস্ট করুন\n৪. টাকার পরিমাণ লিখুন\n৫. রেফারেন্সে আপনার ব্যবসার নাম লিখুন\n৬. bKash PIN দিয়ে সেন্ড মানি সম্পন্ন করুন\n৭. সম্পন্ন হওয়ার পরে, ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন',
      instructionsEn: 'Open bKash → Send Money → paste the number below → enter the amount → confirm with your PIN → copy the Transaction ID into the form.',
      note: '', status: 'enabled', sort: 1,
    },
    {
      id: 'nagad', name: 'Nagad', type: 'mfs', accountType: 'personal',
      accountName: 'POS TXbd', accountNumber: '01700000000',
      instructionsBn: 'নগদে পেমেন্ট করার নিয়ম:\n১. Nagad অ্যাপ খুলুন\n২. "Send Money" অপশনে ট্যাপ করুন\n৩. নিচের নম্বরটি কপি করে পেস্ট করুন\n৪. টাকার পরিমাণ লিখুন\n৫. Nagad PIN দিয়ে সেন্ড মানি সম্পন্ন করুন\n৬. ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন',
      instructionsEn: 'Open Nagad → Send Money → paste the number below → enter the amount → confirm with your PIN → copy the Transaction ID into the form.',
      note: '', status: 'enabled', sort: 2,
    },
    {
      id: 'rocket', name: 'Rocket', type: 'mfs', accountType: 'personal',
      accountName: 'POS TXbd', accountNumber: '017000000000',
      instructionsBn: 'রকেটে পেমেন্ট করার নিয়ম:\n১. Rocket অ্যাপ / *322# খুলুন\n২. "Send Money" নির্বাচন করুন\n৩. নিচের নম্বরটি কপি করে দিন\n৪. টাকার পরিমাণ লিখুন\n৫. Rocket PIN দিয়ে নিশ্চিত করুন\n৬. ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন',
      instructionsEn: 'Open Rocket / *322# → Send Money → the number below → amount → confirm with PIN → copy the Transaction ID into the form.',
      note: '', status: 'enabled', sort: 3,
    },
    {
      id: 'upay', name: 'Upay', type: 'mfs', accountType: 'personal',
      accountName: 'POS TXbd', accountNumber: '01700000000',
      instructionsBn: 'উপায়ে পেমেন্ট করার নিয়ম:\n১. Upay অ্যাপ খুলুন\n২. "Send Money" নির্বাচন করুন\n৩. নিচের নম্বরটি দিন\n৪. টাকার পরিমাণ লিখুন\n৫. Upay PIN দিয়ে নিশ্চিত করুন\n৬. ট্রানজেকশন আইডি কপি করে নিচের বক্সে পেস্ট করুন',
      instructionsEn: 'Open Upay → Send Money → the number below → amount → confirm with PIN → copy the Transaction ID into the form.',
      note: '', status: 'enabled', sort: 4,
    },
    {
      id: 'bank', name: 'Bank transfer', type: 'bank', accountType: '',
      accountName: 'POS TXbd', accountNumber: '',
      instructionsBn: 'ব্যাংক ট্রান্সফারের নিয়ম:\n১. নিচের অ্যাকাউন্টে ব্যাংক ট্রান্সফার অথবা ক্যাশ ডিপোজিট করুন\n২. ট্রান্সফার সম্পন্ন হলে ট্রানজেকশন রেফারেন্স / স্লিপ নম্বর নিচের বক্সে লিখুন\n৩. প্রয়োজনে পেমেন্ট স্লিপের ছবি সংযুক্ত করুন',
      instructionsEn: 'Transfer or deposit to the account below, then enter the transaction reference / slip number and optionally attach the deposit slip.',
      note: '', status: 'enabled', sort: 5,
    },
    {
      id: 'card', name: 'Debit / Credit card', type: 'card', accountType: '',
      accountName: '', accountNumber: '',
      instructionsBn: 'কার্ড পেমেন্ট শীঘ্রই চালু হবে। এখন বিকাশ, নগদ, রকেট, উপায় অথবা ব্যাংক ট্রান্সফার ব্যবহার করুন।',
      instructionsEn: 'Card payment is coming soon. Please use bKash, Nagad, Rocket, Upay or bank transfer for now.',
      note: '', status: 'disabled', sort: 6,
    },
  ],
};

function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const METHOD_TYPES = ['mfs', 'bank', 'card'];

/** Clean a payment-methods array coming from a PATCH: stable ids, clamped enums. */
export function normalizePaymentMethods(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  return list.map((m, i) => {
    let id = String(m.id || m.name || `method-${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `method-${i + 1}`;
    while (seen.has(id)) id += '-2';
    seen.add(id);
    return {
      id,
      name: String(m.name || id).trim() || id,
      type: METHOD_TYPES.includes(m.type) ? m.type : 'mfs',
      accountType: ['personal', 'agent', 'merchant', ''].includes(m.accountType) ? m.accountType : '',
      accountName: String(m.accountName || '').trim(),
      accountNumber: String(m.accountNumber || '').trim(),
      instructionsBn: String(m.instructionsBn || ''),
      instructionsEn: String(m.instructionsEn || ''),
      note: String(m.note || '').trim(),
      status: m.status === 'disabled' ? 'disabled' : 'enabled',
      sort: Number.isFinite(+m.sort) ? +m.sort : i + 1,
    };
  }).sort((a, b) => a.sort - b.sort);
}

/** The current settings record, merged over defaults. Always returns an object. */
export function platformSettings() {
  const row = col().get(ID);
  return deepMerge(DEFAULT_PLATFORM_SETTINGS, row || {});
}

/** Enabled payment methods, sorted — what a merchant sees on the payment sheet. */
export function enabledPaymentMethods() {
  return (platformSettings().paymentMethods || [])
    .filter((m) => m.status !== 'disabled')
    .sort((a, b) => (a.sort || 0) - (b.sort || 0));
}

/** Look up one method by id (any status). */
export function paymentMethodById(id) {
  return (platformSettings().paymentMethods || []).find((m) => m.id === id) || null;
}

/** Ensure the row exists (seed / boot self-heal). */
export function ensurePlatformSettings() {
  if (!col().get(ID)) {
    col().insert({ ...structuredClone(DEFAULT_PLATFORM_SETTINGS), createdAt: now(), updatedAt: now() });
    return true;
  }
  return false;
}

/** Only the fields safe to expose without auth. */
function publicSubset(s) {
  return {
    contact: {
      businessName: s.contact.businessName,
      whatsapp: s.contact.whatsapp,
      supportPhone: s.contact.supportPhone,
      email: s.contact.email,
      salesEmail: s.contact.salesEmail,
      address: s.contact.address,
      supportHours: s.contact.supportHours,
      website: s.contact.website,
    },
    currency: s.billing.currency,
    currencySymbol: s.billing.currencySymbol,
  };
}

export default function register(router) {
  router.get('/public-settings', () => ok(publicSubset(platformSettings())));

  router.get('/platform/settings', () => {
    requirePlatform();
    return ok(platformSettings());
  });

  // only these top-level keys can be written through the API — a client can't
  // sneak arbitrary keys (e.g. a fake gateway.secret) into the settings doc.
  const WRITABLE = new Set(['contact', 'billing', 'gateway', 'paymentMethods']);

  router.patch('/platform/settings', ({ body }) => {
    requirePlatform();
    return db.tx(() => {
      ensurePlatformSettings();
      const current = col().get(ID);
      const patch = {};
      for (const [k, v] of Object.entries(body || {})) {
        if (WRITABLE.has(k)) patch[k] = v;
      }
      if ('paymentMethods' in patch) patch.paymentMethods = normalizePaymentMethods(patch.paymentMethods) || [];
      const merged = deepMerge(current, patch);
      merged.id = ID;
      merged.updatedAt = now();
      const row = col().update(ID, merged);
      audit('settings', 'platform_settings', ID, { after: row });
      return ok(platformSettings());
    });
  });
}
