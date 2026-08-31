/**
 * seed.js - realistic demo data for the "TX Demo" merchant.
 *
 * seedDemo(db) builds a fully self-consistent dataset: every unit of stock is
 * backed by an opening / purchase / sale ledger entry, so the inventory numbers
 * reconcile exactly. seedBlank(db) creates the minimum to run (one business,
 * one branch, roles, the owner account, default tax & settings).
 *
 * Demo data is flagged with db.meta.demo = true and can be wiped from
 * Settings -> Backup / Data Management.
 */

import { ROLE_PRESETS } from './permissions.js';
import { hashPassword } from '../utils/crypto.js';
import { uuid, generateEan13, suggestSku } from '../utils/id.js';
import { computeCart } from '../core/mock/helpers.js';
import { DEFAULT_PRINT } from '../core/print-config.js';
import { TENANT_COLLECTIONS } from '../core/mock/scope.js';
import { DEFAULT_PLANS } from './plans.js';
import { ensurePlatformSettings } from '../core/mock/platform-settings.routes.js';

/** Platform Super Admin login - the one account that reaches superadmin.html. */
export const SUPER_ADMIN_EMAIL = 'superadmin@postxbd.app';
export const SUPER_ADMIN_PASSWORD = 'superadmin123';

/**
 * Turn a single-business dataset into a proper multi-tenant one:
 * seed the plans, create the merchant + a subscription + the platform Super
 * Admin, then stamp merchantId onto every tenant record. After this,
 * mock/scope.js isolation is live and every panel behaves like the PHP backend.
 *
 * Idempotent: safe to run on a fresh seed OR to upgrade a DB that was seeded
 * before the 5-panel platform existed (boot.js self-heal calls it that way).
 */
export async function activateMultiTenant(db, business, { demo } = {}) {
  business = business || db.collection('businesses').all()[0] || { name: 'My Business' };

  // 1. system roles - a pre-platform seed has no role_super_admin row
  for (const preset of ROLE_PRESETS) {
    if (preset.system && !db.collection('roles').get(preset.id)) {
      db.collection('roles').insert({ ...preset });
    }
  }

  // 2. plans (public pricing - single source of truth for the Live panel)
  if (db.collection('plans').count() === 0) {
    DEFAULT_PLANS.forEach((p) => db.collection('plans').insert({ ...p }));
  }

  // 2b. platform settings (contact / billing defaults / gateway)
  ensurePlatformSettings();

  // 3. the merchant row (its presence is what flips scope.js out of legacy mode)
  const merchant = db.collection('merchants').all()[0] || db.collection('merchants').insert({
    id: uuid(), name: business.name, status: 'active',
    createdAt: business.createdAt || new Date().toISOString(),
  });
  const M = merchant.id;

  // 4. stamp merchantId onto every tenant record that is missing one
  for (const name of TENANT_COLLECTIONS) {
    for (const row of db.collection(name).all()) {
      if (row.merchantId == null) db.collection(name).update(row.id, { merchantId: M });
    }
  }
  for (const u of db.collection('users').all()) {
    if (!u.platform && u.merchantId == null) db.collection('users').update(u.id, { merchantId: M });
  }

  // 5. settings id is keyed by merchant once multi-tenant is on
  const settings = db.collection('settings').all().find((s) => s.id !== 'settings_' + M);
  if (settings) {
    db.collection('settings').remove(settings.id);
    db.collection('settings').insert({ ...settings, id: 'settings_' + M, merchantId: M });
  }

  // 6. a subscription for the merchant (active, setup paid - it's the demo shop)
  if (!db.collection('subscriptions').all().some((s) => s.merchantId === M)) {
    const plan = db.collection('plans').all().find((p) => p.name === 'Business') || db.collection('plans').all()[0];
    const nowD = new Date();
    // DEMO: the subscription runs out at the next local midnight so testers can
    // watch it lapse. graceDays 0 = access is cut off the instant it expires.
    const expires = new Date(nowD); expires.setHours(24, 0, 0, 0);
    const started = new Date(expires); started.setMonth(started.getMonth() - 1);
    const monthlyPrice = plan?.monthlyPrice ?? plan?.price ?? null;
    db.collection('subscriptions').insert({
      id: uuid(), merchantId: M, planId: plan?.id || null,
      planName: plan?.name || null, planPrice: monthlyPrice, monthlyPrice,
      setupPrice: plan?.setupPrice ?? 0,
      includedBranches: plan?.includedBranches ?? 1,
      billingPeriod: plan?.billingPeriod || 'monthly',
      status: 'active', setupPaid: true, extraBranchesPaid: 0,
      branchLimit: plan?.includedBranches ?? 1,
      graceDays: 0,
      startedAt: started.toISOString(), expiresAt: expires.toISOString(),
      nextBillingAt: expires.toISOString(), lastPaymentAt: started.toISOString(),
      createdAt: nowD.toISOString(),
    });
  }

  // 7. the platform Super Admin - not tied to any merchant. Reset its
  //    credentials every run so a stale/half-written row can't lock you out.
  const hash = await hashPassword(SUPER_ADMIN_PASSWORD);
  const existing = db.collection('users').all().find(
    (u) => (u.email || '').toLowerCase() === SUPER_ADMIN_EMAIL,
  );
  if (existing) {
    db.collection('users').update(existing.id, {
      passwordHash: hash, roleId: 'role_super_admin', status: 'active',
      platform: true, merchantId: null,
    });
  } else {
    db.collection('users').insert({
      id: uuid(), name: 'POS TXbd Admin', email: SUPER_ADMIN_EMAIL,
      passwordHash: hash, roleId: 'role_super_admin', status: 'active',
      platform: true, merchantId: null,
      permissionGrants: [], permissionRevokes: [], lastLoginAt: null,
    });
  }

  if (demo != null) db.meta.demo = demo;
  return M;
}

/**
 * Non-destructive upgrade for a browser whose local DB was seeded before the
 * 5-panel platform shipped: it has users/products but no `merchants` row and
 * no Super Admin account. Adds only what is missing - no data is touched.
 * Returns true if it changed anything.
 */
export async function ensurePlatform(db) {
  const hasMerchant = db.collection('merchants').count() > 0;
  const hasSuperAdmin = db.collection('users').all().some(
    (u) => u.platform && (u.email || '').toLowerCase() === SUPER_ADMIN_EMAIL,
  );
  if (hasMerchant && hasSuperAdmin) {
    const a = migratePlanFields(db);
    const b = ensurePlatformSettings();
    const c = migrateDemoIdentity(db);
    const e = trimDemoStaffToOwner(db);
    const d = reconcileMerchantIdentity(db);
    const f = dedupeProductBarcodes(db) > 0;
    if (b || c || d || e || f) db.flush();
    return a || b || c || d || e || f;
  }
  await activateMultiTenant(db, db.collection('businesses').all()[0], {});
  migrateDemoIdentity(db);
  trimDemoStaffToOwner(db);
  reconcileMerchantIdentity(db);
  db.flush();
  return true;
}

