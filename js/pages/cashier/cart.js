/**
 * cart.js - POS cart state. Pure data + computation; the view subscribes.
 * Totals are computed with the SAME function the backend uses (computeCart) so
 * the on-screen total always matches the completed sale.
 */
import { computeCart } from '../../core/mock/helpers.js';
import money from '../../utils/money.js';
import { uuid } from '../../utils/id.js';

export class Cart {
  #lines = [];
  #customer = null;
  #cartDiscount = { type: null, value: 0 };
  #note = '';
  #taxes = [];
  #autoDiscounts = [];
  #coupon = null; // validated rule: { id, code, type, value, minSpend, maxDiscount, name }
  #subs = new Set();
  fromHeldSaleId = null;

  setTaxes(taxes) {
    this.#taxes = taxes || [];
    this.#emit();
  }

  /** Active, no-code discount rules that apply themselves to the cart. */
  setAutoDiscounts(list) {
    this.#autoDiscounts = list || [];
    this.#emit();
  }

  setCoupon(rule) {
    this.#coupon = rule || null;
    this.#emit();
  }
  clearCoupon() {
    this.#coupon = null;
    this.#emit();
  }
  get coupon() {
    return this.#coupon;
  }

  subscribe(fn) {
    this.#subs.add(fn);
    fn(this.snapshot());
    return () => this.#subs.delete(fn);
  }
  #emit() {
    const snap = this.snapshot();
    this.#subs.forEach((fn) => fn(snap));
  }

  get isEmpty() {
    return this.#lines.length === 0;
  }
  get count() {
    return this.#lines.reduce((s, l) => s + l.qty, 0);
  }
  get customer() {
    return this.#customer;
  }
  get lines() {
    return this.#lines;
  }

  addProduct(product, { variantId = null, qty = 1 } = {}) {
    const variant = variantId ? product.variants?.find((v) => v.id === variantId) : null;
    const key = `${product.id}:${variantId || 'base'}`;
    const existing = this.#lines.find((l) => l.key === key);
    const maxStock = product.trackInventory === false ? Infinity
      : (variant ? (product.variantStock?.find((v) => v.id === variantId)?.stock ?? 0) : product.stock ?? 0);

    if (existing) {
      existing.qty = Math.min(existing.qty + qty, existing.trackInventory ? maxStock : existing.qty + qty);
      existing._maxStock = maxStock;
    } else {
      this.#lines.push({
        id: uuid(),
        key,
        productId: product.id,
        variantId: variant?.id || null,
        name: product.name,
        categoryId: product.categoryId || null,
        variantLabel: variant ? (variant.name || Object.values(variant.options || {}).join(' / ')) : null,
        sku: variant?.sku || product.sku,
        unitPrice: variant ? variant.sellingPrice : (product.discountPrice ?? product.sellingPrice),
        listPrice: variant ? variant.sellingPrice : product.sellingPrice,
        costPrice: variant ? variant.costPrice : product.costPrice,
        unit: product.unit,
        taxId: product.taxId || null,
        qty: Math.min(qty, maxStock === Infinity ? qty : maxStock),
        trackInventory: product.trackInventory !== false,
        _maxStock: maxStock,
        discountType: null,
        discountValue: 0,
        priceOverridden: false,
      });
    }
    this.#emit();
  }

  setQty(lineId, qty) {
    const line = this.#lines.find((l) => l.id === lineId);
    if (!line) return;
    qty = Math.max(0, Math.floor(qty));
    if (qty === 0) return this.remove(lineId);
    if (line.trackInventory && line._maxStock !== Infinity && qty > line._maxStock) {
      qty = line._maxStock;
      line._clamped = true;
    } else {
      line._clamped = false;
    }
    line.qty = qty;
    this.#emit();
  }

  increment(lineId, by = 1) {
    const line = this.#lines.find((l) => l.id === lineId);
    if (line) this.setQty(lineId, line.qty + by);
  }

  setLineDiscount(lineId, type, value) {
    const line = this.#lines.find((l) => l.id === lineId);
    if (!line) return;
    line.discountType = type || null;
    line.discountValue = Number(value) || 0;
    this.#emit();
  }

  setPrice(lineId, priceMinor) {
    const line = this.#lines.find((l) => l.id === lineId);
    if (!line) return;
    line.unitPrice = Math.max(0, Math.trunc(priceMinor));
    line.priceOverridden = line.unitPrice !== line.listPrice;
    this.#emit();
  }

  remove(lineId) {
    this.#lines = this.#lines.filter((l) => l.id !== lineId);
    this.#emit();
  }

  setCustomer(customer) {
    this.#customer = customer;
    this.#emit();
  }

  setCartDiscount(type, value) {
    this.#cartDiscount = { type: type || null, value: Number(value) || 0 };
    this.#emit();
  }
  get cartDiscount() {
    return this.#cartDiscount;
  }

  setNote(note) {
    this.#note = note || '';
  }
  get note() {
    return this.#note;
  }

  clear() {
    this.#lines = [];
    this.#customer = null;
    this.#cartDiscount = { type: null, value: 0 };
    this.#coupon = null;
    this.#note = '';
    this.fromHeldSaleId = null;
    this.#emit();
  }

  loadFromHeld(held, products) {
    this.clear();
    this.fromHeldSaleId = held.id;
    (held.items || []).forEach((it) => {
      const p = products.find((x) => x.id === it.productId);
      if (p) {
        this.#lines.push({
          id: uuid(), key: `${it.productId}:${it.variantId || 'base'}`,
          productId: it.productId, variantId: it.variantId || null, name: it.name || p.name,
          variantLabel: it.variantLabel || null, sku: it.sku || p.sku,
          unitPrice: it.unitPrice ?? p.sellingPrice, listPrice: p.sellingPrice, costPrice: it.costPrice ?? p.costPrice,
          unit: p.unit, taxId: it.taxId ?? p.taxId, qty: it.qty,
          trackInventory: p.trackInventory !== false, _maxStock: p.stock ?? Infinity,
          discountType: it.discountType || null, discountValue: it.discountValue || 0, priceOverridden: false,
        });
      }
    });
    this.#cartDiscount = { type: held.cartDiscountType || null, value: held.cartDiscountValue || 0 };
    this.#note = held.note || '';
    this.#emit();
  }

  compute() {
    return computeCart(
      this.#lines.map((l) => ({
        productId: l.productId, variantId: l.variantId, name: l.name, sku: l.sku, categoryId: l.categoryId,
        unitPrice: l.unitPrice, costPrice: l.costPrice, qty: l.qty,
        discountType: l.discountType, discountValue: l.discountValue, taxId: l.taxId,
      })),
      {
        cartDiscountType: this.#cartDiscount.type,
        cartDiscountValue: this.#cartDiscount.value,
        taxes: this.#taxes,
        autoDiscounts: this.#autoDiscounts,
        coupon: this.#coupon,
      },
    );
  }

  snapshot() {
    return { lines: this.#lines, customer: this.#customer, cartDiscount: this.#cartDiscount, coupon: this.#coupon, totals: this.compute(), note: this.#note };
  }

  /** Payload for salesService.createSale / holdSale. */
  toDraft() {
    return {
      items: this.#lines.map((l) => ({
        productId: l.productId, variantId: l.variantId, qty: l.qty,
        unitPriceOverride: l.priceOverridden ? l.unitPrice : undefined,
        discountType: l.discountType || undefined, discountValue: l.discountValue || undefined,
        taxId: l.taxId || undefined,
      })),
      customerId: this.#customer?.id || null,
      cartDiscountType: this.#cartDiscount.type || undefined,
      cartDiscountValue: this.#cartDiscount.value || undefined,
      couponCode: this.#coupon?.code || undefined,
      note: this.#note || undefined,
      fromHeldSaleId: this.fromHeldSaleId || undefined,
    };
  }
}

export const money$ = money;
export default Cart;
