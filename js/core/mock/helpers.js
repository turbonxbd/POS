/**
 * mock/helpers.js - shared domain logic for the mock backend:
 *  - audit log writing (append-only, tenant-stamped)
 *  - notification creation (tenant-scoped)
 *  - the inventory ledger (post movements, read cached balance) - tenant-scoped
 *  - money math for a cart (line + cart discount, inclusive/exclusive tax)
 *  - branch resolution & per-merchant settings access
 *
 * Tenant-owned reads/writes go through tdb() (mock/scope.js) so the merchant id
 * is always derived from the authenticated actor, never from client input.
 * These functions assume they run INSIDE db.tx() for any mutation path.
 */

import db from '../db.js';
import { now } from '../../utils/date.js';
import { uuid } from '../../utils/id.js';
import money from '../../utils/money.js';
import { getActor, getActiveBranch } from './context.js';
import { conflict, notFound } from './router.js';
import { tdb, currentMerchantId } from './scope.js';

/* ------------------------------------------------------------------ misc */

export function actorStamp() {
  const a = getActor();
  return a ? { userId: a.id, userName: a.name } : { userId: null, userName: 'system' };
}

export function getSettings() {
  const mid = currentMerchantId();
  const doc = mid ? db.collection('settings').get('settings_' + mid) : null;
  return doc || db.collection('settings').get('settings_singleton') || {};
}

export function resolveBranchId(explicit) {
  if (explicit) return explicit;
  const active = getActiveBranch();
  if (active && tdb('branches').get(active)) return active;
  const a = getActor();
  if (a?.branchIds?.length) {
    const owned = a.branchIds.find((b) => tdb('branches').get(b));
    if (owned) return owned;
  }
  const first = tdb('branches').findOne((b) => !b.archivedAt);
  return first?.id || null;
}

export function requireBranch(explicit) {
  const id = resolveBranchId(explicit);
  if (!id) notFound('Branch');
  const branch = tdb('branches').get(id);
  if (!branch) notFound('Branch');
  return branch;
}

/* --------------------------------------------------------------- audit */

export function audit(action, entity, entityId, { before = null, after = null, meta = {} } = {}) {
  const stamp = actorStamp();
  return db.collection('audit_logs').insert({
    id: uuid(),
    merchantId: currentMerchantId() || getActor()?.merchantId || null,
    action, // create | update | archive | delete | login | logout | sale | refund | receive | adjust | settings
    entity,
    entityId: entityId || null,
    actorId: stamp.userId,
    actorName: stamp.userName,
    actorPlatform: !!getActor()?.platform,
    before,
    after,
    meta: {
      device: typeof navigator !== 'undefined' ? navigator.userAgent : 'server',
      ip: 'client', // real IP is captured server-side in production
      branchId: getActiveBranch(),
      ...meta,
    },
    at: now(),
  });
}

/* -------------------------------------------------------- notifications */

export function notify(type, title, message, { level = 'info', link = null, meta = {} } = {}) {
  return tdb('notifications').insert({
    id: uuid(),
    type, // low_stock | out_of_stock | sale | refund | purchase_received | register_close | system | announcement
    title,
    message,
    level, // info | success | warning | danger
    link,
    read: false,
    meta,
    at: now(),
  });
}

/* ================================================================ STOCK */

export function stockId(branchId, productId, variantId) {
  return `stk_${branchId}_${productId}_${variantId || 'base'}`;
}

export function getStockRow(branchId, productId, variantId = null) {
  return tdb('stock').get(stockId(branchId, productId, variantId));
}

export function getStockQty(branchId, productId, variantId = null) {
  return getStockRow(branchId, productId, variantId)?.quantity || 0;
}

/**
 * Post an inventory movement. Writes ONE immutable ledger row and updates the
 * cached stock balance atomically. `qtyDelta` is signed (negative = decrease).
 * Returns { ledger, balanceAfter }.
 */