const OLD_DOMAIN = '@afiacosmetics.shop';
const NEW_DOMAIN = '@txdemo.shop';

/**
 * Heal barcodes that collide WITHIN a merchant (an old bug generated the same
 * EAN for every product created in an ~11-day window). Keeps the first holder
 * of each code; re-generates a fresh unique one for the rest and for any
 * product/variant missing a barcode. Barcodes may still repeat ACROSS merchants
 * - that is intentional (a shared manufacturer EAN). Returns count fixed.
 */
export function dedupeProductBarcodes(db) {
  const products = db.collection('products').all();
  const byMerchant = new Map(); // merchantId -> Set<barcode>
  const seenMk = new Set();      // `${merchantId}:${barcode}` already claimed
  let fixed = 0;

  for (const p of products) {
    const mid = p.merchantId || '_';
    if (!byMerchant.has(mid)) byMerchant.set(mid, new Set());
    const used = byMerchant.get(mid);
    const fresh = () => {
      let c;
      do { c = generateEan13(); } while (used.has(c));
      used.add(c);
      return c;
    };
    let changed = false;
    const patch = {};

    const bmk = `${mid}:${p.barcode}`;
    if (!p.barcode || seenMk.has(bmk)) {
      patch.barcode = fresh();
      changed = true;
    } else {
      used.add(p.barcode);
      seenMk.add(bmk);
    }

    if (Array.isArray(p.variants) && p.variants.length) {
      const nextVariants = p.variants.map((v) => {
        const vmk = `${mid}:${v.barcode}`;
        if (!v.barcode || seenMk.has(vmk) || (patch.barcode && v.barcode === patch.barcode)) {
          changed = true;
          return { ...v, barcode: fresh() };
        }
        used.add(v.barcode);
        seenMk.add(vmk);
        return v;
      });
      if (changed) patch.variants = nextVariants;
    }

    if (changed) {
      db.collection('products').update(p.id, patch);
      fixed++;
    }
  }
  return fixed;
}

/**
 * One-time rename of the demo merchant "Afia Cosmetics" -> "TX Demo" for a
 * browser whose local DB was seeded before the rename. Renames the business,
 * merchant row, branch + staff emails and the settings identity - it does NOT
 * touch any transactional data. Returns true if it changed anything.
 */
export function migrateDemoIdentity(db) {
  const biz = db.collection('businesses').all()[0];
  if (!biz) return false;
  const stale = biz.name === 'Afia Cosmetics'
    || db.collection('users').all().some((u) => !u.platform && (u.email || '').toLowerCase().endsWith(OLD_DOMAIN));
  if (!stale) return false;

  db.collection('businesses').update(biz.id, {
    name: 'TX Demo', legalName: 'TX Demo Retail Ltd.',
    email: (biz.email || '').includes('afiacosmetics') ? 'hello@txdemo.shop' : biz.email,
    website: (biz.website || '').includes('afiacosmetics') ? 'txdemo.shop' : biz.website,
  });
  for (const m of db.collection('merchants').all()) {
    if (m.name === 'Afia Cosmetics') db.collection('merchants').update(m.id, { name: 'TX Demo' });
  }
  for (const b of db.collection('branches').all()) {
    if ((b.email || '').toLowerCase().endsWith(OLD_DOMAIN)) {
      db.collection('branches').update(b.id, { email: b.email.slice(0, -OLD_DOMAIN.length) + NEW_DOMAIN });
    }
  }
  for (const u of db.collection('users').all()) {
    if (!u.platform && (u.email || '').toLowerCase().endsWith(OLD_DOMAIN)) {
      db.collection('users').update(u.id, { email: u.email.slice(0, -OLD_DOMAIN.length) + NEW_DOMAIN });
    }
  }
  for (const s of db.collection('settings').all()) {
    if (s.business?.name !== 'Afia Cosmetics' && s.business?.invoicePrefix !== 'AFIA') continue;
    const patch = {
      business: {
        ...s.business, name: 'TX Demo', legalName: 'TX Demo Retail Ltd.',
        email: (s.business?.email || '').includes('afiacosmetics') ? 'hello@txdemo.shop' : s.business?.email,
        website: (s.business?.website || '').includes('afiacosmetics') ? 'txdemo.shop' : s.business?.website,
        invoicePrefix: s.business?.invoicePrefix === 'AFIA' ? 'TXD' : s.business?.invoicePrefix,
      },
    };
    if ((s.pos?.invoiceTemplate || '').startsWith('AFIA')) patch.pos = { ...s.pos, invoiceTemplate: 'TXD' + s.pos.invoiceTemplate.slice(4) };
    if (s.receipt?.header === 'Afia Cosmetics') patch.receipt = { ...s.receipt, header: 'TX Demo' };
    if (s.print?.invoice?.headerText === 'Afia Cosmetics') patch.print = { ...s.print, invoice: { ...s.print.invoice, headerText: '' } };
    db.collection('settings').update(s.id, patch);
  }

  trimDemoStaffToOwner(db);
  return true;
}

const DEMO_EXTRA_STAFF = ['manager', 'cashier', 'cashier2', 'inventory', 'accounts'];

/**
 * The demo merchant ships with only the Branch Owner. On a browser seeded with
 * the old 6-person staff, remove the extra seeded accounts and re-attribute
 * their sales / registers / expenses to the owner so history stays coherent.
 * Cashier / Manager / etc. can be re-added any time from Merchant Admin.
 */
export function trimDemoStaffToOwner(db) {
  if (db.meta?.demo !== true) return false;
  const owner = db.collection('users').all().find((u) => !u.platform && u.roleId === 'role_owner');
  if (!owner) return false;
  const extras = db.collection('users').all().filter((u) => {
    if (u.platform || u.id === owner.id) return false;
    const local = String(u.email || '').split('@')[0].toLowerCase();
    return DEMO_EXTRA_STAFF.includes(local);
  });
  if (!extras.length) return false;

  for (const u of extras) {
    for (const s of db.collection('sales').all()) {
      if (s.cashierId === u.id) db.collection('sales').update(s.id, { cashierId: owner.id, cashierName: owner.name });
    }
    for (const r of db.collection('register_sessions').all()) {
      if (r.cashierId === u.id) db.collection('register_sessions').update(r.id, { cashierId: owner.id, cashierName: owner.name });
    }
    for (const mv of db.collection('register_movements').all()) {
      if (mv.byId === u.id || mv.employeeId === u.id) db.collection('register_movements').update(mv.id, { byId: owner.id, byName: owner.name, employeeId: owner.id });
    }
    for (const e of db.collection('expenses').all()) {
      if (e.employeeId === u.id) db.collection('expenses').update(e.id, { employeeId: owner.id, employeeName: owner.name });
    }
    for (const emp of db.collection('employees').all()) {
      if (emp.userId === u.id) db.collection('employees').remove(emp.id);
    }
    db.collection('users').remove(u.id);
  }
  return true;
}

