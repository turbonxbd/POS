/**
 * platform.mjs - the 2 new POS TXbd panels' backend (mock):
 * plans, public signup, support, Super Admin platform endpoints, and that
 * multi-tenant isolation is genuinely active after seedDemo().
 *
 *   node test/platform.mjs
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

/* ---------------------------------------------------------- plans (public) */
const publicPlans = await http.get('/plans');
T('GET /plans is public and returns 3 active plans', Array.isArray(publicPlans.data) && publicPlans.data.length === 3);
const business = publicPlans.data.find(p => p.name === 'Business');
T('Business plan price is 190000 and marked popular', business.price === 190000 && business.popular === true);
T('plans carry setup + monthly + branch pricing', business.monthlyPrice === 190000 && business.price === business.monthlyPrice && business.setupPrice > 0 && business.includedBranches >= 1 && ('extraBranchPrice' in business));

/* merchant owner cannot manage plans */
await login('admin@txdemo.shop', 'demo1234');
let denied = false;
try { await http.get('/platform/plans'); } catch (e) { denied = e.status === 403; }
T('merchant owner blocked from /platform/plans (403)', denied);

/* ---------------------------------------------------------- super admin */
await login('superadmin@postxbd.app', 'superadmin123');

const beforePrice = business.price;
await http.patch('/platform/plans/' + business.id, { monthlyPrice: 210000, setupPrice: 3000000 });
const afterPub = await http.get('/plans');
const afterBiz = afterPub.data.find(p => p.id === business.id);
T('editing a plan price propagates to the public list (single source of truth)',
  afterBiz.price === 210000 && afterBiz.monthlyPrice === 210000 && afterBiz.setupPrice === 3000000 && beforePrice === 190000);

const dash = await http.get('/platform/dashboard');
T('dashboard: >=1 merchant, 1 active subscription, MRR = subscribed price snapshot (190000)',
  dash.merchants.total >= 1 && dash.subscriptions.active === 1 && dash.revenue.mrr === 190000);
T('dashboard usage reads real seeded data', dash.usage.products > 0 && dash.usage.sales > 0);

const merchants = await http.get('/platform/merchants');
T('merchant list shows the demo merchant with its plan + branch/user counts',
  merchants.data.length >= 1 && merchants.data[0].planName === 'Business' && merchants.data[0].branches === 2 && merchants.data[0].users === 1);
const demoMerchantId = merchants.data[0].id;
T('Super Admin shows the merchant as "TX Demo"', merchants.data[0].businessName === 'TX Demo' && merchants.data[0].name === 'TX Demo');

const detail = await http.get('/platform/merchants/' + demoMerchantId);
T('merchant detail: subscription active, 2 branches, 1 user, usage stats',
  detail.subscription.liveStatus === 'active' && detail.branches.length === 2 && detail.users.length === 1 && detail.usage.sales > 0);

/* S9: merchant list is paginated; S3: tags + internal notes; S2: message a merchant */
const paged = await http.get('/platform/merchants', { params: { pageSize: 1, page: 1 } });
T('merchant list is paginated (pageSize + total + totalPages)',
  paged.data.length === 1 && typeof paged.total === 'number' && paged.totalPages >= 1 && Array.isArray(paged.tags));
await http.patch('/platform/merchants/' + demoMerchantId, { tags: ['VIP', 'chase-payment', 'VIP'] });
const tagged = await http.get('/platform/merchants/' + demoMerchantId);
T('merchant tags are de-duplicated and stored', JSON.stringify(tagged.merchant.tags) === JSON.stringify(['VIP', 'chase-payment']));
const tagFiltered = await http.get('/platform/merchants', { params: { tag: 'VIP' } });
T('merchant list filters by tag', tagFiltered.data.every((m) => m.tags.includes('VIP')) && tagFiltered.tags.includes('VIP'));
const note = await http.post('/platform/merchants/' + demoMerchantId + '/notes', { text: 'Called about the overdue invoice.' });
T('a note is added with an author + timestamp', note.id && note.authorName && note.at);
const withNote = await http.get('/platform/merchants/' + demoMerchantId);
T('the note shows on the merchant detail', withNote.merchant.notes.some((n) => n.id === note.id));
await http.del('/platform/merchants/' + demoMerchantId + '/notes/' + note.id);
T('a note can be deleted', !(await http.get('/platform/merchants/' + demoMerchantId)).merchant.notes.some((n) => n.id === note.id));
let msgBad = false;
try { await http.post('/platform/merchants/' + demoMerchantId + '/message', { message: '' }); } catch (e) { msgBad = e.status === 422; }
T('an empty merchant message is rejected', msgBad);
await http.post('/platform/merchants/' + demoMerchantId + '/message', { title: 'Reminder', message: 'Your payment is due in 3 days.' });
T('messaging a merchant logs an internal note', (await http.get('/platform/merchants/' + demoMerchantId)).merchant.notes.some((n) => n.kind === 'message'));
await http.patch('/platform/merchants/' + demoMerchantId, { tags: [] }); // reset for later assertions

