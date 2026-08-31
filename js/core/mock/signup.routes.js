/**
 * signup.routes.js - public onboarding + contact from the Live/Public panel.
 *   POST /signup   -> provision an isolated merchant + a pending subscription
 *   POST /support  -> queue a message for the Super Admin
 */
import db from '../db.js';
import { ok, created, badRequest, conflict } from './router.js';
import { subscribeMerchant } from './platform-helpers.js';
import { provisionMerchant } from './platform.routes.js';
import { getActor } from './context.js';
import { uuid } from '../../utils/id.js';
import { now } from '../../utils/date.js';

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

export default function register(router) {
  router.post('/signup', async ({ body }) => {
    const b = body || {};
    const businessName = String(b.businessName || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const errors = {};
    if (!businessName) errors.businessName = 'Required';
    if (!isEmail(email)) errors.email = 'Enter a valid email';
    if (password.length < 8) errors.password = 'Use at least 8 characters';

    let planId = b.planId || null;
    const plan = planId ? db.collection('plans').get(planId) : null;
    if (!plan || plan.status !== 'active' || plan.archivedAt) {
      errors.planId = 'Choose a plan';
      planId = null;
    }
    if (Object.keys(errors).length) badRequest('Please fix the highlighted fields', errors);

    return db.tx(async () => {
      let res;
      try {
        res = await provisionMerchant({ name: businessName, ownerName: String(b.ownerName || '').trim(), ownerEmail: email, ownerPassword: password });
      } catch (err) {
        if (err.status === 409) conflict(err.message);
        throw err;
      }
      subscribeMerchant(res.merchantId, planId, 'pending');
      return ok({ ok: true, email, merchantId: res.merchantId });
    });
  });

  router.post('/support', ({ body }) => {
    const b = body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const message = String(b.message || '').trim();
    if (!isEmail(email) || !message) {
      badRequest('A valid email and a message are required', {
        email: !isEmail(email) ? 'Enter a valid email' : undefined,
        message: !message ? 'Required' : undefined,
      });
    }
    const actor = getActor();
    const merchantId = actor?.merchantId || b.merchantId || null;
    const doc = db.collection('support_requests').insert({
      id: uuid(), name: String(b.name || '').trim(), email,
      subject: String(b.subject || 'General enquiry').trim(), message,
      planId: b.planId || null, merchantId,
      source: actor ? 'merchant' : 'public', status: 'open', replies: [], at: now(),
    });
    return created({ ok: true, id: doc.id });
  });
}
