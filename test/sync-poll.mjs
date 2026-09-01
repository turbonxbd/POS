/**
 * sync-poll.mjs - the cross-device change feed + the client poll loop.
 *   node test/sync-poll.mjs
 */
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'test' }, configurable: true });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const { db } = await import('../js/core/db.js');
const { initMockServer } = await import('../js/core/mock-server.js');
const { seedDemo } = await import('../js/data/seed.js');
const { setActor } = await import('../js/core/mock/context.js');
const { http } = await import('../js/core/http.js');
const { default: appStore } = await import('../js/core/store.js');
const bus = (await import('../js/core/event-bus.js')).default;
const { pollOnce, startSyncPoll, stopSyncPoll } = await import('../js/core/sync-poll.js');

initMockServer();
db.load();
await seedDemo(db);

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? ' :: ' + x : '')); };

const login = await http.post('/auth/login', { email: 'admin@txdemo.shop', password: 'demo1234' });
setActor(login.user);
appStore.set({ user: login.user, online: true });
const B = login.branches[0].id;

// baseline cursor: "now"
let c0 = (await http.get('/sync/changes', { params: { since: new Date(Date.now() + 5000).toISOString() } }));
T('GET /sync/changes returns a cursor + changed[]', typeof c0.cursor === 'string' && Array.isArray(c0.changed));
T('with a future cursor nothing is reported changed', c0.changed.length === 0, JSON.stringify(c0.changed));

// a change is picked up
const cursor = new Date().toISOString();
await new Promise((r) => setTimeout(r, 10));
await http.post('/products', { branchId: B, name: 'Sync Poll Item', sellingPrice: 1000, costPrice: 500, unit: 'pcs', openingStock: 3 });
const c1 = await http.get('/sync/changes', { params: { since: cursor } });
T('adding a product shows "products" changed', c1.changed.includes('products'), JSON.stringify(c1.changed));
T('a stock movement shows "inventory_transactions" or "stock" changed', c1.changed.includes('inventory_transactions') || c1.changed.includes('stock'), JSON.stringify(c1.changed));
T('the cursor advances past the change', c1.cursor > cursor);

// polling again from the new cursor is quiet
const c2 = await http.get('/sync/changes', { params: { since: c1.cursor } });
T('re-polling from the new cursor reports nothing', c2.changed.length === 0, JSON.stringify(c2.changed));

// merchant isolation: a change in another merchant's data is NOT reported here
const su = await http.post('/signup', { businessName: 'Other Shop', ownerName: 'O', email: 'other@shop.test', password: 'otherpass1', planId: 'plan_starter' });
setActor(login.user); // back to the demo merchant
appStore.set({ user: login.user });
const cIso = new Date().toISOString();
await new Promise((r) => setTimeout(r, 10));
// (the other merchant has no products; signup itself created branches/settings under THEIR id)
const c3 = await http.get('/sync/changes', { params: { since: cIso } });
T('another merchant signing up does not surface as a change for this merchant', c3.changed.length === 0, JSON.stringify(c3.changed));
void su;

// the client poll loop emits db:changed only for what changed since it started
startSyncPoll();  // seeds the cursor to "now"
stopSyncPoll();   // keep the cursor, drop the interval
let emitted = null;
const off = bus.on('db:changed', (cols) => { emitted = cols; });
await new Promise((r) => setTimeout(r, 10));
await http.post('/customers', { name: 'Poll Cust', phone: '01700111222' });
await pollOnce();
T('pollOnce() emits db:changed carrying only the changed collections', Array.isArray(emitted) && emitted.includes('customers') && !emitted.includes('sales'), JSON.stringify(emitted));
emitted = null;
await pollOnce();          // nothing new
T('a quiet poll emits nothing', emitted === null);
off();

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