/* the merchant renames their business in Settings -> propagates to Super Admin */
await login('admin@txdemo.shop', 'demo1234');
await http.put('/settings', { business: { name: 'TX Demo Retail', email: 'ops@txdemo.shop' } });
await login('superadmin@postxbd.app', 'superadmin123');
const afterRename = await http.get('/platform/merchants/' + demoMerchantId);
T('SYNC: a merchant business-name edit reaches the Super Admin merchant row + business',
  afterRename.merchant.name === 'TX Demo Retail' && afterRename.business.name === 'TX Demo Retail' && afterRename.business.email === 'ops@txdemo.shop');
const listAfter = await http.get('/platform/merchants');
T('SYNC: the Super Admin merchant list also shows the new name', listAfter.data.find((m) => m.id === demoMerchantId).businessName === 'TX Demo Retail');
// the merchant's own /auth/me reflects it too (what Admin/Cashier read)
const me2 = await login('admin@txdemo.shop', 'demo1234');
T('SYNC: the merchant\'s /auth/login business is the new name', me2.business.name === 'TX Demo Retail');
// put it back so later assertions that expect "TX Demo" still hold
await http.put('/settings', { business: { name: 'TX Demo' } });
await login('superadmin@postxbd.app', 'superadmin123');

/* record a subscription payment -> revenue + activate */
const pay = await http.post('/platform/subscription-payments', { merchantId: demoMerchantId, type: 'monthly', amount: 210000, method: 'bkash' });
T('subscription payment recorded (paid, type monthly)', pay.amount === 210000 && pay.status === 'paid' && pay.type === 'monthly');
const revenue = await http.get('/platform/revenue');
T('revenue: total 210000, byType.monthly 210000, byPlan names the plan', revenue.total === 210000 && revenue.byType.monthly === 210000 && revenue.byPlan[0].planName === 'Business');

/* pending payment -> confirm -> subscription state moves */
const before = await http.get('/platform/merchants/' + demoMerchantId);
const pend = await http.post('/platform/subscription-payments', { merchantId: demoMerchantId, type: 'monthly', amount: 190000, method: 'bank_transfer', reference: 'TXN123', status: 'pending' });
T('a pending payment does not extend the subscription yet', pend.status === 'pending');
const stillSame = await http.get('/platform/merchants/' + demoMerchantId);
T('subscription expiry unchanged while payment pending', stillSame.subscription.expiresAt === before.subscription.expiresAt);
await http.patch('/platform/subscription-payments/' + pend.id, { status: 'paid' });
const afterConfirm = await http.get('/platform/merchants/' + demoMerchantId);
T('confirming the payment extends the subscription period',
  new Date(afterConfirm.subscription.expiresAt).getTime() > new Date(before.subscription.expiresAt).getTime()
  && afterConfirm.subscription.liveStatus === 'active');
const revAfter = await http.get('/platform/revenue');
T('confirmed payment now counts toward revenue; pending count back to 0', revAfter.total === 400000 && revAfter.pendingCount === 0);

/* ---------------------------------------------------------- signup -> isolation */
const su = await http.post('/signup', {
  businessName: 'Karim Traders', ownerName: 'Karim', email: 'karim@traders.bd', password: 'karimpass1', planId: 'plan_starter',
});
T('signup succeeds', su.ok === true && !!su.merchantId);

const karim = await login('karim@traders.bd', 'karimpass1');
T('signup owner lands with their own business + a pending subscription',
  karim.business.name === 'Karim Traders' && karim.subscription.status === 'pending' && karim.subscription.planName === 'Starter');

const karimProducts = await http.get('/products');
T('ISOLATION: new merchant sees 0 products (not the demo catalog)', karimProducts.total === 0);
const karimSales = await http.get('/sales');
T('ISOLATION: new merchant sees 0 sales', karimSales.total === 0);