/**
 * Keep the merchant identity consistent: the `merchants` row name and
 * `settings.business.name` follow the `businesses` row (the value every panel
 * reads via /auth/me). Fixes drift from an edit that only hit one of the three.
 */
export function reconcileMerchantIdentity(db) {
  let changed = false;
  for (const biz of db.collection('businesses').all()) {
    const mid = biz.merchantId;
    const truth = biz.name;
    if (!truth) continue;
    if (mid) {
      const m = db.collection('merchants').get(mid);
      if (m && m.name !== truth) { db.collection('merchants').update(mid, { name: truth }); changed = true; }
    }
    const s = db.collection('settings').get('settings_' + (mid || 'singleton'))
      || db.collection('settings').all().find((x) => x.merchantId === mid);
    if (s && s.business && s.business.name !== truth) {
      db.collection('settings').update(s.id, { business: { ...s.business, name: truth } });
      changed = true;
    }
  }
  return changed;
}

/**
 * Backfill the setup / monthly / branch pricing fields onto plan rows that were
 * created before those fields existed. Non-destructive; returns true if changed.
 */
export function migratePlanFields(db) {
  let changed = false;
  for (const p of db.collection('plans').all()) {
    const patch = {};
    if (p.monthlyPrice == null) patch.monthlyPrice = p.price || 0;
    if (p.price == null && patch.monthlyPrice != null) patch.price = patch.monthlyPrice;
    if (p.setupPrice == null) patch.setupPrice = 0;
    if (p.includedBranches == null) patch.includedBranches = p.limits?.branches || 1;
    if (!('extraBranchPrice' in p)) patch.extraBranchPrice = null;
    if (Object.keys(patch).length) { db.collection('plans').update(p.id, patch); changed = true; }
  }
  if (changed) db.flush();
  return changed;
}

/* deterministic PRNG so re-seeds are stable */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(20260827);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const rint = (min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const daysAgo = (n, jitterH = 10) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(rint(9, 20), rint(0, 59), rint(0, 59), 0);
  return d.toISOString();
};
const bdt = (major) => Math.round(major * 100); // -> minor units

/* --------------------------------------------------------------- blank */
export async function seedBlank(db) {
  db.reset();
  const business = db.collection('businesses').insert({
    id: uuid(), name: 'My Business', legalName: '', logoId: null,
    address: '', phone: '', email: '', website: '', vatNo: '',
    currency: 'BDT', currencySymbol: '৳',
  });
  const branch = db.collection('branches').insert({
    id: uuid(), name: 'Main Store', code: 'MAIN', address: business.address,
    phone: '', email: '', isDefault: true, status: 'active',
  });
  ROLE_PRESETS.forEach((r) => db.collection('roles').insert({ ...r }));
  const ownerRole = db.collection('roles').all().find((r) => r.id === 'role_owner' || r.name === 'Branch Owner');
  const owner = db.collection('users').insert({
    id: uuid(), name: 'Owner', email: 'owner@mybusiness.shop',
    passwordHash: await hashPassword('demo1234'), roleId: ownerRole.id,
    status: 'active', permissionGrants: [], permissionRevokes: [], lastLoginAt: null,
  });
  db.collection('employees').insert({ id: uuid(), userId: owner.id, branchIds: [branch.id], joinDate: new Date().toISOString() });
  db.collection('taxes').insert({ id: uuid(), name: 'VAT 15%', rate: 15, inclusive: false, scope: 'product', isDefault: true, status: 'active' });
  db.collection('settings').insert(defaultSettings(business));
  await activateMultiTenant(db, business, { demo: false });
  db.meta.seededAt = new Date().toISOString();
  db.flush();
  return { ownerEmail: owner.email };
}