export function postInventory({
  branchId,
  productId,
  variantId = null,
  type, // opening | purchase | sale | sale_return | purchase_return | adjustment | damage | lost | transfer_in | transfer_out
  qtyDelta,
  unitCost = 0,
  refType = null,
  refId = null,
  note = '',
  allowNegative = false,
}) {
  const delta = Number(qtyDelta);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('postInventory: qtyDelta must be a non-zero number');
  }
  const id = stockId(branchId, productId, variantId);
  let row = tdb('stock').get(id);
  const prevQty = row?.quantity || 0;
  const nextQty = prevQty + delta;

  if (nextQty < 0 && !allowNegative) {
    conflict(
      `Insufficient stock. Available ${prevQty}, requested ${Math.abs(delta)}.`,
    );
  }

  // Moving-average cost on inbound movements
  let avgCost = row?.avgCost || 0;
  if (delta > 0 && unitCost > 0) {
    const totalValue = money.add(money.mul(avgCost, prevQty), money.mul(unitCost, delta));
    avgCost = nextQty > 0 ? Math.round(totalValue / nextQty) : unitCost;
  }

  const stamp = actorStamp();
  const ledger = tdb('inventory_transactions').insert({
    id: uuid(),
    branchId,
    productId,
    variantId,
    type,
    qtyDelta: delta,
    balanceAfter: nextQty,
    unitCost,
    refType,
    refId,
    note,
    userId: stamp.userId,
    userName: stamp.userName,
    at: now(),
  });

  if (row) {
    tdb('stock').update(id, { quantity: nextQty, avgCost, lastMovementAt: now() });
  } else {
    tdb('stock').insert({
      id,
      branchId,
      productId,
      variantId,
      quantity: nextQty,
      reserved: 0,
      avgCost,
      lastMovementAt: now(),
    });
  }

  checkStockThresholds(branchId, productId, variantId, nextQty);
  return { ledger, balanceAfter: nextQty };
}

function checkStockThresholds(branchId, productId, variantId, qty) {
  const product = tdb('products').get(productId);
  if (!product) return;
  const min = variantId
    ? product.variants?.find((v) => v.id === variantId)?.minStock ?? product.minStock
    : product.minStock;
  const minLevel = Number(min) || 0;
  const label = product.name + (variantId ? ` (${variantName(product, variantId)})` : '');
  const branch = tdb('branches').get(branchId);
  const bn = branch ? ` @ ${branch.name}` : '';
  const dupeKey = `thr_${stockId(branchId, productId, variantId)}`;

  if (qty <= 0) {
    if (!recentNotif('out_of_stock', dupeKey)) {
      notify('out_of_stock', 'Out of stock', `${label}${bn} is now out of stock.`, {
        level: 'danger',
        link: `#/inventory?product=${productId}`,
        meta: { dupeKey, productId, branchId },
      });
    }
  } else if (minLevel > 0 && qty <= minLevel) {
    if (!recentNotif('low_stock', dupeKey)) {
      notify('low_stock', 'Low stock warning', `${label}${bn} dropped to ${qty} (min ${minLevel}).`, {
        level: 'warning',
        link: `#/inventory?product=${productId}`,
        meta: { dupeKey, productId, branchId },
      });
    }
  }
}

function recentNotif(type, dupeKey) {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h dedupe window
  return (
    tdb('notifications').find(
      (n) => n.type === type && n.meta?.dupeKey === dupeKey && new Date(n.at).getTime() > cutoff,
    ).length > 0
  );
}

export function variantName(product, variantId) {
  const v = product.variants?.find((x) => x.id === variantId);
  if (!v) return '';
  return v.name || (v.options ? Object.values(v.options).join(' / ') : v.sku);
}

/* ================================================= CART / MONEY MATH */

/**
 * A discount rule -> the money it takes off `base` (minor units).
 * rule: { type:'percent'|'fixed', value, minSpend?, maxDiscount?, code?, name? }
 */
export function discountRuleAmount(rule, base) {
  if (!rule) return 0;
  if (rule.minSpend && base < rule.minSpend) return 0;
  let amt = rule.type === 'percent' ? money.percent(base, rule.value || 0) : money.toMinor(rule.value || 0);
  if (rule.maxDiscount) amt = Math.min(amt, rule.maxDiscount);
  return Math.max(0, Math.trunc(amt));
}

/**
 * Does a cart line fall inside a discount rule's scope?
 *   scope 'cart' / unset / empty appliesTo -> every line
 *   scope 'product'  -> line.productId is in rule.appliesTo
 *   scope 'category' -> line.categoryId is in rule.appliesTo
 */
export function lineMatchesRule(rule, line) {
  const sc = rule?.scope;
  if (!sc || sc === 'cart') return true;
  const list = rule.appliesTo || [];
  if (!list.length) return true;
  if (sc === 'product') return list.includes(line.productId);
  if (sc === 'category') return line.categoryId != null && list.includes(line.categoryId);
  return true;
}