/* -------------------------------------------------- approvals inbox */
await login('superadmin@postxbd.app', 'superadmin123');
const appr0 = await http.get('/platform/approvals');
T('approvals: the pending signup merchant is queued as an account to approve',
  appr0.data.some((r) => r.merchantId === su.merchantId && r.subscriptionStatus === 'pending')
  && appr0.counts.accounts >= 1);
const dashAttn = await http.get('/platform/dashboard');
T('dashboard exposes the attention counts', dashAttn.attention && dashAttn.attention.accounts === appr0.counts.accounts);
// Karim submits a manual setup payment -> now a payment to verify, with a WhatsApp link
await login('karim@traders.bd', 'karimpass1');
await http.post('/billing/pay', { type: 'initial', methodId: 'bkash', reference: 'KARIM-1', accountNumber: '01720000000' });
await login('superadmin@postxbd.app', 'superadmin123');
const appr1 = await http.get('/platform/approvals');
const kRow = appr1.data.find((r) => r.merchantId === su.merchantId);
T('approvals: the row now carries the pending payment + txn id', kRow.pendingPayment && kRow.pendingPayment.reference === 'KARIM-1' && appr1.counts.payments >= 1);
// approve -> payment paid, subscription active, merchant notified
await http.post('/platform/approvals/' + su.merchantId + '/approve');
const kSub = (await http.get('/platform/merchants/' + su.merchantId)).subscription;
T('approvals: approve activates the subscription + marks the payment paid',
  kSub.liveStatus === 'active'
  && (await http.get('/platform/subscription-payments', { merchantId: su.merchantId })).data.find((p) => p.reference === 'KARIM-1').status === 'paid');
await login('karim@traders.bd', 'karimpass1');
const kNotes = await http.get('/notifications');
T('approvals: the merchant gets an "approved" notification', kNotes.data.some((n) => /approved/i.test(n.title || n.message || '')));
await login('superadmin@postxbd.app', 'superadmin123');
const appr2 = await http.get('/platform/approvals');
T('approvals: an approved merchant drops out of the queue', !appr2.data.some((r) => r.merchantId === su.merchantId));

/* barcodes are unique per-merchant but MAY repeat across merchants */
await login('karim@traders.bd', 'karimpass1');
const karimPen = await http.post('/products', { name: 'Karim Pen', unit: 'pcs', costPrice: 100, sellingPrice: 300 });
T('a new merchant product gets its own generated barcode', /^\d{13}$/.test(karimPen.barcode));
await login('admin@txdemo.shop', 'demo1234');
const demoPen = await http.post('/products', { name: 'Demo Pen (same EAN)', unit: 'pcs', costPrice: 100, sellingPrice: 300, barcode: karimPen.barcode });
T('CROSS-MERCHANT: the same barcode is allowed for a different merchant', demoPen.barcode === karimPen.barcode);
const demoLookup = await http.get('/products/lookup', { params: { code: karimPen.barcode } });
T('barcode lookup stays merchant-scoped (returns the demo merchant\'s product, not Karim\'s)',
  demoLookup.match && demoLookup.product.name === 'Demo Pen (same EAN)');

/* demo merchant still sees only its own data */
await login('admin@txdemo.shop', 'demo1234');
const demoProducts = await http.get('/products');
T('ISOLATION: demo merchant still sees its full catalog', demoProducts.total >= 30);
let cantPlatform = false;
try { await http.get('/platform/dashboard'); } catch (e) { cantPlatform = e.status === 403; }
T('ISOLATION: demo merchant cannot reach the Super Admin panel', cantPlatform);
// router-level guard: a merchant is blocked from EVERY /platform/* route, not just the ones checked above
let cantMerchants = false, cantPlatformWrite = false;
try { await http.get('/platform/merchants'); } catch (e) { cantMerchants = e.status === 403; }
try { await http.post('/platform/subscription-payments', { merchantId: demoMerchantId, type: 'monthly', amount: 1 }); } catch (e) { cantPlatformWrite = e.status === 403; }
T('GUARD: merchant blocked from /platform/merchants (403)', cantMerchants);
T('GUARD: merchant blocked from writing platform data (403)', cantPlatformWrite);
await clearContext();
let anonPlatform = false;
try { await http.get('/platform/dashboard'); } catch (e) { anonPlatform = e.status === 401; }
T('GUARD: an unauthenticated caller cannot reach /platform/* (401)', anonPlatform);
await login('admin@txdemo.shop', 'demo1234');