/* ---------------------------------------------------------------- demo */
export async function seedDemo(db) {
  rnd = mulberry32(20260827);
  db.reset();

  /* business + branches */
  const business = db.collection('businesses').insert({
    id: uuid(), name: 'TX Demo', legalName: 'TX Demo Retail Ltd.',
    logoId: null, address: 'House 24, Road 11, Banani, Dhaka 1213',
    phone: '+880 1711 004488', email: 'hello@txdemo.shop', website: 'txdemo.shop',
    vatNo: 'BIN-000123456-0202', currency: 'BDT', currencySymbol: '৳',
  });
  const branchMain = db.collection('branches').insert({ id: uuid(), name: 'Banani Flagship', code: 'BAN', address: business.address, phone: business.phone, email: 'banani@txdemo.shop', isDefault: true, status: 'active' });
  const branchGulshan = db.collection('branches').insert({ id: uuid(), name: 'Gulshan Branch', code: 'GUL', address: 'Pink City, Gulshan 2, Dhaka', phone: '+880 1711 004499', email: 'gulshan@txdemo.shop', isDefault: false, status: 'active' });
  const branches = [branchMain, branchGulshan];

  /* roles */
  ROLE_PRESETS.forEach((r) => db.collection('roles').insert({ ...r }));
  const roleId = (name) => db.collection('roles').all().find((r) => r.name === name).id;

  /* users + employees
   * TX Demo ships with only the Branch Owner. Cashier / Manager / Inventory
   * Manager / Accountant roles all still exist in the system - add staff to
   * them any time from Merchant Admin -> Employees. */
  const pw = await hashPassword('demo1234');
  const staff = [
    { name: 'Afia Rahman', email: 'admin@txdemo.shop', role: 'Branch Owner', branches: [branchMain.id, branchGulshan.id], phone: '+8801711004488' },
  ];
  const users = staff.map((s) => {
    const u = db.collection('users').insert({
      id: uuid(), name: s.name, email: s.email, phone: s.phone, passwordHash: pw,
      roleId: roleId(s.role), status: 'active', permissionGrants: [], permissionRevokes: [],
      lastLoginAt: daysAgo(rint(0, 3)),
    });
    db.collection('employees').insert({ id: uuid(), userId: u.id, branchIds: s.branches, joinDate: daysAgo(rint(120, 600)), phone: s.phone });
    return { ...u, role: s.role };
  });
  const owner = users[0];
  // the owner runs both registers in this demo (a small shop where the owner is
  // behind the counter); real cashiers get added later from the Employees page
  const cashierMain = owner;
  const cashierGul = owner;

  /* taxes */
  const vat15 = db.collection('taxes').insert({ id: uuid(), name: 'VAT 15%', rate: 15, inclusive: false, scope: 'product', isDefault: true, status: 'active' });
  const vat7 = db.collection('taxes').insert({ id: uuid(), name: 'VAT 7.5% (reduced)', rate: 7.5, inclusive: false, scope: 'product', isDefault: false, status: 'active' });
  db.collection('taxes').insert({ id: uuid(), name: 'Zero-rated', rate: 0, inclusive: false, scope: 'product', isDefault: false, status: 'active' });
  const taxes = db.collection('taxes').all();

  /* categories + subcategories */
  const catDefs = [
    ['Skincare', ['Cleansers', 'Moisturisers', 'Serums', 'Sunscreen', 'Masks']],
    ['Makeup', ['Face', 'Eyes', 'Lips', 'Nails']],
    ['Haircare', ['Shampoo', 'Conditioner', 'Treatments', 'Styling']],
    ['Fragrance', ['Women', 'Men', 'Unisex']],
    ['Bath & Body', ['Body Wash', 'Lotion', 'Hand Care']],
    ['Tools & Accessories', ['Brushes', 'Sponges', 'Applicators']],
  ];
  const categories = {};
  catDefs.forEach(([name, subs], i) => {
    const parent = db.collection('categories').insert({ id: uuid(), name, parentId: null, imageId: null, description: '', order: i + 1, status: 'active' });
    categories[name] = { id: parent.id, subs: {} };
    subs.forEach((sub, j) => {
      const s = db.collection('categories').insert({ id: uuid(), name: sub, parentId: parent.id, imageId: null, description: '', order: j + 1, status: 'active' });
      categories[name].subs[sub] = s.id;
    });
  });

  /* brands */
  const brandNames = ["L'Oréal Paris", 'Nivea', 'Lakmé', 'The Body Shop', 'Garnier', 'Maybelline', 'Dove', 'Himalaya', 'Neutrogena', 'CeraVe', 'Simple', 'Sunsilk'];
  const brands = {};
  brandNames.forEach((n) => { brands[n] = db.collection('brands').insert({ id: uuid(), name: n, imageId: null, description: '', status: 'active' }).id; });

  /* suppliers */
  const supplierDefs = [
    ['Beautilux Distribution Ltd.', 'Rahim Uddin', '+8801713000111', 'sales@beautilux.com.bd'],
    ['Glow Trading International', 'Karen Lee', '+8801819222333', 'order@glowtrading.com'],
    ['Dhaka Cosmetics Wholesale', 'Mizanur Rahman', '+8801611444555', 'wholesale@dhakacosmetics.bd'],
    ['Prime Beauty Imports', 'Sadia Chowdhury', '+8801511666777', 'imports@primebeauty.bd'],
    ['Local Essentials Co.', 'Jahangir Alam', '+8801911888999', 'contact@localessentials.bd'],
  ];
  const suppliers = supplierDefs.map(([name, contact, phone, email]) =>
    db.collection('suppliers').insert({
      id: uuid(), name, contact, phone, email, company: name, address: 'Dhaka, Bangladesh',
      openingBalance: 0, currentBalance: 0, status: 'active', note: '',
    }),
  );

  /* customers */
  const custDefs = [
    ['Walk-in Regular', '01700000000'], ['Sharmin Akter', '01712345678'], ['Imran Kabir', '01812345678'],
    ['Rita Gomez', '01912345678'], ['Nabila Haque', '01612345678'], ['Tuhin Mahmud', '01511122233'],
    ['Priya Das', '01988877766'], ['Ayesha Siddiqua', '01744455566'], ['Kamrul Hasan', '01633322211'],
    ['Sumaiya Islam', '01855566677'], ['Rezaul Karim', '01977788899'], ['Farzana Yasmin', '01700998877'],
    ['Mahin Chowdhury', '01811224466'], ['Lamia Rahman', '01922446688'], ['Shuvo Roy', '01633557799'],
  ];
  const customers = custDefs.map(([name, phone], i) =>
    db.collection('customers').insert({
      id: uuid(), name, phone, email: '', address: '', district: 'Dhaka', upazila: '',
      openingBalance: 0, outstandingBalance: 0, totalOrders: 0, totalPurchases: 0,
      loyaltyPoints: rint(0, 200), note: '', status: 'active', lastPurchaseAt: null,
      createdAt: daysAgo(rint(20, 400)),
    }),
  );

  /* ---- products ---- */
  const productSpecs = [
    ['Hydrating Facial Cleanser 150ml', 'Skincare', 'Cleansers', 'CeraVe', 520, 720, 'ml', 3, null],
    ['Micellar Cleansing Water 400ml', 'Skincare', 'Cleansers', 'Garnier', 340, 480, 'ml', 3, null],
    ['Gentle Foaming Face Wash 100ml', 'Skincare', 'Cleansers', 'Simple', 260, 390, 'ml', 3, null],
    ['Oil-Free Moisturiser 50ml', 'Skincare', 'Moisturisers', 'Neutrogena', 610, 850, 'ml', 3, null],
    ['Soft Rich Nourishing Cream 100ml', 'Skincare', 'Moisturisers', 'Nivea', 380, 540, 'ml', 3, null],
    ['Vitamin C Brightening Serum 30ml', 'Skincare', 'Serums', "L'Oréal Paris", 780, 1150, 'ml', 3, null],
    ['Hyaluronic Acid Serum 30ml', 'Skincare', 'Serums', 'The Body Shop', 690, 990, 'ml', 3, null],
    ['Invisible Sunscreen SPF50 50ml', 'Skincare', 'Sunscreen', 'Neutrogena', 540, 780, 'ml', 4, null],
    ['Matte Sunscreen Gel SPF40 40ml', 'Skincare', 'Sunscreen', 'Lakmé', 460, 650, 'ml', 4, null],
    ['Sheet Mask Variety', 'Skincare', 'Masks', 'Garnier', 60, 110, 'pcs', 10, null],
    ['Clay Purifying Mask 100ml', 'Skincare', 'Masks', "L'Oréal Paris", 420, 610, 'ml', 3, null],
    ['Matte Liquid Foundation', 'Makeup', 'Face', 'Maybelline', 620, 940, 'pcs', 3, ['Shade', ['Ivory', 'Natural Beige', 'Sand', 'Caramel', 'Espresso']]],
    ['Compact Powder', 'Makeup', 'Face', 'Lakmé', 380, 560, 'pcs', 3, ['Shade', ['Shell', 'Pearl', 'Golden Medium', 'Honey']]],
    ['Concealer Stick', 'Makeup', 'Face', 'Maybelline', 340, 520, 'pcs', 3, ['Shade', ['Fair', 'Light', 'Medium', 'Deep']]],
    ['Blush Duo Palette', 'Makeup', 'Face', "L'Oréal Paris", 480, 720, 'pcs', 2, null],
    ['Volumising Mascara', 'Makeup', 'Eyes', 'Maybelline', 410, 620, 'pcs', 3, ['Colour', ['Black', 'Brown']]],
    ['Liquid Eyeliner Pen', 'Makeup', 'Eyes', "L'Oréal Paris", 300, 470, 'pcs', 3, null],
    ['Nude Eyeshadow Palette 12-shade', 'Makeup', 'Eyes', 'Lakmé', 720, 1080, 'pcs', 2, null],
    ['Kajal Eye Pencil', 'Makeup', 'Eyes', 'Himalaya', 120, 210, 'pcs', 5, null],
    ['Matte Lipstick', 'Makeup', 'Lips', 'Maybelline', 260, 420, 'pcs', 4, ['Shade', ['Red Rush', 'Nude Nuance', 'Pink Pose', 'Mauve Moment', 'Brick Beat', 'Coral Crave']]],
    ['Lip Gloss Shine', 'Makeup', 'Lips', "L'Oréal Paris", 280, 450, 'pcs', 3, ['Shade', ['Clear', 'Rose', 'Berry']]],
    ['Tinted Lip Balm', 'Makeup', 'Lips', 'Nivea', 140, 240, 'pcs', 5, null],
    ['Nail Polish Classic', 'Makeup', 'Nails', 'Lakmé', 130, 230, 'pcs', 6, ['Shade', ['Ruby', 'Blush', 'Nude', 'Wine', 'Coral', 'Silver']]],
    ['Anti-Dandruff Shampoo 340ml', 'Haircare', 'Shampoo', 'Dove', 340, 480, 'ml', 4, null],
    ['Keratin Smooth Shampoo 650ml', 'Haircare', 'Shampoo', 'Sunsilk', 420, 600, 'ml', 4, null],
    ['Daily Care Conditioner 340ml', 'Haircare', 'Conditioner', 'Dove', 360, 510, 'ml', 4, null],
    ['Argan Hair Oil 100ml', 'Haircare', 'Treatments', 'Garnier', 380, 560, 'ml', 3, null],
    ['Hair Repair Mask 300ml', 'Haircare', 'Treatments', 'The Body Shop', 560, 820, 'ml', 3, null],
    ['Heat Protectant Spray 200ml', 'Haircare', 'Styling', "L'Oréal Paris", 440, 640, 'ml', 3, null],
    ['Eau de Parfum - Blossom 50ml', 'Fragrance', 'Women', 'The Body Shop', 1650, 2400, 'ml', 2, null],
    ['Eau de Toilette - Aqua 100ml', 'Fragrance', 'Men', "L'Oréal Paris", 1450, 2100, 'ml', 2, null],
    ['Roll-on Deodorant 50ml', 'Fragrance', 'Unisex', 'Nivea', 150, 260, 'ml', 6, null],
    ['Body Wash Deep Moisture 500ml', 'Bath & Body', 'Body Wash', 'Dove', 320, 470, 'ml', 4, null],
    ['Body Lotion Cocoa Butter 400ml', 'Bath & Body', 'Lotion', 'Nivea', 300, 440, 'ml', 4, null],
    ['Hand Cream Shea 75ml', 'Bath & Body', 'Hand Care', 'The Body Shop', 240, 380, 'ml', 5, null],
    ['Makeup Brush Set 12-pcs', 'Tools & Accessories', 'Brushes', 'Lakmé', 480, 780, 'set', 2, null],
    ['Beauty Blender Sponge', 'Tools & Accessories', 'Sponges', 'Maybelline', 90, 170, 'pcs', 8, null],
    ['Dual-Ended Foundation Brush', 'Tools & Accessories', 'Brushes', 'The Body Shop', 220, 360, 'pcs', 4, null],
  ];

  const products = productSpecs.map(([name, cat, sub, brand, cost, price, unit, minStock, variantSpec]) => {
    const base = {
      id: uuid(), name, description: `${brand} ${name}. Genuine retail stock.`,
      imageId: null, categoryId: categories[cat].id, subcategoryId: categories[cat].subs[sub] || null,
      brandId: brands[brand], supplierId: pick(suppliers).id, unit,
      costPrice: bdt(cost), sellingPrice: bdt(price),
      mrp: bdt(Math.round(price * (1.06 + rnd() * 0.12))), // MRP a touch above the selling price
      wholesalePrice: bdt(Math.round(price * 0.85)), discountPrice: rnd() < 0.15 ? bdt(Math.round(price * 0.9)) : null,
      attributes: {},
      taxId: cat === 'Fragrance' ? vat15.id : (rnd() < 0.3 ? vat7.id : vat15.id),
      minStock, maxStock: minStock * 12, trackInventory: true,
      status: 'active', tags: [cat.toLowerCase()], createdAt: daysAgo(rint(60, 400)),
      hasVariants: !!variantSpec, variants: [],
    };
    base.sku = suggestSku(name, [brand.split(' ')[0]]);
    base.barcode = generateEan13(parseInt(base.id.replace(/\D/g, '').slice(0, 8) || '1', 16));
    if (variantSpec) {
      const [optName, values] = variantSpec;
      base.variants = values.map((val) => ({
        id: uuid(), name: val, options: { [optName]: val },
        sku: `${base.sku}-${val.replace(/\s+/g, '').slice(0, 4).toUpperCase()}`,
        barcode: generateEan13(rint(1, 9e8)),
        costPrice: base.costPrice, sellingPrice: base.sellingPrice, wholesalePrice: base.wholesalePrice,
        minStock, imageId: null, openingStock: 0,
      }));
    }
    return db.collection('products').insert(base);
  });

  /* ---- ledger poster (timestamp-aware) ---- */
  function post(branchId, productId, variantId, type, qtyDelta, unitCost, refType, refId, at, note = '') {
    const sid = `stk_${branchId}_${productId}_${variantId || 'base'}`;
    let row = db.collection('stock').get(sid);
    const prev = row?.quantity || 0;
    const next = prev + qtyDelta;
    let avgCost = row?.avgCost || 0;
    if (qtyDelta > 0 && unitCost > 0) {
      avgCost = next > 0 ? Math.round((avgCost * prev + unitCost * qtyDelta) / next) : unitCost;
    }
    db.collection('inventory_transactions').insert({
      id: uuid(), branchId, productId, variantId: variantId || null, type,
      qtyDelta, balanceAfter: next, unitCost, refType, refId, note,
      userId: owner.id, userName: owner.name, at,
    });
    if (row) db.collection('stock').update(sid, { quantity: next, avgCost, lastMovementAt: at });
    else db.collection('stock').insert({ id: sid, branchId, productId, variantId: variantId || null, quantity: next, reserved: 0, avgCost, lastMovementAt: at });
    return next;
  }

  /* ---- opening stock (45 days ago) for every product at every branch ---- */
  const openAt = daysAgo(45, 0);
  for (const p of products) {
    for (const b of branches) {
      if (p.variants.length) {
        for (const v of p.variants) {
          post(b.id, p.id, v.id, 'opening', rint(12, 40), p.costPrice, 'product', p.id, openAt, 'Opening stock');
        }
      } else {
        post(b.id, p.id, null, 'opening', rint(40, 160), p.costPrice, 'product', p.id, openAt, 'Opening stock');
      }
    }
  }

  /* ---- purchases (received) ---- */
  let poSeq = 0;
  for (let i = 0; i < 9; i++) {
    const supplier = pick(suppliers);
    const branch = pick(branches);
    const at = daysAgo(rint(3, 40));
    const lineProducts = Array.from({ length: rint(3, 7) }, () => pick(products));
    const lines = [...new Set(lineProducts)].map((p) => {
      const qty = rint(10, 40);
      return { id: uuid(), productId: p.id, variantId: p.variants[0]?.id || null, name: p.name, qty, unitCost: p.costPrice, discountType: null, discountValue: 0, taxRate: 0, receivedQty: qty, returnedQty: 0, lineTotal: p.costPrice * qty, gross: p.costPrice * qty, discount: 0, tax: 0 };
    });
    const subtotal = lines.reduce((s, l) => s + l.gross, 0);
    const ref = `PO-${new Date(at).toISOString().slice(2, 7).replace('-', '')}-${String(++poSeq).padStart(4, '0')}`;
    const paid = rnd() < 0.6 ? subtotal : Math.round(subtotal * 0.5);
    const po = db.collection('purchases').insert({
      id: uuid(), reference: ref, branchId: branch.id, supplierId: supplier.id, invoiceRef: `SINV-${rint(1000, 9999)}`,
      note: '', lines, subtotal, discountTotal: 0, taxTotal: 0, grandTotal: subtotal,
      paidTotal: paid, dueTotal: subtotal - paid, status: 'received', expectedAt: at, createdAt: at, receivedAt: at,
    });
    db.collection('suppliers').update(supplier.id, (s) => ({ currentBalance: (s.currentBalance || 0) + (subtotal - paid) }));
    lines.forEach((l) => post(branch.id, l.productId, l.variantId, 'purchase', l.qty, l.unitCost, 'purchase', po.id, at, `PO ${ref}`));
    db.collection('audit_logs').insert({ id: uuid(), action: 'receive', entity: 'purchase', entityId: po.id, actorId: owner.id, actorName: owner.name, before: null, after: null, meta: { reference: ref }, at });
  }

  /* db.seq counters must not collide with the seeded references */
  db.meta.sequences['purchase'] = poSeq;

  /* ---- register sessions ---- */
  const closedSession = db.collection('register_sessions').insert({
    id: uuid(), reference: 'REG-BAN-0001', branchId: branchMain.id, branchName: branchMain.name,
    cashierId: cashierMain.id, cashierName: cashierMain.name, openingCash: bdt(3000), openingNote: 'Morning float',
    status: 'closed', openedAt: daysAgo(1, 0), closedAt: daysAgo(1, 0).replace('T09', 'T21'),
    closingCountedCash: bdt(18450), closingExpectedCash: bdt(18450), difference: 0, closingNote: 'Balanced',
  });
  const openMain = db.collection('register_sessions').insert({
    id: uuid(), reference: 'REG-BAN-0002', branchId: branchMain.id, branchName: branchMain.name,
    cashierId: cashierMain.id, cashierName: cashierMain.name, openingCash: bdt(3000), openingNote: 'Morning float',
    status: 'open', openedAt: daysAgo(0, 0).replace(/T\d\d/, 'T09'), closedAt: null,
    closingCountedCash: null, closingExpectedCash: null, difference: null, closingNote: '',
  });
  const openGul = db.collection('register_sessions').insert({
    id: uuid(), reference: 'REG-GUL-0001', branchId: branchGulshan.id, branchName: branchGulshan.name,
    cashierId: cashierGul.id, cashierName: cashierGul.name, openingCash: bdt(2500), openingNote: '',
    status: 'open', openedAt: daysAgo(0, 0).replace(/T\d\d/, 'T10'), closedAt: null,
    closingCountedCash: null, closingExpectedCash: null, difference: null, closingNote: '',
  });
  db.meta.sequences['register:' + branchMain.id] = 2;
  db.meta.sequences['register:' + branchGulshan.id] = 1;

  /* ---- historical sales ---- */
  const activeTaxes = taxes;
  let invSeqByBranch = { [branchMain.id]: 0, [branchGulshan.id]: 0 };
  const paymentMethods = ['cash', 'cash', 'cash', 'card', 'mobile', 'mobile', 'bank_transfer'];
  const mobileProviders = ['bkash', 'bkash', 'nagad', 'nagad', 'rocket', 'other'];

  function makeSale(dayOffset, branch, cashier, sessionId) {
    const at = daysAgo(dayOffset);
    const chosen = [];
    const n = rint(1, 4);
    for (let i = 0; i < n; i++) {
      const p = pick(products);
      const variant = p.variants.length ? pick(p.variants) : null;
      const sid = `stk_${branch.id}_${p.id}_${variant?.id || 'base'}`;
      const avail = db.collection('stock').get(sid)?.quantity || 0;
      if (avail < 2) continue;
      const qty = Math.min(rint(1, 3), avail - 1);
      chosen.push({
        productId: p.id, variantId: variant?.id || null, name: p.name, sku: variant?.sku || p.sku,
        barcode: variant?.barcode || p.barcode, unit: p.unit,
        unitPrice: p.discountPrice ?? p.sellingPrice, costPrice: p.costPrice, qty,
        discountType: rnd() < 0.12 ? 'percent' : null, discountValue: rnd() < 0.12 ? pick([5, 10]) : 0,
        taxId: p.taxId,
      });
    }
    if (!chosen.length) return;

    const cartDisc = rnd() < 0.1 ? { cartDiscountType: 'percent', cartDiscountValue: 5 } : {};
    const calc = computeCart(chosen, { ...cartDisc, taxes: activeTaxes });
    const customer = rnd() < 0.55 ? pick(customers) : null;
    const method = pick(paymentMethods);
    const seq = ++invSeqByBranch[branch.id];
    const invoiceNo = `AFIA-${branch.code}-${String(seq).padStart(5, '0')}`;

    let paid = calc.grandTotal;
    let change = 0;
    const payments = [];
    if (method === 'cash') {
      const tender = Math.ceil(calc.grandTotal / bdt(100)) * bdt(100) + (rnd() < 0.3 ? bdt(100) : 0);
      paid = tender;
      change = tender - calc.grandTotal;
      payments.push({ method: 'cash', amount: tender });
    } else {
      const provider = method === 'mobile' ? pick(mobileProviders) : null;
      payments.push({ method, provider, amount: calc.grandTotal, reference: (provider || method).toUpperCase() + rint(100000, 999999) });
    }

    const sale = db.collection('sales').insert({
      id: uuid(), invoiceNo, idempotencyKey: uuid(), branchId: branch.id, branchName: branch.name,
      registerSessionId: sessionId, cashierId: cashier.id, cashierName: cashier.name,
      customerId: customer?.id || null, customerName: customer?.name || 'Walk-in Customer', customerPhone: customer?.phone || null,
      note: '', status: 'completed',
      subtotal: calc.subtotal, itemDiscountTotal: calc.itemDiscountTotal, cartDiscount: calc.cartDiscount,
      cartDiscountType: calc.cartDiscountType, cartDiscountValue: calc.cartDiscountValue, discountTotal: calc.discountTotal,
      taxTotal: calc.taxTotal, taxLines: calc.taxLines, grandTotal: calc.grandTotal, totalQty: calc.totalQty,
      totalCost: calc.totalCost, estimatedProfit: calc.estimatedProfit,
      paidTotal: paid, changeTotal: change, dueTotal: 0, paymentSummary: payments.map((p) => p.method).join('+'),
      createdAt: at,
    });
    calc.items.forEach((it, idx) => {
      const src = chosen[idx];
      db.collection('sale_items').insert({
        id: uuid(), saleId: sale.id, branchId: branch.id, lineNo: idx + 1,
        productId: it.productId, variantId: it.variantId, name: src.name, variantLabel: null, sku: src.sku, barcode: src.barcode,
        unit: src.unit, unitPrice: it.unitPrice, costPrice: it.costPrice, qty: it.qty,
        lineDiscount: it.lineDiscount, cartDiscountShare: it.cartDiscountShare, discountTotal: it.discountTotal,
        taxId: it.taxId, taxRate: it.taxRate, taxAmount: it.taxAmount, taxableAmount: it.taxableAmount,
        lineTotal: it.lineTotal, returnedQty: 0,
      });
      post(branch.id, it.productId, it.variantId, 'sale', -it.qty, it.costPrice, 'sale', sale.id, at, `Invoice ${invoiceNo}`);
    });
    payments.forEach((p) => db.collection('payments').insert({
      id: uuid(), saleId: sale.id, branchId: branch.id, registerSessionId: sessionId, direction: 'in',
      method: p.method, provider: p.provider || null, amount: p.amount, reference: p.reference || null, cardLast4: p.method === 'card' ? String(rint(1000, 9999)) : null, note: null, at,
    }));
    if (customer) {
      db.collection('customers').update(customer.id, (c) => ({
        totalOrders: (c.totalOrders || 0) + 1, totalPurchases: (c.totalPurchases || 0) + calc.grandTotal,
        loyaltyPoints: (c.loyaltyPoints || 0) + Math.floor(calc.grandTotal / bdt(100)), lastPurchaseAt: at,
      }));
    }
    return sale;
  }

  // spread ~95 sales across the last 30 days
  for (let d = 30; d >= 0; d--) {
    const count = d === 0 ? rint(3, 6) : rint(2, 5);
    for (let k = 0; k < count; k++) {
      const useGulshan = rnd() < 0.4;
      makeSale(
        d,
        useGulshan ? branchGulshan : branchMain,
        useGulshan ? cashierGul : cashierMain,
        d === 0 ? (useGulshan ? openGul.id : openMain.id) : (d === 1 && !useGulshan ? closedSession.id : null),
      );
    }
  }
  db.meta.sequences['invoice:' + branchMain.id] = invSeqByBranch[branchMain.id];
  db.meta.sequences['invoice:' + branchGulshan.id] = invSeqByBranch[branchGulshan.id];

  /* ---- a couple of sale returns ---- */
  const recentSales = db.collection('sales').all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12);
  let retSeq = 0;
  for (const sale of recentSales.slice(0, 2)) {
    const items = db.collection('sale_items').find({ saleId: sale.id });
    const item = items[0];
    const qty = 1;
    const perUnitNet = Math.round((item.lineTotal - item.taxAmount) / item.qty);
    const perUnitTax = Math.round(item.taxAmount / item.qty);
    const at = daysAgo(rint(0, 2));
    const ref = `RET-${db.collection('branches').get(sale.branchId).code}-${String(++retSeq).padStart(4, '0')}`;
    const doc = db.collection('sale_returns').insert({
      id: uuid(), reference: ref, saleId: sale.id, invoiceNo: sale.invoiceNo, branchId: sale.branchId,
      customerId: sale.customerId, cashierId: sale.cashierId, cashierName: sale.cashierName,
      reason: 'customer_request', note: 'Wrong shade', items: [{ saleItemId: item.id, productId: item.productId, variantId: item.variantId, name: item.name, qty, restock: true, refund: perUnitNet + perUnitTax }],
      refundGoods: perUnitNet, refundTax: perUnitTax, refundTotal: perUnitNet + perUnitTax, refundMethod: 'cash', at,
    });
    db.collection('sale_items').update(item.id, { returnedQty: qty });
    db.collection('sales').update(sale.id, { status: 'partially_refunded' });
    post(sale.branchId, item.productId, item.variantId, 'sale_return', qty, item.costPrice, 'sale_return', ref, at, `Return of ${sale.invoiceNo}`);
    db.collection('payments').insert({ id: uuid(), saleId: sale.id, saleReturnId: doc.id, branchId: sale.branchId, direction: 'out', method: 'cash', amount: perUnitNet + perUnitTax, reference: ref, note: `Refund for ${sale.invoiceNo}`, at });
  }
  db.meta.sequences['sale_return:' + branchMain.id] = retSeq;
  db.meta.sequences['sale_return:' + branchGulshan.id] = retSeq;

  /* ---- expenses ---- */
  const expenseDefs = [
    ['Rent', 'Banani showroom monthly rent', 8500000], ['Electricity', 'DESCO bill - March', 1240000],
    ['Internet', 'Broadband + POS line', 350000], ['Salary', 'Staff salary top-up', 4500000],
    ['Transport', 'Stock delivery van fuel', 620000], ['Marketing', 'Facebook & Instagram ads', 1500000],
    ['Maintenance', 'AC servicing', 450000], ['Supplies', 'Carry bags & tissue', 280000],
    ['Marketing', 'Influencer collaboration', 2500000], ['Transport', 'Courier charges', 340000],
    ['Other', 'Miscellaneous petty cash', 190000], ['Electricity', 'Gulshan branch bill', 980000],
  ];
  let expSeq = 0;
  expenseDefs.forEach(([category, description, amount]) => {
    const branch = pick(branches);
    db.collection('expenses').insert({
      id: uuid(), reference: `EXP-${new Date().toISOString().slice(2, 7).replace('-', '')}-${String(++expSeq).padStart(4, '0')}`,
      category, description, amount, paymentMethod: pick(['cash', 'cash', 'bank_transfer']),
      branchId: branch.id, employeeId: owner.id, employeeName: owner.name, note: '', attachmentRef: null,
      registerSessionId: null, at: daysAgo(rint(0, 28)),
    });
  });
  db.meta.sequences['expense'] = expSeq;

  /* ---- discounts ---- */
  db.collection('discounts').insert({ id: uuid(), name: 'Eid Special 10%', code: 'EID10', type: 'percent', value: 10, scope: 'cart', appliesTo: [], minSpend: bdt(1000), maxDiscount: bdt(500), customerId: null, startsAt: null, endsAt: null, usageLimit: 0, usageCount: 0, status: 'active' });
  db.collection('discounts').insert({ id: uuid(), name: 'New Customer ৳100 Off', code: 'WELCOME100', type: 'fixed', value: 100, scope: 'cart', appliesTo: [], minSpend: bdt(500), maxDiscount: 0, customerId: null, startsAt: null, endsAt: null, usageLimit: 100, usageCount: 7, status: 'active' });
  db.collection('discounts').insert({ id: uuid(), name: 'Clearance - Skincare 15%', code: null, type: 'percent', value: 15, scope: 'category', appliesTo: [categories['Skincare'].id], minSpend: 0, maxDiscount: 0, customerId: null, startsAt: null, endsAt: null, usageLimit: 0, usageCount: 0, status: 'active' });

  /* ---- settings ---- */
  const settings = db.collection('settings').insert(defaultSettings(business, { invoicePrefix: 'TXD' }));
  // a real shop configures a default sales tax (leaves the customer blank for
  // anonymous walk-ins)
  db.collection('settings').update(settings.id, { pos: { ...settings.pos, defaultTaxId: vat15.id } });

  /* ---- notifications (derived from current state) ---- */
  refreshStockNotifications(db);
  db.collection('notifications').insert({ id: uuid(), type: 'system', title: 'Welcome to TX Demo POS', message: 'Demo data is loaded. Reset any time from Settings → Backup / Data Management.', level: 'info', read: false, link: '#/help', meta: {}, at: daysAgo(0) });

  await activateMultiTenant(db, business, { demo: true });
  db.meta.seededAt = new Date().toISOString();
  db.flush();

  return {
    ownerEmail: owner.email,
    accounts: users.map((u) => ({ name: u.name, email: u.email, role: u.role, password: 'demo1234' })),
  };
}

