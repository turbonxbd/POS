/**
 * sales.routes.js - the transaction core.
 *
 * POST /sales performs the full atomic checkout (§44):
 *   validate cart -> validate availability -> compute money -> validate payment
 *   -> create sale + items + payments + inventory ledger -> update stock
 *   -> allocate unique invoice number -> audit -> notify -> return sale.
 * Everything runs inside a single db.tx() so a failure rolls back completely -
 * there are no partial sales.
 *
 * Idempotency: the client sends `idempotencyKey`; a replay returns the original
 * sale instead of creating a duplicate (§45).
 */

import db from '../db.js';
import { tdb } from './scope.js';
import { ok, created, notFound, badRequest, conflict, applyListQuery } from './router.js';
import {
  audit, notify, postInventory, getStockQty, requireBranch,
  computeCart, validatePayments, getSettings, variantName, actorStamp,
} from './helpers.js';
import money from '../../utils/money.js';
import { now } from '../../utils/date.js';
import { uuid } from '../../utils/id.js';

function activeTaxes() {
  return tdb('taxes').find({ archivedAt: { $exists: false } });
}

function activeDiscounts() {
  const t = Date.now();
  return tdb('discounts').find(
    (d) => (d.status ? d.status === 'active' : true) && !d.archivedAt
      && (!d.startsAt || new Date(d.startsAt).getTime() <= t)
      && (!d.endsAt || new Date(d.endsAt).getTime() >= t),
  );
}

/** Auto (no-code) cart-scope discounts + the coupon rule for `code`, if valid. */
function resolveCartDiscounts(code) {
  const all = activeDiscounts();
  const autoDiscounts = all.filter((d) => !d.code && (d.scope == null || d.scope === 'cart') && (!d.usageLimit || (d.usageCount || 0) < d.usageLimit));
  let coupon = null;
  const wanted = String(code || '').trim().toUpperCase();
  if (wanted) {
    const d = all.find((x) => x.code && x.code.toUpperCase() === wanted);
    if (!d) badRequest(`Coupon "${wanted}" is no longer valid.`);
    if (d.usageLimit && (d.usageCount || 0) >= d.usageLimit) conflict('This coupon has reached its usage limit.');
    coupon = { id: d.id, code: d.code, name: d.name, type: d.type, value: d.value, minSpend: d.minSpend || 0, maxDiscount: d.maxDiscount || 0 };
  }
  return { autoDiscounts, coupon };
}

function buildCartLines(rawItems, branchId) {
  if (!Array.isArray(rawItems) || !rawItems.length) badRequest('The cart is empty. Add at least one product.');
  return rawItems.map((it) => {
    const product = tdb('products').get(it.productId);
    if (!product) badRequest(`A product in the cart no longer exists.`);
    if (product.archivedAt) badRequest(`"${product.name}" has been archived and cannot be sold.`);
    const variant = it.variantId ? product.variants?.find((v) => v.id === it.variantId) : null;
    if (it.variantId && !variant) badRequest(`A selected variant of "${product.name}" no longer exists.`);
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty <= 0) badRequest(`Quantity for "${product.name}" must be a whole number greater than 0.`);

    const basePrice = variant ? variant.sellingPrice : (product.discountPrice ?? product.sellingPrice);
    const unitPrice = it.unitPriceOverride != null ? Math.max(0, Math.trunc(it.unitPriceOverride)) : basePrice;
    const costPrice = variant ? variant.costPrice : product.costPrice;

    return {
      productId: product.id,
      variantId: variant?.id || null,
      name: product.name,
      variantLabel: variant ? variantName(product, variant.id) : null,
      sku: variant ? variant.sku : product.sku,
      barcode: variant ? variant.barcode : product.barcode,
      unit: product.unit,
      unitPrice,
      costPrice,
      qty,
      discountType: it.discountType || null,
      discountValue: it.discountValue || 0,
      taxId: it.taxId ?? product.taxId ?? null,
      trackInventory: product.trackInventory !== false,
    };
  });
}