/* signup dup email + validation */
const aPlan = (await http.get('/plans')).data[0]?.id;
let dup = false; try { await http.post('/signup', { businessName: 'X', email: 'karim@traders.bd', password: 'whatever1', planId: aPlan }); } catch (e) { dup = e.status === 409; }
T('signup rejects a duplicate email (409)', dup);
let bad = false; try { await http.post('/signup', { businessName: '', email: 'nope', password: 'x' }); } catch (e) { bad = e.status === 422; }
T('signup validates input (422)', bad);
let noPlan = false; try { await http.post('/signup', { businessName: 'No Plan Co', email: 'noplan@shop.bd', password: 'whatever1' }); } catch (e) { noPlan = e.status === 422 && !!e.data?.errors?.planId; }
T('signup requires a plan (422)', noPlan);

/* ---------------------------------------------------------- support */
await clearContext();
const req = await http.post('/support', { name: 'Visitor', email: 'v@x.com', message: '3 branches - how much?', planId: 'plan_business' });
T('public support submit', req.ok === true);
await login('superadmin@postxbd.app', 'superadmin123');
const sup = await http.get('/platform/support');
T('super admin sees the open support request', sup.open >= 1);
const rep = await http.post('/platform/support/' + sup.data[0].id + '/reply', { text: 'Business is 210000/mo now.' });
T('super admin can reply (marks answered)', rep.status === 'answered' && rep.replies.length === 1);

/* ---------------------------------------------------- platform settings */
await clearContext();
const pubSet = await http.get('/public-settings');
T('public-settings is public + carries contact.whatsapp', !!pubSet.contact && typeof pubSet.contact.whatsapp === 'string' && !('gateway' in pubSet));
await login('admin@txdemo.shop', 'demo1234');
let setDenied = false; try { await http.get('/platform/settings'); } catch (e) { setDenied = e.status === 403; }
T('merchant blocked from /platform/settings (403)', setDenied);
await login('superadmin@postxbd.app', 'superadmin123');
const full = await http.get('/platform/settings');
T('super admin reads full settings (contact + billing + gateway)', !!full.contact && !!full.billing && !!full.gateway);
await http.patch('/platform/settings', { contact: { whatsapp: '8801999888777' }, billing: { graceDays: 10 } });
await clearContext();
const pub2 = await http.get('/public-settings');
T('WhatsApp edit propagates to the public feed the Live panel reads', pub2.contact.whatsapp === '8801999888777');
await login('superadmin@postxbd.app', 'superadmin123');
T('billing grace days persisted, gateway untouched', (await http.get('/platform/settings')).billing.graceDays === 10);

/* --------------------------------------------------- payment methods */
const set0 = await http.get('/platform/settings');
T('settings ship seeded payment methods (bKash/Nagad/Bank/Card)',
  Array.isArray(set0.paymentMethods) && set0.paymentMethods.length >= 4 && set0.paymentMethods.some((m) => m.id === 'bkash'));
const pmNext = set0.paymentMethods.map((m) => (m.id === 'bkash'
  ? { ...m, accountNumber: '01711999888', instructionsBn: 'নতুন নিয়ম\nধাপ ২' } : m));
pmNext.push({ name: 'Rocket', type: 'mfs', accountNumber: '017-0000', status: 'enabled' });
await http.patch('/platform/settings', { paymentMethods: pmNext });
const set1 = await http.get('/platform/settings');
const bkashM = set1.paymentMethods.find((m) => m.id === 'bkash');
T('payment-method edit persists (number + Bangla steps)', bkashM.accountNumber === '01711999888' && bkashM.instructionsBn.includes('নতুন'));
T('a new method gets a normalised slug id', set1.paymentMethods.some((m) => m.id === 'rocket' && m.type === 'mfs'));
await http.patch('/platform/settings', { paymentMethods: set1.paymentMethods.map((m) => (m.id === 'card' ? { ...m, status: 'disabled' } : m)) });
await clearContext();
const pubNoPm = await http.get('/public-settings');
T('public-settings never exposes payment methods or the gateway', !('paymentMethods' in pubNoPm) && !('gateway' in pubNoPm));
await login('admin@txdemo.shop', 'demo1234');
const billSum = await http.get('/billing/summary');
T('merchant billing summary lists only enabled methods (card hidden)',
  Array.isArray(billSum.paymentMethods) && billSum.paymentMethods.length >= 1
  && billSum.paymentMethods.every((m) => m.status !== 'disabled')
  && !billSum.paymentMethods.some((m) => m.id === 'card'));
await login('superadmin@postxbd.app', 'superadmin123');

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
