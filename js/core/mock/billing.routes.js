/**
 * billing.routes.js - a merchant's own subscription & payments (self-service).
 *
 *   GET  /billing/summary        - my plan, charges, next billing, amount due,
 *                                  branch usage, recent payments, gateway info
 *   POST /billing/pay            - pay my setup fee or a monthly charge
 *   POST /billing/branch-request - request + pay for an extra branch (phase 5)
 *
 * Tenant-scoped: every route reads the caller's own merchantId. The amount is
 * computed on the server from the subscription - the client never sends it.
 */
import db from '../db.js';
import { ok, created, badRequest, notFound } from './router.js';
import { audit } from './helpers.js';
import { getActor } from './context.js';
import { subscriptionFor, liveStatus, dueAmount, applyConfirmedPayment, extraBranchPrice, notifyPaymentRequest } from './platform-helpers.js';
import { activeGateway, charge } from './gateway.js';
import { enabledPaymentMethods, paymentMethodById, platformSettings } from './platform-settings.routes.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';

function meMerchantId() {
  const a = getActor();
  if (!a) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  if (!a.merchantId) throw Object.assign(new Error('This account has no merchant subscription.'), { status: 400 });
  return a.merchantId;
}

const TYPE_LABEL = { initial: 'Initial plan purchase', monthly: 'Monthly server & backup charge', branch: 'Additional branch' };
const MAX_PROOF = 2_800_000; // ~2 MB as a data URL

/** Prefilled WhatsApp link to POS TXbd for a just-submitted payment. */
function paymentWhatsappLink({ merchantId, type, amount, reference, method, planOrBranch }) {
  const wa = String(platformSettings().contact?.whatsapp || '').replace(/[^0-9]/g, '');
  if (!wa) return null;
  const biz = db.collection('businesses').all().find((x) => x.merchantId === merchantId)?.name
    || db.collection('merchants').get(merchantId)?.name || 'my business';
  const lines = [
    'Hello POS TXbd Team,',
    '',
    'I have submitted a payment request.',
    '',
    `Business: ${biz}`,
    `Payment Type: ${TYPE_LABEL[type] || type}`,
    planOrBranch ? `Plan / Branch: ${planOrBranch}` : null,
    `Amount: ৳${(amount / 100).toLocaleString('en-BD')}`,
    reference ? `Transaction ID: ${reference}` : null,
    method ? `Payment Method: ${method}` : null,
    '',
    'My payment request has been submitted and is currently pending approval.',
    'Please verify and approve my request as soon as possible.',
  ].filter((x) => x != null);
  return `https://wa.me/${wa}?text=${encodeURIComponent(lines.join('\n'))}`;
}

/** Common validation + field extraction for a manual payment submission. */
function readPaymentFields(body, driver) {
  const methodId = body?.methodId ? String(body.methodId) : null;
  const methodRec = methodId ? paymentMethodById(methodId) : null;
  const method = String(body?.method || methodRec?.name || 'manual');
  const reference = body?.reference ? String(body.reference).trim() : '';
  const accountNumber = body?.accountNumber ? String(body.accountNumber).trim() : '';
  const proofImage = body?.proofImage ? String(body.proofImage) : '';
  const note = body?.note ? String(body.note).trim() : '';
  const paidAt = body?.paidAt ? String(body.paidAt) : null;
  if (methodId && !methodRec) badRequest('Unknown payment method.', { methodId: 'Unknown' });
  if (methodRec && methodRec.status === 'disabled') badRequest('That payment method is not available.', { methodId: 'Unavailable' });
  if (driver === 'manual') {
    if (!reference) badRequest('Enter the transaction ID from your payment.', { reference: 'Required' });
    if (!accountNumber) badRequest('Enter the phone / account number you paid from.', { accountNumber: 'Required' });
  }
  if (proofImage && proofImage.length > MAX_PROOF) badRequest('The proof image is too large — keep it under 2 MB.', { proofImage: 'Too large' });
  return { methodId, method, reference: reference || null, accountNumber: accountNumber || null, proofImage: proofImage || null, note: note || null, paidAt };
}

function summaryFor(merchantId) {
  const sub = subscriptionFor(merchantId);
  const status = liveStatus(sub);
  const branchesUsed = db.collection('branches').all().filter((b) => b.merchantId === merchantId && !b.archivedAt).length;
  const payments = db.collection('subscription_payments').all()
    .filter((p) => p.merchantId === merchantId)
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''))
    .slice(0, 20);
  const g = activeGateway();
  const endMs = sub?.expiresAt ? new Date(sub.expiresAt).getTime() : null;
  return {
    subscription: sub ? {
      planId: sub.planId, planName: sub.planName,
      status, billingPeriod: sub.billingPeriod,
      setupPrice: sub.setupPrice || 0, setupPaid: !!sub.setupPaid,
      monthlyPrice: sub.monthlyPrice ?? sub.planPrice ?? 0,
      startedAt: sub.startedAt, expiresAt: sub.expiresAt, nextBillingAt: sub.nextBillingAt || sub.expiresAt,
      lastPaymentAt: sub.lastPaymentAt || null,
      daysLeft: endMs != null ? Math.ceil((endMs - Date.now()) / 86400000) : null,
      dueAmount: dueAmount(sub, status),
    } : null,
    branches: {
      used: branchesUsed,
      included: sub?.includedBranches ?? 1,
      extraPaid: sub?.extraBranchesPaid ?? 0,
      limit: (sub?.includedBranches ?? 1) + (sub?.extraBranchesPaid ?? 0),
    },
    gateway: g,
    paymentMethods: enabledPaymentMethods(),
    payments,
    branchRequests: db.collection('branch_requests').all()
      .filter((r) => r.merchantId === merchantId)
      .sort((a, b) => (b.at || '').localeCompare(a.at || '')),
    extraBranchPrice: sub ? extraBranchPrice(sub) : 0,
  };
}

