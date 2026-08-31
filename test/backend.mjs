/**
 * backend.mjs - exercises the mock backend end-to-end and verifies the
 * data-integrity rules (§50): stock reconciles with the ledger, no negative
 * stock, unique invoice numbers, idempotent checkout, atomic rollback.
 *
 *   node test/backend.mjs
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
const { setActor, setActiveBranch } = await import('../js/core/mock/context.js');
const { http } = await import('../js/core/http.js');
const { resolvePermissions } = await import('../js/core/rbac.js');
initMockServer(); db.load(); await seedDemo(db);

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const step = async (n, fn) => { try { await fn(); } catch (e) { fail++; console.log('FAIL ' + n + ' :: THREW ' + (e.status || '') + ' ' + e.message); } };

const reconcile = (label) => {
  const byKey = new Map();
  for (const t of db.collection('inventory_transactions').all()) {
    const k = t.branchId + '|' + t.productId + '|' + (t.variantId || 'base');
    byKey.set(k, (byKey.get(k) || 0) + t.qtyDelta);
  }
  let mm = 0;
  for (const s of db.collection('stock').all()) {
    if ((byKey.get(s.branchId + '|' + s.productId + '|' + (s.variantId || 'base')) || 0) !== s.quantity) mm++;
  }
  T('stock reconciles with ledger ' + label, mm === 0, mm + ' mismatches');
  T('no negative stock ' + label, !db.collection('stock').all().some(s => s.quantity < 0));
};

// ---- integrity of the seeded dataset ----
reconcile('(seed)');
const inv = db.collection('sales').all().map(s => s.invoiceNo);
T('invoice numbers unique', new Set(inv).size === inv.length, inv.length + ' invoices');

// ---- auth ----
const login = await http.post('/auth/login', { email: 'admin@txdemo.shop', password: 'demo1234' });
setActor(login.user); const B = login.branches[0].id; setActiveBranch(B);
T('login owner', login.role.name === 'Branch Owner');
let badLogin = false;
try { await http.post('/auth/login', { email: 'admin@txdemo.shop', password: 'wrong' }); } catch (e) { badLogin = e.status === 401; }
T('bad password rejected 401', badLogin);

// ---- products ----
let np;
await step('product lifecycle', async () => {
  np = await http.post('/products', { branchId: B, name: 'QA Lipstick', sellingPrice: 35000, costPrice: 20000, unit: 'pcs', openingStock: 10, minStock: 2 });
  T('create + opening stock ledgered', np.stock === 10);
  const pd = await http.get('/products/' + np.id, { params: { branchId: B } });
  await http.patch('/products/' + np.id, { ...pd, sellingPrice: 40000 });
  T('update', (await http.get('/products/' + np.id, { params: { branchId: B } })).sellingPrice === 40000);
  await http.del('/products/' + np.id);
  T('archive is soft (history-safe)', (await http.get('/products/' + np.id, { params: { branchId: B } })).archivedAt != null);
  await http.post('/products/' + np.id + '/restore');
  T('restore', (await http.get('/products/' + np.id, { params: { branchId: B } })).archivedAt == null);
});

// ---- checkout: deduction + idempotency + atomicity ----
await step('checkout', async () => {
  const before = (await http.get('/products/' + np.id, { params: { branchId: B } })).stock;
  const sale = await http.post('/sales', { branchId: B, items: [{ productId: np.id, qty: 2 }], payments: [{ method: 'cash', amount: 100000 }], idempotencyKey: 'k1' });
  T('sale total = 2 x 400.00 (untaxed product)', sale.grandTotal === 80000, String(sale.grandTotal));
  T('cash change computed correctly', sale.changeTotal === 20000, String(sale.changeTotal));
  T('stock deducted', (await http.get('/products/' + np.id, { params: { branchId: B } })).stock === before - 2);
  const replay = await http.post('/sales', { branchId: B, items: [{ productId: np.id, qty: 2 }], payments: [{ method: 'cash', amount: 100000 }], idempotencyKey: 'k1' });
  T('idempotent replay returns original (no dup sale)', replay.invoiceNo === sale.invoiceNo);
  T('no double stock deduction on replay', (await http.get('/products/' + np.id, { params: { branchId: B } })).stock === before - 2);

  // atomic rollback: oversell must not partially deduct
  const cur = (await http.get('/products/' + np.id, { params: { branchId: B } })).stock;
  let rejected = false;
  try { await http.post('/sales', { branchId: B, items: [{ productId: np.id, qty: cur + 999 }], payments: [{ method: 'cash', amount: 99999999 }] }); }
  catch (e) { rejected = e.status === 409; }
  T('oversell rejected', rejected);
  T('failed sale left stock untouched (atomic)', (await http.get('/products/' + np.id, { params: { branchId: B } })).stock === cur);

  // return restocks
  const full = await http.get('/sales/' + sale.id);
  const ret = await http.post('/sales/' + sale.id + '/returns', { reason: 'customer_request', lines: [{ saleItemId: full.items[0].id, qty: 1 }] });
  T('return posted', !!ret.reference);
  T('return restocked +1', (await http.get('/products/' + np.id, { params: { branchId: B } })).stock === cur + 1);
  let overReturn = false;
  try { await http.post('/sales/' + sale.id + '/returns', { reason: 'customer_request', lines: [{ saleItemId: full.items[0].id, qty: 50 }] }); }
  catch (e) { overReturn = e.status === 409; }
  T('cannot return more than sold', overReturn);
});

// ---- payment validation ----
await step('payment rules', async () => {
  let shortPaid = false;
  try { await http.post('/sales', { branchId: B, items: [{ productId: np.id, qty: 1 }], payments: [{ method: 'cash', amount: 1 }] }); }
  catch (e) { shortPaid = e.status === 409; }
  T('incomplete payment rejected', shortPaid);
});

// ---- inventory ops ----
await step('inventory', async () => {
  const adj = await http.post('/inventory/adjustments', { branchId: B, reason: 'recount', lines: [{ productId: np.id, deltaQty: 5 }] });
  T('adjustment applied', adj.netUnits === 5);
  const B2 = login.branches[1].id;
  const fromBefore = (await http.get('/products/' + np.id, { params: { branchId: B } })).stock;
  const toBefore = (await http.get('/products/' + np.id, { params: { branchId: B2 } })).stock;
  const trf = await http.post('/inventory/transfers', { fromBranchId: B, toBranchId: B2, lines: [{ productId: np.id, qty: 3 }] });
  T('branch transfer returns a reference', !!trf.reference);
  T('branch transfer decreases the source branch by 3',
    (await http.get('/products/' + np.id, { params: { branchId: B } })).stock === fromBefore - 3);
  T('branch transfer increases the destination branch by 3',
    (await http.get('/products/' + np.id, { params: { branchId: B2 } })).stock === toBefore + 3);
  T('valuation computes', (await http.get('/inventory/valuation', { params: { branchId: B } })).summary.totalCostValue > 0);
});

// ---- reorder / low-stock report ----
await step('reorder report', async () => {
  const rp = await http.post('/products', { branchId: B, name: 'QA Reorder Item', sellingPrice: 5000, costPrice: 3000, unit: 'pcs', openingStock: 4, minStock: 10 });
  const list = await http.get('/inventory/reorder', { params: { pageSize: 'all' } });
  const row = list.data.find((r) => r.productId === rp.id);
  T('low product appears on the reorder report', !!row);
  T('reorder row reports on-hand across branches', row.onHand === 4, String(row?.onHand));
  T('reorder row suggests an order quantity', row.suggestedQty > 0, String(row?.suggestedQty));
  T('reorder summary counts the item', list.summary.itemsToReorder >= 1);
  T('reorder summary groups by supplier', Array.isArray(list.summary.suppliers));

  // partial PATCH of just { minStock } is allowed and lifts it off the list
  await http.patch('/products/' + rp.id, { minStock: 2 });
  const after = await http.get('/inventory/reorder', { params: { pageSize: 'all' } });
  T('raising the reorder level removes it from the report', !after.data.some((r) => r.productId === rp.id));
  T('partial minStock PATCH kept the rest of the product', (await http.get('/products/' + rp.id, { params: { branchId: B } })).name === 'QA Reorder Item');
});

// ---- purchasing ----
await step('purchasing', async () => {
  const sup = (await http.get('/suppliers', { params: { pageSize: 1 } })).data[0];
  const po = await http.post('/purchases', { branchId: B, supplierId: sup.id, lines: [{ productId: np.id, qty: 20, unitCost: 20000 }], paidTotal: 0 });
  const before = (await http.get('/products/' + np.id, { params: { branchId: B } })).stock;
  await http.post('/purchases/' + po.id + '/receive', { lines: [{ lineId: po.lines[0].id, qty: 20 }] });
  T('receiving adds stock', (await http.get('/products/' + np.id, { params: { branchId: B } })).stock === before + 20);
  await http.post('/purchases/' + po.id + '/returns', { reason: 'defective', lines: [{ lineId: po.lines[0].id, qty: 5 }] });
  T('purchase return removes stock', (await http.get('/products/' + np.id, { params: { branchId: B } })).stock === before + 15);

  // stat-strip summary is computed over the whole filtered set, not page 1
  const pg = await http.get('/purchases', { params: { pageSize: 1, from: '2000-01-01' } });
  const full = await http.get('/purchases', { params: { pageSize: 'all', from: '2000-01-01' } });
  T('purchases summary is whole-set (not page 1)', pg.summary && pg.summary.orders === full.total && pg.data.length === 1);
  T('purchases summary totals match the full list', pg.summary.totalValue === (full.data || []).reduce((s, r) => s + r.grandTotal, 0));
});

// ---- people / finance / org ----
await step('customers', async () => {
  const c = await http.post('/customers', { name: 'QA', phone: '01700000999' });
  let dup = false;
  try { await http.post('/customers', { name: 'Dup', phone: '01700000999' }); } catch (e) { dup = e.status === 409; }
  T('duplicate customer phone rejected', dup);
  T('customer history', (await http.get('/customers/' + c.id + '/history')).customer.id === c.id);
});
await step('register', async () => {
  // the demo owner already has an open register at this branch - close it first
  const cur = await http.get('/cash-register/current', { params: { branchId: B } }).catch(() => null);
  if (cur?.id) await http.post('/cash-register/sessions/' + cur.id + '/close', { countedCash: cur.openingCash || 0 });
  const reg = await http.post('/cash-register/open', { branchId: B, openingCash: 300000 });
  await http.post('/cash-register/sessions/' + reg.id + '/movements', { direction: 'in', amount: 10000, reason: 'cash_in' });
  const closed = await http.post('/cash-register/sessions/' + reg.id + '/close', { countedCash: 310000 });
  T('register close computes expected vs counted', closed.difference === 0, 'diff ' + closed.difference);

  const rs = await http.get('/cash-register/sessions', { params: { pageSize: 1 } });
  const rsAll = await http.get('/cash-register/sessions', { params: { pageSize: 'all' } });
  T('register-session summary counts every session', rs.summary && rs.summary.sessions === rsAll.total);
});
await step('list summaries (expenses + returns)', async () => {
  await http.post('/expenses', { branchId: B, category: 'Electricity', description: 'QA power bill', amount: 12345, paymentMethod: 'cash', at: new Date().toISOString() });
  const ex1 = await http.get('/expenses', { params: { pageSize: 1, from: '2000-01-01' } });
  const exAll = await http.get('/expenses', { params: { pageSize: 'all', from: '2000-01-01' } });
  T('expenses summary sums the whole set', ex1.summary && ex1.summary.totalAmount === (exAll.data || []).reduce((s, e) => s + e.amount, 0));
  T('expenses summary count matches total', ex1.summary.count === exAll.total);

  const rr = await http.get('/sale-returns', { params: { pageSize: 1, from: '2000-01-01' } });
  const rrAll = await http.get('/sale-returns', { params: { pageSize: 'all', from: '2000-01-01' } });
  T('sale-returns summary is whole-set', rr.summary && (rr.summary.returns + rr.summary.exchanges) === rrAll.total);
});
await step('settings', async () => {
  const st = await http.get('/settings');
  await http.put('/settings', { pos: { receiptSize: '58' } });
  const st2 = await http.get('/settings');
  T('settings deep-merge keeps siblings', st2.pos.receiptSize === '58' && st2.business.name === st.business.name);
});

// ---- reports ----
const badReports = [];
for (const rt of ['sales', 'profit', 'purchases', 'inventory', 'stock-movement', 'customers', 'suppliers', 'expenses', 'cashier', 'payments', 'tax', 'product-performance', 'category-performance', 'daily-closing', 'dead-stock']) {
  try { if (!Array.isArray((await http.get('/reports/' + rt, { params: { branchId: B, preset: 'this_year' } })).rows)) badReports.push(rt); }
  catch (e) { badReports.push(rt + '(' + e.message + ')'); }
}
T('all 15 reports return rows[]', badReports.length === 0, badReports.join(', '));

await step('dead-stock report', async () => {
  const dp = await http.post('/products', { branchId: B, name: 'QA Dead Item', sellingPrice: 8000, costPrice: 5000, unit: 'pcs', openingStock: 6 });
  const rep = await http.get('/reports/dead-stock', { params: { branchId: B, days: 90 } });
  const row = rep.rows.find((r) => r.productId === dp.id);
  T('a never-sold in-stock product is flagged dead', row && row.status === 'dead', JSON.stringify(row));
  T('dead-stock row carries on-hand + value', row.quantity === 6 && row.stockValue === 30000, String(row?.stockValue));
  T('dead-stock totals expose deadValue / deadCount', typeof rep.totals.deadValue === 'number' && rep.totals.deadCount >= 1);
  const slow = await http.get('/reports/dead-stock', { params: { branchId: B, days: 90, stockStatus: 'slow' } });
  T('stockStatus filter narrows the rows', slow.rows.every((r) => r.status === 'slow'));
});
T('dashboard aggregates from persisted sales', (await http.get('/dashboard', { params: { branchId: B, preset: 'this_year' } })).kpis.totalSales > 0);
await step('all-branches scope', async () => {
  const B2 = login.branches[1].id;
  const one = await http.get('/dashboard', { params: { branchId: B, preset: 'this_year' } });
  const two = await http.get('/dashboard', { params: { branchId: B2, preset: 'this_year' } });
  const all = await http.get('/dashboard', { params: { branchId: 'all', preset: 'this_year' } });
  T('branchId=all dashboard >= a single branch', all.kpis.totalSales >= one.kpis.totalSales);
  T('branchId=all dashboard covers both branches', all.kpis.totalSales >= one.kpis.totalSales + two.kpis.totalSales - 1);
  const repAll = await http.get('/reports/sales', { params: { branchId: 'all', preset: 'this_year' } });
  const repOne = await http.get('/reports/sales', { params: { branchId: B, preset: 'this_year' } });
  T('branchId=all sales report has at least as many rows', repAll.rows.length >= repOne.rows.length);
});
T('audit log append-only & populated', (await http.get('/audit-logs', { params: { pageSize: 5 } })).data.length > 0);
await step('audit log filters', async () => {
  const all = await http.get('/audit-logs', { params: { pageSize: 'all' } });
  const mine = all.data.find((l) => l.actorId);
  const byActor = await http.get('/audit-logs', { params: { pageSize: 'all', actorId: mine.actorId } });
  T('actorId filter narrows the log', byActor.data.length > 0 && byActor.data.every((l) => l.actorId === mine.actorId));
  const withBranch = all.data.find((l) => l.meta?.branchId);
  const byBranch = await http.get('/audit-logs', { params: { pageSize: 'all', branchId: withBranch.meta.branchId } });
  T('branchId filter narrows the log', byBranch.data.every((l) => (l.meta?.branchId || l.branchId) === withBranch.meta.branchId));
  const future = await http.get('/audit-logs', { params: { pageSize: 'all', from: '2099-01-01' } });
  T('a future "from" date returns nothing', future.data.length === 0);
});
T('backup export contains data', (await http.get('/backup/export')).collections.products.length > 0);

// ---- RBAC ---- (TX Demo ships owner-only; add a Cashier to check role separation)
setActor(login.user);
const cashierRole = (await http.get('/roles')).data.find((r) => r.name === 'Cashier');
await http.post('/employees', { name: 'RBAC Cashier', email: 'rbac.cashier@txdemo.shop', password: 'demo1234', roleId: cashierRole.id, branchIds: [B] });
const cLogin = await http.post('/auth/login', { email: 'rbac.cashier@txdemo.shop', password: 'demo1234' });
const cPerms = resolvePermissions(cLogin.user, cLogin.role);
T('cashier lacks settings.manage & wildcard', !cPerms.has('settings.manage') && !cPerms.has('*'));
T('cashier can operate POS', cPerms.has('pos.operate') && cPerms.has('sales.create'));
setActor(login.user);

// ---- persistence: reload from the same localStorage blob ----
await step('persistence', async () => {
  db.flush();
  const raw = store.get('afia_pos_db_v3');
  const parsed = JSON.parse(raw);
  T('DB persisted to storage', parsed.collections.sales.length > 0);
  T('sequences persisted (no invoice reuse after reload)', Object.keys(parsed.meta.sequences).some(k => k.startsWith('invoice:')));
});

// ---- coupons + automatic discounts ----
await step('coupons + automatic discounts', async () => {
  setActor(login.user);
  await http.post('/cash-register/open', { branchId: B, openingCash: 0 }).catch(() => {});
  const P = await http.post('/products', { branchId: B, name: 'QA Coupon Item', sellingPrice: 10000, costPrice: 4000, unit: 'pcs', openingStock: 50, minStock: 1 });

  // fixed-amount coupon
  await http.post('/discounts', { name: 'Ten off', code: 'save10', type: 'fixed', value: 10, scope: 'cart', status: 'active' });
  const val = await http.post('/discounts/validate', { code: 'SAVE10', subtotal: 30000 });
  T('coupon validates + returns amount', val.valid && val.amount === 1000, JSON.stringify(val));

  const s1 = await http.post('/sales', { branchId: B, items: [{ productId: P.id, qty: 3 }], couponCode: 'SAVE10', payments: [{ method: 'cash', amount: 29000 }] });
  T('coupon applied to sale total (300.00 - 10.00)', s1.grandTotal === 29000, String(s1.grandTotal));
  T('sale records the coupon', s1.couponCode === 'SAVE10' && s1.couponDiscount === 1000, `${s1.couponCode}/${s1.couponDiscount}`);
  const d1 = (await http.get('/discounts', { params: { pageSize: 'all' } })).data.find((d) => d.code === 'SAVE10');
  T('coupon usageCount incremented', d1.usageCount === 1, String(d1.usageCount));

  // unknown coupon rejected at checkout
  let bad = false;
  try { await http.post('/sales', { branchId: B, items: [{ productId: P.id, qty: 1 }], couponCode: 'NOPE', payments: [{ method: 'cash', amount: 10000 }] }); }
  catch (e) { bad = e.status === 422 || e.status === 400; }
  T('unknown coupon rejected at checkout', bad);

  // automatic (no-code) percent discount applies itself
  await http.post('/discounts', { name: 'Auto 10%', type: 'percent', value: 10, scope: 'cart', status: 'active' });
  const s2 = await http.post('/sales', { branchId: B, items: [{ productId: P.id, qty: 2 }], payments: [{ method: 'cash', amount: 18000 }] });
  T('automatic discount applied with no code (200.00 - 10%)', s2.grandTotal === 18000, String(s2.grandTotal));
  T('sale records the automatic discount', s2.autoDiscount === 2000 && /Auto 10%/.test(s2.autoDiscountName || ''), `${s2.autoDiscount}/${s2.autoDiscountName}`);
});

// ---- fixed-amount VAT (a flat fee on every sale) ----
await step('fixed-amount VAT', async () => {
  setActor(login.user);
  await http.post('/cash-register/open', { branchId: B, openingCash: 0 }).catch(() => {});
  // drop the automatic discounts a previous step created so totals are clean
  for (const d of (await http.get('/discounts', { params: { pageSize: 'all' } })).data.filter((x) => !x.code && !x.archivedAt)) {
    await http.del('/discounts/' + d.id);
  }
  const P = await http.post('/products', { branchId: B, name: 'QA VAT Item', sellingPrice: 10000, costPrice: 4000, unit: 'pcs', openingStock: 20, minStock: 1 });

  let badRate = false;
  try { await http.post('/taxes', { name: 'Bad', type: 'fixed', amount: 0 }); } catch (e) { badRate = e.status === 422; }
  T('fixed VAT with no amount is rejected', badRate);

  const fee = await http.post('/taxes', { name: 'Service charge', type: 'fixed', amount: 500 });
  T('fixed VAT stores type + amount, rate 0', fee.type === 'fixed' && fee.amount === 500 && fee.rate === 0, JSON.stringify(fee));

  const s = await http.post('/sales', { branchId: B, items: [{ productId: P.id, qty: 2 }], payments: [{ method: 'cash', amount: 20500 }] });
  T('fixed VAT adds a flat 5.00 to the 200.00 sale', s.grandTotal === 20500, String(s.grandTotal));
  T('fixed VAT shows in taxTotal + a tax line', s.taxTotal === 500 && (s.taxLines || []).some((l) => l.fixed && l.amount === 500), JSON.stringify(s.taxLines));

  await http.del('/taxes/' + fee.id); // archive so it stops affecting later reconcile sales
  const s2 = await http.post('/sales', { branchId: B, items: [{ productId: P.id, qty: 1 }], payments: [{ method: 'cash', amount: 10000 }] });
  T('archived fixed VAT no longer applies', s2.grandTotal === 10000, String(s2.grandTotal));
});

// ---- credit / due sale + later payment ----
await step('due sale + record payment', async () => {
  setActor(login.user);
  const cust = await http.post('/customers', { name: 'Credit Buyer', phone: '01799990000' });
  const P = await http.post('/products', { branchId: B, name: 'QA Due Item', sellingPrice: 10000, costPrice: 4000, unit: 'pcs', openingStock: 20, minStock: 1 });

  // 3 x 100 = 300; pay 100 cash now, 200 on account
  const sale = await http.post('/sales', {
    branchId: B, customerId: cust.id, onAccount: true,
    items: [{ productId: P.id, qty: 3 }],
    payments: [{ method: 'cash', amount: 10000 }],
  });
  T('due sale records the shortfall as dueTotal', sale.dueTotal === 20000 && sale.status === 'due', `${sale.dueTotal}/${sale.status}`);
  T('due sale bumps the customer outstanding balance',
    (await http.get('/customers/' + cust.id)).outstandingBalance === 20000);

  // pay 120 later
  const paid1 = await http.post('/sales/' + sale.id + '/payment', { amount: 12000, method: 'cash' });
  T('recording a due payment reduces dueTotal', paid1.dueTotal === 8000, String(paid1.dueTotal));
  T('and reduces the customer outstanding balance',
    (await http.get('/customers/' + cust.id)).outstandingBalance === 8000);

  // over-payment is rejected
  let over = false;
  try { await http.post('/sales/' + sale.id + '/payment', { amount: 99999 }); } catch (e) { over = e.status === 422; }
  T('over-payment against a due sale is rejected', over);

  // clear the rest -> sale completed
  const paid2 = await http.post('/sales/' + sale.id + '/payment', { amount: 8000, method: 'bkash', reference: 'BK-DUE-1' });
  T('paying the balance flips the sale back to completed', paid2.dueTotal === 0 && paid2.status === 'completed');

  // a manual customer-balance payment records a payments row
  const c2 = await http.post('/customers', { name: 'Opening Owed', phone: '01788880000', openingBalance: 5000 });
  const paysBefore = db.collection('payments').count();
  await http.post('/customers/' + c2.id + '/balance', { type: 'payment', amount: 2000, method: 'cash' });
  T('a customer-balance payment lowers the balance', (await http.get('/customers/' + c2.id)).outstandingBalance === 3000);
  T('a customer-balance payment records a cash-in payment row', db.collection('payments').count() === paysBefore + 1);
});

reconcile('(after all ops)');

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