function assertAvailability(lines, branchId, allowNegative) {
  if (allowNegative) return;
  const need = new Map();
  for (const l of lines) {
    if (!l.trackInventory) continue;
    const key = `${l.productId}:${l.variantId || 'base'}`;
    need.set(key, (need.get(key) || 0) + l.qty);
  }
  for (const [key, qty] of need) {
    const [productId, variantRaw] = key.split(':');
    const variantId = variantRaw === 'base' ? null : variantRaw;
    const available = getStockQty(branchId, productId, variantId);
    if (available < qty) {
      const p = tdb('products').get(productId);
      conflict(`Stock is insufficient for "${p?.name || productId}". Available ${available}, cart needs ${qty}.`);
    }
  }
}

function decorateSale(sale) {
  const customer = sale.customerId ? tdb('customers').get(sale.customerId) : null;
  const branch = tdb('branches').get(sale.branchId);
  return {
    ...sale,
    customerName: customer?.name || sale.customerName || 'Walk-in Customer',
    customerPhone: customer?.phone || sale.customerPhone || null,
    branchName: branch?.name || null,
    returnedTotal: tdb('sale_returns').find({ saleId: sale.id }).reduce((s, r) => s + r.refundTotal, 0),
  };
}

export default function register(router) {
  /* --------------------------------------------------------------- list */
  router.get('/sales', ({ query }) => {
    let rows = tdb('sales').all();
    if (query.branchId) rows = rows.filter((s) => s.branchId === query.branchId);
    if (query.cashierId) rows = rows.filter((s) => s.cashierId === query.cashierId);
    if (query.customerId) rows = rows.filter((s) => s.customerId === query.customerId);
    if (query.registerSessionId) rows = rows.filter((s) => s.registerSessionId === query.registerSessionId);
    if (query.status && query.status !== 'all') rows = rows.filter((s) => s.status === query.status);
    if (query.payment && query.payment !== 'all') rows = rows.filter((s) => s.paymentSummary?.includes(query.payment));
    if (query.from || query.to) {
      const from = query.from ? new Date(query.from).getTime() : -Infinity;
      const to = query.to ? new Date(query.to).getTime() : Infinity;
      rows = rows.filter((s) => { const t = new Date(s.createdAt).getTime(); return t >= from && t <= to; });
    }
    const decorated = rows.map(decorateSale);
    const result = applyListQuery(decorated, query, {
      searchable: ['invoiceNo', 'customerName', 'customerPhone', 'cashierName'],
      sortable: ['createdAt', 'invoiceNo', 'grandTotal', 'totalQty'],
      defaultSort: 'createdAt', defaultDir: 'desc',
    });
    const totals = decorated.reduce(
      (acc, s) => {
        acc.count++;
        acc.gross += s.grandTotal;
        acc.discount += s.discountTotal;
        acc.tax += s.taxTotal;
        acc.profit += s.estimatedProfit;
        return acc;
      },
      { count: 0, gross: 0, discount: 0, tax: 0, profit: 0 },
    );
    return ok({ ...result, totals });
  });

  router.get('/sales/lookup', ({ query }) => {
    const invoice = String(query.invoice || query.invoiceNo || '').trim();
    if (!invoice) badRequest('Provide an invoice number');
    const sale = tdb('sales').findOne((s) => s.invoiceNo.toLowerCase() === invoice.toLowerCase());
    if (!sale) notFound('Invoice');
    return ok(decorateSale(sale));
  });

  router.get('/sales/:id', ({ params }) => {
    const sale = tdb('sales').get(params.id);
    if (!sale) notFound('Sale');
    return ok({
      ...decorateSale(sale),
      items: tdb('sale_items').find({ saleId: sale.id }).sort((a, b) => a.lineNo - b.lineNo),
      payments: tdb('payments').find({ saleId: sale.id }),
      returns: tdb('sale_returns').find({ saleId: sale.id }),
    });
  });

  /* --------------------------------- COLLECT PAYMENT ON A DUE SALE */
  router.post('/sales/:id/payment', ({ params, body }) => {
    const sale = tdb('sales').get(params.id);
    if (!sale) notFound('Sale');
    const due = sale.dueTotal || 0;
    if (due <= 0) badRequest('This sale has no outstanding balance.');
    const amount = Math.trunc(Number(body?.amount) || 0);
    if (amount <= 0) badRequest('Enter an amount greater than zero.');
    if (amount > due) badRequest(`The amount cannot exceed the ${money.format(due)} still due.`);
    const method = body?.method || 'cash';

    return db.tx(() => {
      const branch = tdb('branches').get(sale.branchId);
      const openReg = tdb('register_sessions').findOne((s) => s.branchId === sale.branchId && s.status === 'open')?.id || null;
      tdb('payments').insert({
        id: uuid(), saleId: sale.id, branchId: sale.branchId, registerSessionId: openReg,
        direction: 'in', method: method === 'mobile' ? 'mobile' : method,
        provider: body?.provider || (['bkash', 'nagad', 'rocket', 'other'].includes(method) ? method : null),
        amount, reference: body?.reference ? String(body.reference).slice(0, 40) : null,
        note: body?.note || 'Due payment', at: now(),
      });
      const nextDue = due - amount;
      const paidTotal = (sale.paidTotal || 0) + amount;
      tdb('sales').update(sale.id, {
        paidTotal, dueTotal: nextDue,
        status: nextDue <= 0 && sale.status === 'due' ? 'completed' : sale.status,
      });
      if (sale.customerId) {
        tdb('customers').update(sale.customerId, (c) => ({ outstandingBalance: Math.max(0, (c.outstandingBalance || 0) - amount) }));
        tdb('customer_ledger').insert({
          id: uuid(), customerId: sale.customerId, type: 'payment', refType: 'sale', refId: sale.id,
          amount, balanceDelta: -amount, note: body?.note || `Payment for ${sale.invoiceNo}`, at: now(),
        });
      }
      audit('update', 'sale', sale.id, { meta: { action: 'due_payment', amount, invoiceNo: sale.invoiceNo } });
      notify('sale', 'Due payment received', `${money.format(amount)} against ${sale.invoiceNo}${nextDue > 0 ? ` — ${money.format(nextDue)} still due` : ' — fully paid'}${branch ? ` @ ${branch.name}` : ''}`, {
        level: 'success', link: `#/sales/${sale.id}`,
      });
      return ok({
        ...decorateSale(tdb('sales').get(sale.id)),
        items: tdb('sale_items').find({ saleId: sale.id }),
        payments: tdb('payments').find({ saleId: sale.id }),
      });
    });
  });

  /* -------------------------------------------------------- CREATE SALE */
  router.post('/sales', ({ body }) => {
    const b = body || {};
    const settings = getSettings();
    const allowNegative = settings.inventory?.allowNegativeStock ?? false;

    // 45 - idempotency: replay returns the original sale
    if (b.idempotencyKey) {
      const existing = tdb('sales').findOne({ idempotencyKey: b.idempotencyKey });
      if (existing) return ok({ ...decorateSale(existing), _idempotentReplay: true });
    }

    const branch = requireBranch(b.branchId);
    const stamp = actorStamp();

    // Register must be open for cash handling (configurable)
    const session = tdb('register_sessions').findOne(
      (s) => s.branchId === branch.id && s.status === 'open' && s.cashierId === stamp.userId,
    ) || tdb('register_sessions').findOne((s) => s.branchId === branch.id && s.status === 'open');
    if (settings.pos?.requireOpenRegister && !session) {
      conflict('The cash register is closed. Open a register session before selling.');
    }

    // 1-3 validate cart & availability
    const lines = buildCartLines(b.items, branch.id);
    assertAvailability(lines, branch.id, allowNegative);

    // 4-7 money
    const { autoDiscounts, coupon } = resolveCartDiscounts(b.couponCode);
    const calc = computeCart(lines, {
      cartDiscountType: b.cartDiscountType || null,
      cartDiscountValue: b.cartDiscountValue || 0,
      taxes: activeTaxes(),
      autoDiscounts,
      coupon,
    });
    if (calc.grandTotal < 0) badRequest('Total cannot be negative.');
    if (coupon && !calc.couponDiscount) {
      badRequest(coupon.minSpend
        ? `This coupon needs a minimum spend of ${money.format(coupon.minSpend)}.`
        : 'This coupon cannot be applied to the current cart.');
    }

    // 8 validate payment
    const isDueSale = b.onAccount === true && b.customerId;
    let paymentInfo = { paid: 0, change: 0, cashPaid: 0, list: [] };
    if (!isDueSale || (b.payments && b.payments.length)) {
      paymentInfo = validatePayments(b.payments, isDueSale ? 0 : calc.grandTotal);
    }
    if (isDueSale && paymentInfo.paid > calc.grandTotal) badRequest('Amount paid exceeds the total on an account sale.');
    const dueAmount = Math.max(0, calc.grandTotal - paymentInfo.paid);
    if (dueAmount > 0 && !b.customerId) {
      conflict('Select a customer to record an outstanding balance for an unpaid amount.');
    }

    return db.tx(() => {
      // 14 unique invoice number (per branch sequence)
      const invoiceNo = db.seq(`invoice:${branch.id}`, {
        template: settings.pos?.invoiceTemplate || 'AFIA-{BR}-{SEQ}',
        prefix: settings.business?.invoicePrefix || 'AFIA',
        branchCode: branch.code || 'MAIN',
        seqWidth: 5,
      });

      const customer = b.customerId ? tdb('customers').get(b.customerId) : null;

      // 9 create sale
      const sale = tdb('sales').insert({
        id: uuid(),
        invoiceNo,
        idempotencyKey: b.idempotencyKey || uuid(),
        branchId: branch.id,
        branchName: branch.name,
        registerSessionId: session?.id || null,
        cashierId: stamp.userId,
        cashierName: stamp.userName,
        customerId: customer?.id || null,
        customerName: customer?.name || 'Walk-in Customer',
        customerPhone: customer?.phone || null,
        note: b.note || '',
        status: dueAmount > 0 ? 'due' : 'completed',
        // money breakdown (all minor units)
        subtotal: calc.subtotal,
        itemDiscountTotal: calc.itemDiscountTotal,
        cartDiscount: calc.cartDiscount,
        manualCartDiscount: calc.manualCartDiscount,
        autoDiscount: calc.autoDiscount,
        autoDiscountName: calc.autoDiscountName,
        couponDiscount: calc.couponDiscount,
        couponCode: calc.couponCode,
        cartDiscountType: calc.cartDiscountType,
        cartDiscountValue: calc.cartDiscountValue,
        discountTotal: calc.discountTotal,
        taxTotal: calc.taxTotal,
        taxLines: calc.taxLines,
        grandTotal: calc.grandTotal,
        totalQty: calc.totalQty,
        totalCost: calc.totalCost,
        estimatedProfit: calc.estimatedProfit,
        paidTotal: paymentInfo.paid,
        changeTotal: paymentInfo.change,
        dueTotal: dueAmount,
        paymentSummary: (paymentInfo.list.map((p) => p.method).join('+')) || (isDueSale ? 'account' : ''),
        createdAt: now(),
      });

      // 10 sale items (immutable snapshots)
      calc.items.forEach((it, idx) => {
        const src = lines[idx];
        tdb('sale_items').insert({
          id: uuid(),
          saleId: sale.id,
          branchId: branch.id,
          lineNo: idx + 1,
          productId: it.productId,
          variantId: it.variantId,
          name: src.name,
          variantLabel: src.variantLabel,
          sku: src.sku,
          barcode: src.barcode,
          unit: src.unit,
          unitPrice: it.unitPrice,
          costPrice: it.costPrice,
          qty: it.qty,
          lineDiscount: it.lineDiscount,
          cartDiscountShare: it.cartDiscountShare,
          discountTotal: it.discountTotal,
          taxId: it.taxId,
          taxRate: it.taxRate,
          taxAmount: it.taxAmount,
          taxableAmount: it.taxableAmount,
          lineTotal: it.lineTotal,
          returnedQty: 0,
        });

        // 12-13 inventory ledger + stock cache
        if (src.trackInventory) {
          postInventory({
            branchId: branch.id,
            productId: it.productId,
            variantId: it.variantId,
            type: 'sale',
            qtyDelta: -it.qty,
            unitCost: it.costPrice,
            refType: 'sale',
            refId: sale.id,
            note: `Invoice ${invoiceNo}`,
            allowNegative,
          });
        }
      });

      // 11 payment transactions (no sensitive card data stored)
      paymentInfo.list.forEach((p) => {
        tdb('payments').insert({
          id: uuid(),
          saleId: sale.id,
          branchId: branch.id,
          registerSessionId: session?.id || null,
          direction: 'in',
          method: p.method, // cash | card | mobile | bank_transfer
          provider: p.method === 'mobile' ? (p.provider || 'other') : null, // bkash | nagad | rocket | other
          amount: Math.trunc(p.amount),
          reference: p.reference ? String(p.reference).slice(0, 40) : null,
          cardLast4: p.cardLast4 ? String(p.cardLast4).replace(/\D/g, '').slice(-4) : null,
          note: p.note || null,
          at: now(),
        });
      });

      // customer aggregates + loyalty + balance
      if (customer) {
        const loyaltyEarned = settings.pos?.loyaltyPerCurrency
          ? Math.floor(money.toMajor(calc.grandTotal) * settings.pos.loyaltyPerCurrency)
          : 0;
        tdb('customers').update(customer.id, (c) => ({
          totalOrders: (c.totalOrders || 0) + 1,
          totalPurchases: (c.totalPurchases || 0) + calc.grandTotal,
          outstandingBalance: (c.outstandingBalance || 0) + dueAmount,
          loyaltyPoints: (c.loyaltyPoints || 0) + loyaltyEarned,
          lastPurchaseAt: now(),
        }));
        if (dueAmount > 0) {
          tdb('customer_ledger').insert({
            id: uuid(), customerId: customer.id, type: 'sale_due', refType: 'sale', refId: sale.id,
            amount: dueAmount, balanceDelta: dueAmount, note: `Invoice ${invoiceNo}`, at: now(),
          });
        }
      }

      // register cash movement (implicit - cash sales counted at close via payments)

      // 15 audit
      audit('sale', 'sale', sale.id, {
        after: { invoiceNo, grandTotal: calc.grandTotal, items: calc.items.length },
        meta: { invoiceNo, branchId: branch.id },
      });
      // 16 notify
      notify('sale', 'New sale', `${invoiceNo} — ${money.format(calc.grandTotal)} (${calc.totalQty} items)`, {
        level: 'success', link: `#/sales/${sale.id}`, meta: { saleId: sale.id },
      });

      // bump coupon / automatic-discount usage counters
      if (calc.couponDiscount && coupon?.id) {
        tdb('discounts').update(coupon.id, (d) => ({ usageCount: (d.usageCount || 0) + 1 }));
      }
      if (calc.autoDiscount && calc.autoDiscountName) {
        const used = autoDiscounts.find((d) => (d.name || 'Automatic discount') === calc.autoDiscountName);
        if (used) tdb('discounts').update(used.id, (d) => ({ usageCount: (d.usageCount || 0) + 1 }));
      }

      // clear a held sale if this checkout resumed one
      if (b.fromHeldSaleId) tdb('held_sales').remove(b.fromHeldSaleId);

      const full = {
        ...decorateSale(tdb('sales').get(sale.id)),
        items: tdb('sale_items').find({ saleId: sale.id }),
        payments: tdb('payments').find({ saleId: sale.id }),
      };
      return created(full);
    });
  });

  /* -------------------------------------------------------- HELD SALES */
  router.get('/held-sales', ({ query }) => {
    let rows = tdb('held_sales').all();
    if (query.branchId) rows = rows.filter((h) => h.branchId === query.branchId);
    if (query.cashierId) rows = rows.filter((h) => h.cashierId === query.cashierId);
    return ok(applyListQuery(rows, { ...query, pageSize: query.pageSize || 'all' }, {
      searchable: ['label', 'customerName'], sortable: ['createdAt', 'grandTotal'], defaultSort: 'createdAt', defaultDir: 'desc',
    }));
  });

  router.post('/held-sales', ({ body }) => {
    const branch = requireBranch(body?.branchId);
    const stamp = actorStamp();
    const count = tdb('held_sales').count((h) => h.cashierId === stamp.userId);
    if (count >= (getSettings().pos?.holdSaleLimit || 20)) {
      conflict('Too many held sales. Resume or discard one before holding another.');
    }
    return db.tx(() => {
      const doc = tdb('held_sales').insert({
        id: uuid(),
        label: body.label || `Hold ${new Date().toLocaleTimeString()}`,
        branchId: branch.id,
        cashierId: stamp.userId,
        cashierName: stamp.userName,
        customerId: body.customerId || null,
        customerName: body.customerName || null,
        items: body.items || [],
        cartDiscountType: body.cartDiscountType || null,
        cartDiscountValue: body.cartDiscountValue || 0,
        note: body.note || '',
        grandTotal: Number(body.grandTotal) || 0,
        createdAt: now(),
      });
      audit('create', 'held_sale', doc.id);
      return created(doc);
    });
  });

  router.del('/held-sales/:id', ({ params }) => {
    if (!tdb('held_sales').get(params.id)) notFound('Held sale');
    return db.tx(() => {
      tdb('held_sales').remove(params.id);
      audit('delete', 'held_sale', params.id);
      return ok({ deleted: true });
    });
  });

  /* -------------------------------------------------------- SALE RETURNS */
  router.get('/sale-returns', ({ query }) => {
    let rows = tdb('sale_returns').all();
    if (query.branchId) rows = rows.filter((r) => r.branchId === query.branchId);
    if (query.saleId) rows = rows.filter((r) => r.saleId === query.saleId);
    return ok(applyListQuery(rows, query, {
      searchable: ['reference', 'invoiceNo', 'reason'],
      sortable: ['at', 'reference', 'refundTotal'], defaultSort: 'at', defaultDir: 'desc',
      dateField: 'at',
      summarize: (list) => {
        const exchanges = list.filter((r) => r.type === 'exchange').length;
        return {
          returns: list.length - exchanges,
          exchanges,
          totalRefunded: list.reduce((s, r) => s + (r.refundTotal || 0), 0),
          extraCollected: list.reduce((s, r) => s + (r.additionalPayment || 0), 0),
        };
      },
    }));
  });

  router.post('/sales/:id/returns', ({ params, body }) => {
    const sale = tdb('sales').get(params.id);
    if (!sale) notFound('Sale');
    const b = body || {};
    const lines = b.lines || [];
    if (!lines.length) badRequest('Select at least one item to return');

    const isExchange = b.type === 'exchange' && Array.isArray(b.replacementItems) && b.replacementItems.length > 0;
    const saleItems = tdb('sale_items').find({ saleId: sale.id });
    const reason = b.reason || 'customer_request';
    const settings = getSettings();
    const allowNegative = settings.inventory?.allowNegativeStock ?? false;

    return db.tx(() => {
      const ref = db.seq(`sale_return:${sale.branchId}`, { template: 'RET-{BR}-{SEQ}', branchCode: tdb('branches').get(sale.branchId)?.code || 'MAIN', seqWidth: 4 });
      let refundGoods = 0;
      let refundTax = 0;
      const returnItems = [];

      /* -- returned items: restock to the ORIGINAL sale branch, mark returnedQty -- */
      for (const line of lines) {
        const item = saleItems.find((si) => si.id === line.saleItemId);
        if (!item) badRequest('A selected line does not belong to this invoice');
        const qty = Number(line.qty);
        const remaining = item.qty - (item.returnedQty || 0);
        if (!Number.isInteger(qty) || qty <= 0) badRequest(`Invalid return quantity for ${item.name}`);
        if (qty > remaining) conflict(`Cannot return ${qty} of "${item.name}" — only ${remaining} remain returnable.`);

        const perUnitNet = Math.round((item.lineTotal - item.taxAmount) / item.qty);
        const perUnitTax = Math.round(item.taxAmount / item.qty);
        const goods = perUnitNet * qty;
        const tax = perUnitTax * qty;
        refundGoods += goods;
        refundTax += tax;

        tdb('sale_items').update(item.id, { returnedQty: (item.returnedQty || 0) + qty });

        const restock = line.restock !== false && reason !== 'damaged';
        if (restock) {
          const product = tdb('products').get(item.productId);
          if (product?.trackInventory !== false) {
            postInventory({
              branchId: sale.branchId, productId: item.productId, variantId: item.variantId,
              type: 'sale_return', qtyDelta: qty, unitCost: item.costPrice,
              refType: 'sale_return', refId: ref, note: `${isExchange ? 'Exchange' : 'Return'} of ${sale.invoiceNo}`,
            });
          }
        }
        returnItems.push({ saleItemId: item.id, productId: item.productId, variantId: item.variantId, name: item.name, sku: item.sku, barcode: item.barcode, qty, unitPrice: perUnitNet + perUnitTax, restock, refund: goods + tax });
      }

      const returnRefund = refundGoods + refundTax;

      /* -- replacement items (exchange): price at current selling price, deduct from the SAME branch -- */
      let replacementTotal = 0;
      const replacementItems = [];
      if (isExchange) {
        const taxes = activeTaxes();
        const repLines = [];
        for (const r of b.replacementItems) {
          const p = tdb('products').get(r.productId);
          if (!p) badRequest('A replacement product no longer exists');
          const variant = r.variantId ? p.variants?.find((v) => v.id === r.variantId) : null;
          const qty = Number(r.qty);
          if (!Number.isInteger(qty) || qty <= 0) badRequest(`Invalid replacement quantity for ${p.name}`);
          const avail = getStockQty(sale.branchId, p.id, r.variantId || null);
          if (p.trackInventory !== false && qty > avail && !allowNegative) {
            conflict(`Insufficient stock for the selected replacement product "${p.name}" — ${avail} available at this branch.`);
          }
          repLines.push({
            productId: p.id, variantId: r.variantId || null, name: variant ? `${p.name} — ${variant.name}` : p.name,
            sku: variant?.sku || p.sku, barcode: variant?.barcode || p.barcode,
            unitPrice: variant?.sellingPrice ?? p.discountPrice ?? p.sellingPrice, qty,
            taxId: p.taxId || null, costPrice: variant?.costPrice ?? p.costPrice,
          });
        }
        const calc = computeCart(repLines, { taxes });
        replacementTotal = calc.grandTotal;
        calc.items.forEach((ci, i) => {
          const src = repLines[i];
          const p = tdb('products').get(src.productId);
          if (p?.trackInventory !== false) {
            postInventory({
              branchId: sale.branchId, productId: src.productId, variantId: src.variantId,
              type: 'exchange_out', qtyDelta: -src.qty, unitCost: src.costPrice,
              refType: 'sale_return', refId: ref, note: `Exchange for ${sale.invoiceNo}`,
              allowNegative,
            });
          }
          replacementItems.push({ productId: src.productId, variantId: src.variantId, name: src.name, sku: src.sku, barcode: src.barcode, qty: src.qty, unitPrice: src.unitPrice, lineTotal: ci.lineTotal });
        });
      }

      /* -- financials: net difference the customer pays (in) or receives (out) -- */
      const difference = replacementTotal - returnRefund;
      const additionalPayment = difference > 0 ? difference : 0;
      const refundTotal = difference < 0 ? -difference : 0;
      const method = b.refundMethod || b.paymentMethod || (b.payments && b.payments[0]?.method) || 'cash';
      const openReg = tdb('register_sessions').findOne((s) => s.branchId === sale.branchId && s.status === 'open')?.id || null;

      const doc = tdb('sale_returns').insert({
        id: uuid(),
        reference: ref,
        type: isExchange ? 'exchange' : 'return',
        saleId: sale.id,
        invoiceNo: sale.invoiceNo,
        branchId: sale.branchId,
        customerId: sale.customerId,
        customerName: sale.customerName || null,
        cashierId: actorStamp().userId,
        cashierName: actorStamp().userName,
        reason,
        note: b.note || '',
        items: returnItems,
        replacementItems,
        refundGoods,
        refundTax,
        returnRefund,
        replacementTotal,
        difference,
        refundTotal,
        additionalPayment,
        refundMethod: method,
        at: now(),
      });

      if (refundTotal > 0) {
        tdb('payments').insert({
          id: uuid(), saleId: sale.id, saleReturnId: doc.id, branchId: sale.branchId, registerSessionId: openReg,
          direction: 'out', method, amount: refundTotal,
          reference: ref, note: `${isExchange ? 'Exchange refund' : 'Refund'} for ${sale.invoiceNo}`, at: now(),
        });
      }
      if (additionalPayment > 0) {
        tdb('payments').insert({
          id: uuid(), saleId: sale.id, saleReturnId: doc.id, branchId: sale.branchId, registerSessionId: openReg,
          direction: 'in', method, amount: additionalPayment,
          reference: ref, note: `Exchange top-up for ${sale.invoiceNo}`, at: now(),
        });
      }

      // sale status - never destroy the original sale
      const allItems = tdb('sale_items').find({ saleId: sale.id });
      const fullyReturned = allItems.every((i) => (i.returnedQty || 0) >= i.qty);
      const anyReturned = allItems.some((i) => (i.returnedQty || 0) > 0);
      tdb('sales').update(sale.id, {
        status: fullyReturned ? 'refunded' : anyReturned ? 'partially_refunded' : sale.status,
      });

      if (sale.customerId) {
        tdb('customers').update(sale.customerId, (c) => ({
          totalPurchases: Math.max(0, (c.totalPurchases || 0) - returnRefund + replacementTotal),
        }));
      }

      audit(isExchange ? 'exchange' : 'refund', 'sale_return', doc.id, { after: doc, meta: { invoiceNo: sale.invoiceNo, refundTotal, additionalPayment } });
      notify('refund', isExchange ? 'Product exchanged' : 'Sale returned',
        isExchange
          ? `${ref} — exchange against ${sale.invoiceNo}${difference > 0 ? ` (customer paid ${money.format(additionalPayment)})` : difference < 0 ? ` (refund ${money.format(refundTotal)})` : ''}`
          : `${ref} — refund ${money.format(refundTotal)} against ${sale.invoiceNo}`,
        { level: 'warning', link: `#/sales/${sale.id}` });
      return created(doc);
    });
  });
}