export default function register(router) {
  router.get('/billing/summary', () => ok(summaryFor(meMerchantId())));

  router.post('/billing/pay', ({ body }) => {
    const merchantId = meMerchantId();
    const sub = subscriptionFor(merchantId);
    if (!sub) notFound('Subscription');
    const type = ['initial', 'monthly'].includes(body?.type) ? body.type : null;
    if (!type) badRequest('type must be "initial" or "monthly"');
    if (type === 'initial' && sub.setupPaid) badRequest('The setup fee is already paid.');

    const amount = type === 'initial' ? (sub.setupPrice || 0) : (sub.monthlyPrice ?? sub.planPrice ?? 0);
    if (amount <= 0) badRequest('Nothing to pay for this item.');

    const g = activeGateway();
    const f = readPaymentFields(body, g.driver);

    return db.tx(() => {
      const res = charge({ merchantId, type, amount, method: f.method, reference: f.reference });
      const doc = db.collection('subscription_payments').insert({
        id: uuid(), merchantId, subscriptionId: sub.id, planId: sub.planId || null,
        type, status: res.status, amount,
        method: f.method, methodId: f.methodId, reference: f.reference,
        accountNumber: f.accountNumber, proofImage: f.proofImage, note: f.note, paidAt: f.paidAt,
        gatewayRef: res.gatewayRef || null, gatewayDriver: res.driver,
        adminNote: res.status === 'pending' ? 'Awaiting approval' : '',
        submittedBy: getActor()?.name || 'Merchant',
        confirmedBy: res.status === 'paid' ? 'Gateway' : null,
        confirmedAt: res.status === 'paid' ? now() : null,
        periodStart: now(), periodEnd: sub.expiresAt || null,
        at: now(), createdAt: now(),
      });
      if (res.status === 'paid') applyConfirmedPayment(doc);
      else notifyPaymentRequest(doc, sub.planName);
      audit('create', 'subscription_payment', doc.id, { meta: { self: true, type, status: res.status } });
      return created({
        payment: doc, summary: summaryFor(merchantId),
        whatsapp: paymentWhatsappLink({ merchantId, type, amount, reference: f.reference, method: f.method, planOrBranch: sub.planName }),
      });
    });
  });

  router.post('/billing/branch-request', ({ body }) => {
    const merchantId = meMerchantId();
    const sub = subscriptionFor(merchantId);
    if (!sub) notFound('Subscription');
    const name = String(body?.name || '').trim();
    if (!name) badRequest('Branch name is required', { name: 'Required' });
    const price = extraBranchPrice(sub);
    if (price <= 0) badRequest('Additional branches are not priced for this plan — contact support.');

    const g = activeGateway();
    const f = readPaymentFields(body, g.driver);

    return db.tx(() => {
      const req = db.collection('branch_requests').insert({
        id: uuid(), merchantId, name,
        code: String(body?.code || '').trim() || null,
        address: String(body?.address || '').trim(),
        price, status: 'pending', paymentId: null, branchId: null, at: now(),
      });
      const res = charge({ merchantId, type: 'branch', amount: price, method: f.method, reference: f.reference });
      const pay = db.collection('subscription_payments').insert({
        id: uuid(), merchantId, subscriptionId: sub.id, planId: sub.planId || null,
        type: 'branch', status: res.status, amount: price,
        method: f.method, methodId: f.methodId, reference: f.reference,
        accountNumber: f.accountNumber, proofImage: f.proofImage, note: f.note, paidAt: f.paidAt,
        branchRef: req.id, gatewayRef: res.gatewayRef || null, gatewayDriver: res.driver,
        adminNote: res.status === 'pending' ? 'Additional branch — awaiting approval' : 'Additional branch',
        submittedBy: getActor()?.name || 'Merchant',
        confirmedBy: res.status === 'paid' ? 'Gateway' : null,
        confirmedAt: res.status === 'paid' ? now() : null,
        periodStart: now(), periodEnd: sub.expiresAt || null,
        at: now(), createdAt: now(),
      });
      db.collection('branch_requests').update(req.id, { paymentId: pay.id });
      if (res.status === 'paid') applyConfirmedPayment(pay);
      else notifyPaymentRequest(pay, name);
      audit('create', 'branch_request', req.id, { meta: { status: res.status, price } });
      return created({
        request: db.collection('branch_requests').get(req.id), payment: pay, summary: summaryFor(merchantId),
        whatsapp: paymentWhatsappLink({ merchantId, type: 'branch', amount: price, reference: f.reference, method: f.method, planOrBranch: name }),
      });
    });
  });

  router.post('/billing/payments/:id/cancel', ({ params }) => {
    const merchantId = meMerchantId();
    const pay = db.collection('subscription_payments').get(params.id);
    if (!pay || pay.merchantId !== merchantId) notFound('Payment');
    if ((pay.status || 'pending') !== 'pending') badRequest('Only a pending request can be cancelled.');
    return db.tx(() => {
      const doc = db.collection('subscription_payments').update(params.id, { status: 'cancelled', cancelledAt: now() });
      if (pay.branchRef) {
        const br = db.collection('branch_requests').get(pay.branchRef);
        if (br && br.status === 'pending') db.collection('branch_requests').update(br.id, { status: 'rejected' });
      }
      audit('update', 'subscription_payment', params.id, { meta: { status: 'cancelled', self: true } });
      return ok({ payment: doc, summary: summaryFor(merchantId) });
    });
  });
}