/**
 * computeCart(lines, opts) -> full monetary breakdown.
 * line: { productId, variantId?, name, sku, unitPrice(minor), qty,
 *         discountType?('percent'|'fixed'), discountValue?, taxId?, costPrice?(minor) }
 * opts: { cartDiscountType, cartDiscountValue, taxes: [{id,rate,inclusive}],
 *         autoDiscounts: [rule], coupon: rule|null }
 * Cart-level reductions stack in this order (each clamped to what is left):
 *   manual cart discount -> best automatic discount -> coupon.
 */
export function computeCart(lines, opts = {}) {
  const taxMap = new Map((opts.taxes || []).map((t) => [t.id, t]));
  const rounded = [];

  // Pass 1: line subtotals & line discounts
  for (const line of lines) {
    const qty = Number(line.qty) || 0;
    const gross = money.mul(line.unitPrice, qty);
    let lineDiscount = 0;
    if (line.discountType === 'percent') lineDiscount = money.percent(gross, line.discountValue || 0);
    else if (line.discountType === 'fixed') lineDiscount = money.mul(line.discountValue || 0, qty); // fixed per unit
    lineDiscount = Math.min(lineDiscount, gross);
    rounded.push({ ...line, qty, gross, lineDiscount, netAfterLineDiscount: gross - lineDiscount });
  }

  // Pass 2: cart-level discounts. Order: manual cart discount -> best automatic
  // discount -> coupon, each clamped to what is left. A discount whose scope is a
  // product / category only draws from (and is distributed across) the lines it
  // covers; "minimum spend" is always measured against the whole cart.
  const netByLine = rounded.map((l) => l.netAfterLineDiscount);
  const netSum = netByLine.reduce((s, n) => s + n, 0);
  const ruleAmountOn = (rule, base) => {
    let a = rule.type === 'percent' ? money.percent(base, rule.value || 0) : money.toMinor(rule.value || 0);
    if (rule.maxDiscount) a = Math.min(a, rule.maxDiscount);
    return Math.max(0, Math.trunc(a));
  };
  const scopedIdx = (rule) => rounded.map((l, i) => (lineMatchesRule(rule, l) ? i : -1)).filter((i) => i >= 0);

  let manualCartDiscount = 0;
  if (opts.cartDiscountType === 'percent') manualCartDiscount = money.percent(netSum, opts.cartDiscountValue || 0);
  else if (opts.cartDiscountType === 'fixed') manualCartDiscount = money.toMinor(opts.cartDiscountValue || 0);
  manualCartDiscount = Math.min(Math.max(0, manualCartDiscount), netSum);

  const cartDiscountPerLine = money.distribute(manualCartDiscount, netByLine);
  const remainingByLine = netByLine.map((n, i) => n - cartDiscountPerLine[i]);
  const applyScoped = (idx, amount) => {
    const shares = money.distribute(amount, idx.map((i) => remainingByLine[i]));
    idx.forEach((li, k) => { cartDiscountPerLine[li] += shares[k]; remainingByLine[li] -= shares[k]; });
  };

  // percentage base = the scoped lines' net BEFORE the manual cart discount (so a
  // cart-scope rule still measures against the full cart); clamp = what is left.
  let autoDiscount = 0;
  let autoDiscountName = null;
  let autoIdx = null;
  for (const rule of opts.autoDiscounts || []) {
    if (rule.minSpend && netSum < rule.minSpend) continue;
    const idx = scopedIdx(rule);
    const base = idx.reduce((s, i) => s + netByLine[i], 0);
    const pool = idx.reduce((s, i) => s + remainingByLine[i], 0);
    if (pool <= 0) continue;
    const amt = Math.min(ruleAmountOn(rule, base), pool);
    if (amt > autoDiscount) { autoDiscount = amt; autoDiscountName = rule.name || 'Automatic discount'; autoIdx = idx; }
  }
  if (autoIdx) applyScoped(autoIdx, autoDiscount);

  let couponDiscount = 0;
  let couponCode = null;
  if (opts.coupon && !(opts.coupon.minSpend && netSum < opts.coupon.minSpend)) {
    const idx = scopedIdx(opts.coupon);
    const base = idx.reduce((s, i) => s + netByLine[i], 0);
    const pool = idx.reduce((s, i) => s + remainingByLine[i], 0);
    if (idx.length && pool > 0) {
      const amt = Math.min(ruleAmountOn(opts.coupon, base), pool);
      if (amt > 0) { couponDiscount = amt; couponCode = opts.coupon.code || null; applyScoped(idx, amt); }
    }
  }

  const cartDiscount = manualCartDiscount + autoDiscount + couponDiscount;
  const cartShares = cartDiscountPerLine;

  // Pass 3: tax per line
  let subtotal = 0;
  let itemDiscountTotal = 0;
  let taxTotal = 0;
  const taxBreakdown = new Map();

  const items = rounded.map((l, i) => {
    const cartShare = cartShares[i] || 0;
    const taxable = Math.max(0, l.netAfterLineDiscount - cartShare);
    const tax = taxMap.get(l.taxId);
    let taxAmount = 0;
    let taxRate = 0;
    if (tax && tax.rate) {
      taxRate = tax.rate;
      if (tax.inclusive) {
        // price already contains tax: extract it
        taxAmount = taxable - Math.round((taxable * 100) / (100 + tax.rate));
      } else {
        taxAmount = money.percent(taxable, tax.rate);
      }
    }
    subtotal += l.gross;
    itemDiscountTotal += l.lineDiscount;
    taxTotal += taxAmount;
    if (tax) {
      const acc = taxBreakdown.get(tax.id) || { taxId: tax.id, name: tax.name, rate: tax.rate, amount: 0, base: 0 };
      acc.amount += taxAmount;
      acc.base += taxable;
      taxBreakdown.set(tax.id, acc);
    }

    const lineTotal = tax && tax.inclusive ? taxable : taxable + taxAmount;
    return {
      productId: l.productId,
      variantId: l.variantId || null,
      name: l.name,
      sku: l.sku,
      unitPrice: l.unitPrice,
      costPrice: l.costPrice || 0,
      qty: l.qty,
      grossAmount: l.gross,
      lineDiscount: l.lineDiscount,
      cartDiscountShare: cartShare,
      discountTotal: l.lineDiscount + cartShare,
      taxId: l.taxId || null,
      taxRate,
      taxInclusive: !!(tax && tax.inclusive),
      taxAmount,
      taxableAmount: taxable,
      lineTotal,
    };
  });

  const totalQty = items.reduce((s, l) => s + l.qty, 0);
  const discountTotal = itemDiscountTotal + cartDiscount;
  // exclusive tax adds on top; inclusive already inside line totals
  let grand = items.reduce((s, l) => s + l.lineTotal, 0);

  // Fixed-amount VAT / fees: applied once to the whole sale (not per line), only
  // when the cart is non-empty. Never refunded on a return.
  if (totalQty > 0) {
    for (const t of opts.taxes || []) {
      if (t.type !== 'fixed' || t.archivedAt) continue;
      const amt = Math.max(0, Math.trunc(t.amount || 0));
      if (!amt) continue;
      taxTotal += amt;
      grand += amt;
      const acc = taxBreakdown.get(t.id) || { taxId: t.id, name: t.name, rate: 0, fixed: true, amount: 0, base: grand };
      acc.amount += amt;
      acc.fixed = true;
      taxBreakdown.set(t.id, acc);
    }
  }

  const totalCost = items.reduce((s, l) => s + money.mul(l.costPrice, l.qty), 0);
  const profit = grand - taxTotal - totalCost; // profit excludes tax collected

  return {
    items,
    totalQty,
    subtotal,
    itemDiscountTotal,
    cartDiscount,
    manualCartDiscount,
    autoDiscount,
    autoDiscountName,
    couponDiscount,
    couponCode,
    cartDiscountType: opts.cartDiscountType || null,
    cartDiscountValue: opts.cartDiscountValue || 0,
    discountTotal,
    taxTotal,
    taxLines: [...taxBreakdown.values()],
    grandTotal: grand,
    totalCost,
    estimatedProfit: profit,
  };
}

/** Validate that a payments array covers the grand total exactly. */
export function validatePayments(payments, grandTotal) {
  const list = (payments || []).filter((p) => p && Number(p.amount) > 0);
  if (!list.length) conflict('Payment is required to complete the sale.');
  const paid = list.reduce((s, p) => s + Math.trunc(p.amount), 0);
  const cashPaid = list.filter((p) => p.method === 'cash').reduce((s, p) => s + Math.trunc(p.amount), 0);
  const nonCashPaid = paid - cashPaid;

  if (nonCashPaid > grandTotal + 0) {
    conflict('Non-cash payment exceeds the invoice total.');
  }
  if (paid < grandTotal) {
    conflict(`Payment amount is incomplete. Short by ${money.format(grandTotal - paid)}.`);
  }
  const change = paid - grandTotal; // only cash can produce change
  if (change > cashPaid) {
    conflict('Change due exceeds the cash tendered.');
  }
  return { paid, change, cashPaid, nonCashPaid, list };
}

/** Per-merchant document sequence key so references never collide across tenants. */
export function seqKey(name) {
  const mid = currentMerchantId();
  return mid ? `${name}:${mid}` : name;
}
