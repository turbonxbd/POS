/**
 * billing.mjs - merchant self-service billing (mock):
 * /billing/summary + /billing/pay through the gateway-driver abstraction
 * (manual -> pending -> Super Admin confirm; mock -> instant paid).
 *
 *   node test/billing.mjs
 */
const store = new Map();
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), clear: () => store.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'test' }, configurable: true });
globalThis.window = globalThis;
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = f => setTimeout(f, 0);
globalThis.setInterval = () => 0;
globalThis.document = { documentElement: { setAttribute() {}, removeAttribute() {}, hasAttribute: () => false, style: {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, getContext: () => ({}) }), addEventListener() {}, body: { appendChild() {}, style: {} }, getElementById: () => null, cookie: '' };
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const { db } = await import('../js/core/db.js');
const { initMockServer } = await import('../js/core/mock-server.js');
const { seedDemo } = await import('../js/data/seed.js');
const { setActor, clearContext } = await import('../js/core/mock/context.js');
const { http } = await import('../js/core/http.js');
initMockServer(); db.load(); await seedDemo(db);

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
async function login(email, password) {
  clearContext();
  const p = await http.post('/auth/login', { email, password });
  setActor({ ...p.user });
  return p;
}

/* a fresh merchant via public signup -> pending subscription, setup unpaid */
await clearContext();
const su = await http.post('/signup', { businessName: 'Meena Mart', ownerName: 'Meena', email: 'meena@mart.bd', password: 'meenapass1', planId: 'plan_starter' });
T('signup created the merchant', su.ok === true);
await login('meena@mart.bd', 'meenapass1');

let sum = await http.get('/billing/summary');
T('summary: my own subscription, pending, setup unpaid', sum.subscription.status === 'pending' && sum.subscription.setupPaid === false);
T('summary: amount due == the plan setup fee', sum.subscription.dueAmount === sum.subscription.setupPrice && sum.subscription.setupPrice > 0);
T('summary: branch usage present', sum.branches.limit >= 1 && sum.branches.used >= 1);
T('summary: gateway is the default manual driver', sum.gateway.driver === 'manual');
T('summary: carries the enabled payment methods (bKash/Nagad/Bank)', Array.isArray(sum.paymentMethods) && sum.paymentMethods.some((m) => m.id === 'bkash'));

/* manual pay requires the transaction id + the payer's account number */
let missing = null;
try { await http.post('/billing/pay', { type: 'initial', methodId: 'bkash', reference: 'BK-1' }); } catch (e) { missing = e; }
T('manual pay rejects a submission with no account number (422)', missing?.status === 422 && missing?.data?.errors?.accountNumber);
let badMethod = null;
try { await http.post('/billing/pay', { type: 'initial', methodId: 'nope', reference: 'X', accountNumber: '017' }); } catch (e) { badMethod = e; }
T('manual pay rejects an unknown payment method (422)', badMethod?.status === 422);

/* pay the setup fee - manual gateway -> pending, nothing activates yet */
const pay1 = await http.post('/billing/pay', { type: 'initial', methodId: 'bkash', reference: 'BK-1', accountNumber: '01710000000', note: 'paid at 9pm' });
T('manual gateway leaves the payment pending', pay1.payment.status === 'pending' && pay1.payment.type === 'initial');
T('the submission stored the method, account number + note', pay1.payment.methodId === 'bkash' && pay1.payment.accountNumber === '01710000000' && pay1.payment.note === 'paid at 9pm');
T('the response carries a prefilled WhatsApp link with the business + amount', typeof pay1.whatsapp === 'string' && pay1.whatsapp.startsWith('https://wa.me/') && decodeURIComponent(pay1.whatsapp).includes('Meena Mart'));
sum = await http.get('/billing/summary');
T('still pending / setup still unpaid until Super Admin confirms', sum.subscription.status === 'pending' && sum.subscription.setupPaid === false);

