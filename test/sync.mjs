/**
 * sync.mjs - merchant-identity consistency:
 *  - migrateDemoIdentity: an old "Afia Cosmetics" local DB is renamed to
 *    "TX Demo" on boot (business, merchant row, branch + staff emails, settings)
 *  - reconcileMerchantIdentity: merchants.name + settings.business.name follow
 *    the businesses row (fixes drift from an edit that only hit one place)
 *
 *   node test/sync.mjs
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
const { seedDemo, migrateDemoIdentity, reconcileMerchantIdentity } = await import('../js/data/seed.js');
initMockServer(); db.load(); await seedDemo(db);

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const biz = () => db.collection('businesses').all()[0];
const merch = () => db.collection('merchants').all().find((m) => m.id === biz().merchantId);
const setts = () => db.collection('settings').all().find((s) => s.merchantId === biz().merchantId);

/* fresh seed is already "TX Demo" everywhere */
T('fresh seed: business + merchant + settings all say "TX Demo"',
  biz().name === 'TX Demo' && merch().name === 'TX Demo' && setts().business.name === 'TX Demo');
T('fresh seed: no migration needed', migrateDemoIdentity(db) === false);

/* simulate an OLD localStorage DB (pre-rename) */
const bz = biz();
db.collection('businesses').update(bz.id, { name: 'Afia Cosmetics', legalName: 'Afia Cosmetics & Beauty Ltd.', email: 'hello@afiacosmetics.shop', website: 'afiacosmetics.shop' });
db.collection('merchants').update(bz.merchantId, { name: 'Afia Cosmetics' });
for (const b of db.collection('branches').all()) db.collection('branches').update(b.id, { email: `x@afiacosmetics.shop` });
for (const u of db.collection('users').all()) if (!u.platform) db.collection('users').update(u.id, { email: u.email.replace('@txdemo.shop', '@afiacosmetics.shop') });
db.collection('settings').update(setts().id, { business: { ...setts().business, name: 'Afia Cosmetics', invoicePrefix: 'AFIA' }, receipt: { ...setts().receipt, header: 'Afia Cosmetics' } });

/* run the boot migration */
const changed = migrateDemoIdentity(db);
T('stale DB: migrateDemoIdentity reports it changed something', changed === true);
T('stale DB: business renamed to "TX Demo"', biz().name === 'TX Demo' && biz().email === 'hello@txdemo.shop' && biz().website === 'txdemo.shop');
T('stale DB: merchant row renamed to "TX Demo"', merch().name === 'TX Demo');
T('stale DB: every staff email moved to @txdemo.shop', db.collection('users').all().filter(u => !u.platform).every(u => u.email.endsWith('@txdemo.shop')));
T('stale DB: branch emails moved to @txdemo.shop', db.collection('branches').all().every(b => (b.email || '').endsWith('@txdemo.shop')));
T('stale DB: settings identity + invoice prefix fixed', setts().business.name === 'TX Demo' && setts().business.invoicePrefix === 'TXD' && setts().receipt.header === 'TX Demo');
T('stale DB: a 2nd run is a no-op', migrateDemoIdentity(db) === false);

/* reconcile: business is the source of truth */
db.collection('merchants').update(biz().merchantId, { name: 'Drifted Name' });
db.collection('settings').update(setts().id, { business: { ...setts().business, name: 'Also Drifted' } });
T('drift: reconcileMerchantIdentity reports it changed something', reconcileMerchantIdentity(db) === true);
T('drift: merchant row + settings.business.name snap back to the businesses row',
  merch().name === biz().name && setts().business.name === biz().name);
T('drift: a 2nd reconcile is a no-op', reconcileMerchantIdentity(db) === false);

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