/* --------------------------------------------------------------- shared */
export function refreshStockNotifications(db) {
  const branches = db.collection('branches').all();
  for (const b of branches) {
    for (const p of db.collection('products').all()) {
      if (p.archivedAt || p.trackInventory === false) continue;
      const targets = p.variants?.length ? p.variants.map((v) => ({ id: v.id, min: v.minStock ?? p.minStock, label: v.name })) : [{ id: 'base', min: p.minStock, label: null }];
      for (const t of targets) {
        const qty = db.collection('stock').get(`stk_${b.id}_${p.id}_${t.id}`)?.quantity || 0;
        const dupeKey = `thr_stk_${b.id}_${p.id}_${t.id}`;
        if (db.collection('notifications').exists((n) => n.meta?.dupeKey === dupeKey)) continue;
        const label = p.name + (t.label ? ` (${t.label})` : '') + ` @ ${b.name}`;
        if (qty <= 0) {
          db.collection('notifications').insert({ id: uuid(), type: 'out_of_stock', title: 'Out of stock', message: `${label} is out of stock.`, level: 'danger', read: false, link: `#/inventory?product=${p.id}`, meta: { dupeKey, productId: p.id, branchId: b.id }, at: new Date().toISOString() });
        } else if (t.min > 0 && qty <= t.min) {
          db.collection('notifications').insert({ id: uuid(), type: 'low_stock', title: 'Low stock warning', message: `${label} is low (${qty} left, min ${t.min}).`, level: 'warning', read: false, link: `#/inventory?product=${p.id}`, meta: { dupeKey, productId: p.id, branchId: b.id }, at: new Date().toISOString() });
        }
      }
    }
  }
}