/* the merchant can cancel their own pending request */
const pend = await http.post('/billing/pay', { type: 'initial', methodId: 'bkash', reference: 'BK-CANCEL', accountNumber: '01710000000' });
const cancelled = await http.post('/billing/payments/' + pend.payment.id + '/cancel');
T('a merchant can cancel their own pending request', cancelled.payment.status === 'cancelled');
let reCancel = null;
try { await http.post('/billing/payments/' + pend.payment.id + '/cancel'); } catch (e) { reCancel = e; }
T('a non-pending request cannot be cancelled again (422)', reCancel?.status === 422);

/* Super Admin gets a notification for the pending request */
await login('superadmin@postxbd.app', 'superadmin123');
const notifs = await http.get('/platform/notifications');
T('Super Admin is notified of the pending payment request',
  notifs.unreadCount >= 1 && notifs.data.some((n) => n.type === 'payment_request' && n.meta?.paymentId === pay1.payment.id));
const nid = notifs.data.find((n) => n.meta?.paymentId === pay1.payment.id).id;
await http.post('/platform/notifications/' + nid + '/read');
T('marking one read lowers the unread count', (await http.get('/platform/notifications')).unreadCount < notifs.unreadCount);
await http.post('/platform/notifications/read-all');
T('mark-all-read clears the badge', (await http.get('/platform/notifications', { unread: 'true' })).unreadCount === 0);

/* Super Admin can reject a pending request - nothing is activated */
await login('meena@mart.bd', 'meenapass1');
const toReject = await http.post('/billing/pay', { type: 'initial', methodId: 'bkash', reference: 'BK-REJECT', accountNumber: '01710000000' });
await login('superadmin@postxbd.app', 'superadmin123');
await http.patch('/platform/subscription-payments/' + toReject.payment.id, { status: 'rejected', reason: 'Transaction ID not found' });
const rej = (await http.get('/platform/subscription-payments', { status: 'rejected' })).data.find((x) => x.reference === 'BK-REJECT');
T('a rejected payment keeps the reason', rej && rej.status === 'rejected' && rej.rejectedReason === 'Transaction ID not found');
T('the Super Admin ledger carries the business name', typeof rej.businessName === 'string' && rej.businessName.length > 0);
await login('meena@mart.bd', 'meenapass1');
T('the merchant is still pending after a rejection', (await http.get('/billing/summary')).subscription.status === 'pending');

/* Super Admin confirms the payment */
await login('superadmin@postxbd.app', 'superadmin123');
const list = await http.get('/platform/subscription-payments', { status: 'pending' });
const mine = list.data.find((p) => p.reference === 'BK-1');
T('the pending payment shows in the Super Admin ledger', !!mine);
await http.patch('/platform/subscription-payments/' + mine.id, { status: 'paid' });

await login('meena@mart.bd', 'meenapass1');
sum = await http.get('/billing/summary');
T('after confirmation: subscription active, setup paid, nothing due', sum.subscription.status === 'active' && sum.subscription.setupPaid === true && sum.subscription.dueAmount === 0);

/* switch the platform gateway to the instant "mock" driver */
await login('superadmin@postxbd.app', 'superadmin123');
await http.patch('/platform/settings', { gateway: { driver: 'mock' } });

await login('meena@mart.bd', 'meenapass1');
const beforeExp = (await http.get('/billing/summary')).subscription.expiresAt;
const pay2 = await http.post('/billing/pay', { type: 'monthly', method: 'card' });
T('mock gateway settles instantly (paid)', pay2.payment.status === 'paid' && !!pay2.payment.gatewayRef);
T('paying a monthly charge extends the period', new Date(pay2.summary.subscription.expiresAt).getTime() > new Date(beforeExp).getTime());

/* ---- additional branch purchase (Starter includes 1) ---- */
let blocked = null;
try { await http.post('/branches', { name: 'Second Shop' }); } catch (e) { blocked = e; }
T('POST /branches beyond the plan limit returns 402 + a price', blocked?.status === 402 && blocked?.data?.requiresPurchase === true && blocked?.data?.price > 0);

const br = await http.post('/billing/branch-request', { name: 'Second Shop', code: 'SHOP2', method: 'card' });
T('branch request settles instantly on the mock gateway + activates the branch', br.request.status === 'activated' && !!br.request.branchId);
T('branch request payment is typed "branch"', br.payment.type === 'branch' && br.payment.status === 'paid');

const branchesNow = await http.get('/branches');
T('the purchased branch now exists and is usable', branchesNow.data.some((b) => b.name === 'Second Shop' && b.status === 'active'));
const sum2 = await http.get('/billing/summary');
T('entitlement rose to 2 (1 included + 1 purchased)', sum2.branches.limit === 2 && sum2.branches.extraPaid === 1);

let blocked2 = null;
try { await http.post('/branches', { name: 'Third Shop' }); } catch (e) { blocked2 = e; }
T('the 3rd branch is blocked again at the new limit', blocked2?.status === 402);

/* ---- soft access gate ---- */
await login('superadmin@postxbd.app', 'superadmin123');
const meenaId = (await http.get('/platform/merchants')).data.find((m) => m.email === 'meena@mart.bd').id;
const meenaSub = (await http.get('/platform/subscriptions')).data.find((s) => s.merchantId === meenaId);
await http.patch('/platform/subscriptions/' + meenaSub.id, { action: 'update', status: 'expired' });

const meLogin = await login('meena@mart.bd', 'meenapass1');
T('an expired subscription is reported as blocked in /auth context', meLogin.access.blocked === true && meLogin.access.state === 'expired');
T('a blocked merchant can still READ', Array.isArray((await http.get('/customers')).data));
let gated = null;
try { await http.post('/customers', { name: 'Walk-in Test' }); } catch (e) { gated = e; }
T('a blocked merchant cannot WRITE (402)', gated?.status === 402 && gated?.data?.subscriptionBlocked === true);
T('billing stays reachable while blocked', !!(await http.get('/billing/summary')).subscription);
const cure = await http.post('/billing/pay', { type: 'monthly', method: 'card' });
T('paying clears the block', cure.summary.subscription.status === 'active');
await login('meena@mart.bd', 'meenapass1');
T('writes work again after payment', !!(await http.post('/customers', { name: 'Walk-in OK' })).id);

/* isolation: a merchant cannot see another merchant's billing */
await login('admin@txdemo.shop', 'demo1234');
const other = await http.get('/billing/summary');
T('ISOLATION: /billing/summary only ever returns the caller\'s own subscription', other.subscription.planName === 'Business');
T('ISOLATION: none of Meena\'s payments leak into the demo merchant\'s history', !other.payments.some((p) => p.reference === 'BK-1'));

/* the demo subscription is pinned to run out at the next local midnight so
   testers can watch it lapse — active now, hard cut-off (graceDays 0) at expiry */
const demoSum = await http.get('/billing/summary');
T('DEMO: subscription is active with ~1 day left', demoSum.subscription.status === 'active' && demoSum.subscription.daysLeft <= 1 && demoSum.subscription.daysLeft >= 0, String(demoSum.subscription.daysLeft));
const demoSub = db.collection('subscriptions').all().find((x) => x.planName === 'Business');
T('DEMO: expiry is the next local midnight', new Date(demoSub.expiresAt).getHours() === 0 && new Date(demoSub.expiresAt).getMinutes() === 0);
T('DEMO: graceDays 0 (access ends the moment it expires)', demoSub.graceDays === 0);
// simulate the clock passing expiry: past expiresAt + 0 grace = expired immediately
db.collection('subscriptions').update(demoSub.id, { expiresAt: new Date(Date.now() - 60000).toISOString() });
const lapsed = await http.get('/billing/summary');
T('DEMO: one minute past expiry it is fully expired (no grace window)', lapsed.subscription.status === 'expired', lapsed.subscription.status);
db.collection('subscriptions').update(demoSub.id, { expiresAt: demoSub.expiresAt });

/* a platform admin has no merchant subscription */
await login('superadmin@postxbd.app', 'superadmin123');
let noSub = false;
try { await http.get('/billing/summary'); } catch (e) { noSub = e.status === 400; }
T('a platform account has no /billing subscription (400)', noSub);

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