/** Uppercase word-initials of a business name, e.g. "TX Demo" -> "TXD". */
function nameInitials(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean)
    .map((w) => w[0].toUpperCase()).join('').slice(0, 4);
  return s || 'INV';
}

function defaultSettings(business, { invoicePrefix } = {}) {
  const prefix = invoicePrefix || nameInitials(business.name);
  return {
    id: 'settings_singleton',
    business: {
      name: business.name, legalName: business.legalName, logoId: null,
      address: business.address, phone: business.phone, email: business.email,
      website: business.website, vatNo: business.vatNo,
      currency: 'BDT', currencySymbol: '৳', invoicePrefix: prefix,
    },
    pos: {
      invoiceTemplate: `${prefix}-{BR}-{SEQ}`, receiptSize: '80', printAfterSale: true,
      autoFocusBarcode: true, holdSaleLimit: 20, requireOpenRegister: true,
      defaultTaxId: null, defaultCustomerId: null, loyaltyPerCurrency: 0.01,
      quickCash: [50, 100, 200, 500, 1000], allowPriceOverride: true, roundTotalsTo: 0,
      showProductImages: true,
    },
    inventory: {
      allowNegativeStock: false, lowStockThreshold: 5, valuationMethod: 'moving_average',
      autoReorderAlerts: true,
    },
    receipt: {
      header: business.name, footer: 'Thank you for shopping with us!\nExchange within 7 days with receipt.',
      showLogo: true, showCashier: true, showBarcode: true, showTaxBreakdown: true,
    },
    notifications: { lowStock: true, newSale: false, refund: true, registerClose: true, purchaseReceived: true },
    security: { sessionIdleTimeoutMin: 30, requirePinForRefund: false, requirePinForDiscount: false },
    printing: { paperSize: '80', marginMm: 4, copies: 1 },
    print: structuredClone(DEFAULT_PRINT),
  };
}
