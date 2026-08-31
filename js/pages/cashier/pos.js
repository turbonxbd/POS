/**
 * pos.js - the point-of-sale checkout screen.
 * Catalog (search + barcode + categories + grid) on the left, cart + payment on
 * the right. Checkout is idempotent and guarded against double submission.
 */
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { debounce, createMutex } from '../../utils/debounce.js';
import money from '../../utils/money.js';
import { uuid } from '../../utils/id.js';
import { toast } from '../../components/toast.js';
import { openModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirm.js';
import { createForm } from '../../components/form.js';
import { printHtml } from '../../utils/print.js';
import { Cart } from './cart.js';
import { openPayment } from './payment.js';
import { buildReceipt } from '../shared/receipt.js';
import productService from '../../services/product-service.js';
import discountService from '../../services/discount-service.js';
import salesService from '../../services/sales-service.js';
import customerService from '../../services/customer-service.js';
import taxService from '../../services/tax-service.js';
import categoryService from '../../services/category-service.js';
import settingsService from '../../services/settings-service.js';
import { mediaService } from '../../services/media-service.js';
import { can } from '../../core/rbac.js';
import store from '../../core/store.js';
import bus from '../../core/event-bus.js';

const checkoutMutex = createMutex();

/** Discounts that apply themselves to the cart: active, no coupon code, within
 *  their date window, cart scope. */
function activeAutoDiscounts(list) {
  const t = Date.now();
  return (list || []).filter((d) =>
    !d.code &&
    (d.status ? d.status === 'active' : true) &&
    !d.archivedAt &&
    (d.scope == null || d.scope === 'cart') &&
    (!d.startsAt || new Date(d.startsAt).getTime() <= t) &&
    (!d.endsAt || new Date(d.endsAt).getTime() >= t) &&
    (!d.usageLimit || (d.usageCount || 0) < d.usageLimit),
  );
}

export async function renderPOS(mount, { onNeedRegister } = {}) {
  const cart = new Cart();
  let categories = [];
  let activeCat = '';
  let products = [];
  let settings = {};
  let submitting = false;

  mount.innerHTML = `
    <div class="pos-catalog">
      <div class="pos-searchbar">
        <div class="input-search grow">
          <span class="input-search__icon">${icon('search', { size: 18 })}</span>
          <input class="input js-search" placeholder="Search product name or SKU  (F1)" autocomplete="off" aria-label="Search products">
        </div>
        <input class="input input--barcode js-barcode" placeholder="Scan barcode (F2)" autocomplete="off" aria-label="Barcode">
        <button class="btn btn--icon btn--outline js-scan" data-tooltip="Camera scan" aria-label="Camera scan">${icon('barcode')}</button>
      </div>
      <div class="pos-categories js-cats"></div>
      <div class="pos-products js-products"><div class="loading-block"><span class="spinner"></span></div></div>
    </div>

    <aside class="pos-cart js-cart-panel">
      <div class="pos-cart__head">
        <h2>Current Sale</h2>
        <div class="row">
          <button class="btn btn--ghost btn--sm js-hold" ${can('sales.hold') ? '' : 'hidden'}>${icon('pause', { size: 14 })} Hold (F8)</button>
          <button class="btn btn--ghost btn--sm js-clear">${icon('trash', { size: 14 })}</button>
        </div>
      </div>
      <div class="pos-customer js-customer"></div>
      <div class="pos-cart__items js-lines"></div>
      <form class="pos-coupon js-coupon-form">
        <input class="input js-coupon-input" placeholder="Coupon code" autocomplete="off" aria-label="Coupon code">
        <button class="btn btn--outline btn--sm js-coupon-apply" type="submit">Apply</button>
      </form>
      <div class="pos-coupon-status js-coupon-status" hidden></div>
      <div class="pos-cart__summary js-summary"></div>
      <div class="pos-cart__actions">
        <button class="btn btn--outline js-discount" ${can('sales.discount.cart') ? '' : 'hidden'}>${icon('percent', { size: 15 })} Discount</button>
        <button class="btn btn--outline js-held">${icon('inbox', { size: 15 })} Held</button>
        <button class="btn btn--success btn--pay js-pay">${icon('credit-card', { size: 18 })} Pay <span class="js-pay-total"></span></button>
      </div>
    </aside>

    <button class="pos-cart-fab js-cart-fab" type="button" hidden aria-label="View cart">
      ${icon('cart', { size: 18 })}
      <span class="pos-cart-fab__count js-fab-count">0</span>
      <span class="pos-cart-fab__total js-fab-total"></span>
      <span class="pos-cart-fab__go">${icon('chevron-right', { size: 16 })}</span>
    </button>
    <div class="pos-sheet-backdrop js-sheet-backdrop"></div>`;

  const els = {
    search: mount.querySelector('.js-search'),
    barcode: mount.querySelector('.js-barcode'),
    cats: mount.querySelector('.js-cats'),
    products: mount.querySelector('.js-products'),
    customer: mount.querySelector('.js-customer'),
    lines: mount.querySelector('.js-lines'),
    summary: mount.querySelector('.js-summary'),
    couponForm: mount.querySelector('.js-coupon-form'),
    couponInput: mount.querySelector('.js-coupon-input'),
    couponStatus: mount.querySelector('.js-coupon-status'),
    payTotal: mount.querySelector('.js-pay-total'),
    pay: mount.querySelector('.js-pay'),
    cartPanel: mount.querySelector('.js-cart-panel'),
  };

  /* -------- data load -------- */
  try {
    const [taxRes, catTree, s, discRes] = await Promise.all([
      taxService.getTaxes({ pageSize: 'all' }),
      categoryService.getTree(),
      settingsService.getSettings(),
      discountService.getDiscounts({ pageSize: 'all' }).catch(() => ({ data: [] })),
    ]);
    cart.setTaxes(taxRes.data || taxRes);
    cart.setAutoDiscounts(activeAutoDiscounts(discRes.data || discRes || []));
    categories = catTree;
    settings = s;
  } catch (err) {
    toast.fromError(err);
  }
  renderCats();
  await loadProducts();

  /* -------- catalog -------- */
  function renderCats() {
    els.cats.innerHTML =
      `<button class="pos-cat-chip ${!activeCat ? 'is-active' : ''}" data-cat="">All</button>` +
      categories
        .map((c) => `<button class="pos-cat-chip ${activeCat === c.id ? 'is-active' : ''}" data-cat="${c.id}">${escapeHtml(c.name)}</button>`)
        .join('');
    els.cats.querySelectorAll('.pos-cat-chip').forEach((b) =>
      b.addEventListener('click', () => {
        activeCat = b.dataset.cat;
        renderCats();
        loadProducts();
      }),
    );
  }

  const doSearch = debounce(() => loadProducts(), 200);
  els.search.addEventListener('input', doSearch);

  async function loadProducts() {
    els.products.innerHTML = `<div class="loading-block"><span class="spinner"></span></div>`;
    try {
      const res = await productService.getProducts({
        search: els.search.value.trim(),
        categoryId: activeCat || undefined,
        status: 'all',
        pageSize: 60,
        sort: 'name',
        dir: 'asc',
      });
      products = (res.data || []).filter((p) => p.status !== 'inactive' && !p.archivedAt);
      renderProducts();
    } catch (err) {
      els.products.innerHTML = `<div class="empty-state"><p class="text-danger">${escapeHtml(err.message)}</p></div>`;
    }
  }

  function renderProducts() {
    if (!products.length) {
      els.products.innerHTML = `<div class="empty-state"><div class="empty-state__icon">${icon('search', { size: 24 })}</div><h3>No products found</h3><p>Try another search or category.</p></div>`;
      return;
    }
    els.products.innerHTML = `<div class="pos-grid">${products
      .map((p) => {
        const outOfStock = p.trackInventory !== false && p.stock <= 0;
        const low = !outOfStock && p.minStock > 0 && p.stock <= p.minStock;
        const img = p.imageId ? mediaService.getUrl(p.imageId) : null;
        return `<button class="product-tile" data-id="${p.id}" ${outOfStock && !(settings.inventory?.allowNegativeStock) ? 'disabled' : ''}>
          ${img ? `<img class="product-tile__img" src="${img}" alt="" loading="lazy">` : `<div class="product-tile__img product-tile__img--ph">${icon('box', { size: 26 })}</div>`}
          <div class="product-tile__body">
            <span class="product-tile__name">${escapeHtml(p.name)}</span>
            <div class="product-tile__foot">
              <span class="product-tile__price">${money.format(p.discountPrice ?? p.sellingPrice, { withSymbol: false })}</span>
              <span class="product-tile__stock badge badge--${outOfStock ? 'danger' : low ? 'warning' : 'success'}">${p.trackInventory === false ? '∞' : p.stock}</span>
            </div>
          </div>
        </button>`;
      })
      .join('')}</div>`;
    els.products.querySelectorAll('.product-tile').forEach((tile) =>
      tile.addEventListener('click', () => {
        const p = products.find((x) => x.id === tile.dataset.id);
        if (p) addToCart(p);
      }),
    );
  }

  function addToCart(product) {
    if (product.hasVariants && product.variants?.length) {
      chooseVariant(product);
      return;
    }
    cart.addProduct(product);
    flashPay();
    focusBarcode();
  }

  function chooseVariant(product) {
    const m = openModal({
      title: product.name,
      subtitle: 'Choose a variant',
      size: 'sm',
      body: `<div class="stack" style="--stack-gap:var(--sp-2)">${product.variants
        .map((v) => {
          const st = product.variantStock?.find((x) => x.id === v.id)?.stock ?? 0;
          return `<button class="btn btn--outline js-var" data-v="${v.id}" ${st <= 0 && !settings.inventory?.allowNegativeStock ? 'disabled' : ''} style="justify-content:space-between">
            <span>${escapeHtml(v.name || Object.values(v.options || {}).join(' / '))}</span>
            <span class="row"><span class="pos-amount">${money.format(v.sellingPrice, { withSymbol: false })}</span><span class="badge badge--${st <= 0 ? 'danger' : 'neutral'}">${st}</span></span>
          </button>`;
        })
        .join('')}</div>`,
    });
    m.$$('.js-var').forEach((b) =>
      b.addEventListener('click', () => {
        cart.addProduct(product, { variantId: b.dataset.v });
        m.close();
        flashPay();
        focusBarcode();
      }),
    );
  }

  /* -------- barcode -------- */
  // Look the code up and drop the matching product into the cart. Scanning the
  // same code again just bumps its quantity (cart.addProduct merges by product).
  let scanBusy = false;
  async function scanCode(raw) {
    const code = String(raw || '').replace(/[\r\n\t]+/g, '').trim();
    if (!code || scanBusy) return false;
    scanBusy = true;
    try {
      const res = await productService.lookup({ code });
      if (res.match && res.product) {
        if (res.variantId) {
          cart.addProduct(res.product, { variantId: res.variantId });
        } else if (res.product.hasVariants && res.product.variants?.length) {
          chooseVariant(res.product);
        } else {
          cart.addProduct(res.product);
        }
        flashPay();
        focusBarcode();
        toast.success(`Added ${res.product.name}`, { duration: 1400 });
        return true;
      }
      toast.warning(`No product for barcode “${code}”`);
    } catch (err) {
      toast.fromError(err);
    } finally {
      scanBusy = false;
    }
    return false;
  }

  /* Hardware scanner detector — reads the code no matter where the cursor is
     and needs NO Enter key and NO click. A USB / Bluetooth scanner fires the
     whole code as a burst of keystrokes a few ms apart; a person types an
     order of magnitude slower. We buffer the fast keystrokes, keep them out of
     whatever field has focus, and the instant the burst stops (or an optional
     Enter / Tab suffix arrives) we look the code up and drop the product
     straight into the cart. */
  const SCAN_GAP_MS = 45; // longest quiet gap between two keys of one scan
  const SCAN_AVG_MS = 30; // a scan sustains fewer than this many ms per char
  const SCAN_MIN_LEN = 3;
  let burstBuf = '';
  let burstStart = 0;
  let burstPrevKey = 0;
  let burstFast = 0; // consecutive machine-fast gaps seen this burst
  let burstTimer = null;
  let lastScanAt = 0;

  function endBurst() {
    clearTimeout(burstTimer);
    burstTimer = null;
    const code = burstBuf.replace(/[\r\n\t]+/g, '').trim();
    const dur = burstPrevKey - burstStart;
    burstBuf = '';
    burstFast = 0;
    if (code.length < SCAN_MIN_LEN || !/^[\x21-\x7E]+$/.test(code)) return false;
    if (code.length > 1 && dur / (code.length - 1) > SCAN_AVG_MS) return false;
    lastScanAt = Date.now();
    // scrub the couple of characters that leaked into a field before we locked on
    if (els.search.value.length <= 3) els.search.value = '';
    els.barcode.value = '';
    scanCode(code);
    return true;
  }

  function onGlobalKey(e) {
    // a trailing Enter / Tab from a burst we already flushed on the timer
    if ((e.key === 'Enter' || e.key === 'Tab') && !burstBuf && Date.now() - lastScanAt < 500) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const now = Date.now();
    const gap = now - burstPrevKey;
    if (gap > SCAN_GAP_MS) { burstBuf = ''; burstStart = now; burstFast = 0; }
    burstPrevKey = now;

    if (e.key === 'Enter' || e.key === 'Tab') {
      if (burstBuf && endBurst()) { e.preventDefault(); e.stopPropagation(); }
      else burstBuf = '';
      return;
    }
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      burstBuf += e.key;
      if (gap <= SCAN_GAP_MS) burstFast++;
      // once it is clearly machine-fast, stop the keystrokes reaching the field
      if (burstFast >= 2) e.preventDefault();
      clearTimeout(burstTimer);
      burstTimer = setTimeout(endBurst, SCAN_GAP_MS + 25);
    }
  }
  document.addEventListener('keydown', onGlobalKey, true);

  // manual entry: someone types / pastes a code into the barcode box and hits
  // Enter (slow — the burst detector won't have fired)
  els.barcode.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (Date.now() - lastScanAt < 400) { els.barcode.value = ''; return; }
    const code = els.barcode.value;
    els.barcode.value = '';
    await scanCode(code);
  });

  mount.querySelector('.js-scan').addEventListener('click', () => cameraScan((code) => scanCode(code)));

  /* -------- coupon -------- */
  async function applyCoupon(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (!code) return;
    try {
      const snap = cart.snapshot();
      const res = await discountService.validateCoupon(code, snap.totals.subtotal);
      if (!res.valid) {
        toast.warning(res.message || 'That coupon is not valid.');
        return;
      }
      const d = res.discount || {};
      cart.setCoupon({
        id: d.id, code, name: d.name || null,
        type: res.type || d.type, value: res.value ?? d.value,
        minSpend: d.minSpend || 0, maxDiscount: d.maxDiscount || 0,
      });
      toast.success(`Coupon ${code} applied`);
      els.couponInput.value = '';
      focusBarcode();
    } catch (err) {
      toast.fromError(err);
    }
  }
  els.couponForm.addEventListener('submit', (e) => {
    e.preventDefault();
    applyCoupon(els.couponInput.value);
  });

  function renderCoupon(snap) {
    const c = snap.coupon;
    els.couponForm.hidden = !!c;
    els.couponStatus.hidden = !c;
    if (!c) return;
    els.couponStatus.innerHTML = `
      <span>${icon('tag', { size: 14 })} <strong>${escapeHtml(c.code)}</strong> −${money.format(snap.totals.couponDiscount || 0)}</span>
      <button type="button" class="btn btn--icon btn--ghost btn--sm js-coupon-remove" aria-label="Remove coupon">${icon('x', { size: 14 })}</button>`;
    els.couponStatus.querySelector('.js-coupon-remove').addEventListener('click', () => {
      cart.clearCoupon();
      els.couponInput.value = '';
      toast.info('Coupon removed');
    });
  }

  /* -------- cart rendering -------- */
  cart.subscribe((snap) => {
    renderCustomer(snap);
    renderLines(snap);
    renderCoupon(snap);
    renderSummary(snap);
  });

  function renderCustomer({ customer }) {
    els.customer.innerHTML = `
      <span class="avatar avatar--sm">${customer ? escapeHtml((customer.name || '?')[0]) : icon('user', { size: 14 })}</span>
      <div class="pos-customer__info">
        <strong>${escapeHtml(customer?.name || 'Walk-in Customer')}</strong>
        <span>${customer?.phone ? escapeHtml(customer.phone) : 'No customer selected'}</span>
      </div>
      <button class="btn btn--ghost btn--sm js-cust-btn">${customer ? 'Change' : 'Add'} (F4)</button>
      ${customer ? '<button class="btn btn--icon btn--ghost btn--sm js-cust-clear">' + icon('x', { size: 14 }) + '</button>' : ''}`;
    els.customer.querySelector('.js-cust-btn').addEventListener('click', pickCustomer);
    els.customer.querySelector('.js-cust-clear')?.addEventListener('click', () => cart.setCustomer(null));
  }

  function renderLines({ lines }) {
    if (!lines.length) {
      els.lines.innerHTML = `<div class="empty-state" style="padding:var(--sp-8) var(--sp-4)">
        <div class="empty-state__icon">${icon('cart', { size: 24 })}</div>
        <h3>Cart is empty</h3><p>Scan a barcode or tap a product to start.</p></div>`;
      return;
    }
    els.lines.innerHTML = lines
      .map((l) => {
        const lineTotal = money.mul(l.unitPrice, l.qty) - lineDiscountValue(l);
        return `<div class="cart-line" data-id="${l.id}">
          <div class="cart-line__name">${escapeHtml(l.name)}${l.variantLabel ? ` · ${escapeHtml(l.variantLabel)}` : ''}</div>
          <div class="cart-line__price">${money.format(lineTotal, { withSymbol: false })}</div>
          <div class="cart-line__meta">
            <span class="mono">${money.format(l.unitPrice, { withSymbol: false })} × ${l.qty}</span>
            ${l.priceOverridden ? '<span class="badge badge--warning">price edited</span>' : ''}
            ${l.discountType ? `<span class="badge badge--brand">−${l.discountType === 'percent' ? l.discountValue + '%' : money.format(money.toMinor(l.discountValue), { withSymbol: false })}</span>` : ''}
            ${l._clamped ? '<span class="badge badge--danger">max stock</span>' : ''}
          </div>
          <div class="cart-line__controls">
            <div class="qty-stepper">
              <button class="js-dec" aria-label="Decrease">−</button>
              <input class="js-qty" type="number" value="${l.qty}" min="1" inputmode="numeric" aria-label="Quantity">
              <button class="js-inc" aria-label="Increase">+</button>
            </div>
            <div class="row">
              ${can('sales.discount.item') ? `<button class="btn btn--icon btn--ghost btn--sm js-line-disc" data-tooltip="Line discount">${icon('percent', { size: 14 })}</button>` : ''}
              ${can('sales.price.override') && settings.pos?.allowPriceOverride !== false ? `<button class="btn btn--icon btn--ghost btn--sm js-line-price" data-tooltip="Edit price">${icon('edit', { size: 14 })}</button>` : ''}
              <button class="cart-line__remove js-remove" aria-label="Remove">${icon('trash', { size: 15 })}</button>
            </div>
          </div>
        </div>`;
      })
      .join('');

    els.lines.querySelectorAll('.cart-line').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.js-dec').addEventListener('click', () => cart.increment(id, -1));
      row.querySelector('.js-inc').addEventListener('click', () => cart.increment(id, 1));
      row.querySelector('.js-qty').addEventListener('change', (e) => cart.setQty(id, Number(e.target.value)));
      row.querySelector('.js-remove').addEventListener('click', () => cart.remove(id));
      row.querySelector('.js-line-disc')?.addEventListener('click', () => editLineDiscount(id));
      row.querySelector('.js-line-price')?.addEventListener('click', () => editLinePrice(id));
    });
  }

  /** Rebuild the Pay button's contents (checkout replaces its innerHTML with a
   *  spinner; without this the button stays stuck on "Processing…" and the
   *  total span is gone). Safe to call any time. */
  function resetPayButton() {
    els.pay.classList.remove('is-loading');
    els.pay.innerHTML = `${icon('credit-card', { size: 18 })} Pay <span class="js-pay-total"></span>`;
    els.payTotal = mount.querySelector('.js-pay-total');
  }

  function renderSummary({ totals }) {
    const t = totals;
    if (!els.payTotal || !els.payTotal.isConnected) resetPayButton();
    els.payTotal.textContent = money.format(t.grandTotal, { withSymbol: false });
    els.pay.disabled = t.totalQty === 0 || submitting;
    const fab = mount.querySelector('.js-cart-fab');
    if (fab) {
      fab.hidden = t.totalQty === 0;
      mount.querySelector('.js-fab-count').textContent = t.totalQty;
      mount.querySelector('.js-fab-total').textContent = money.format(t.grandTotal);
    }
    els.summary.innerHTML = `
      <div class="summary-row"><span>Items</span><span>${t.totalQty}</span></div>
      <div class="summary-row"><span>Subtotal</span><span class="pos-amount">${money.format(t.subtotal)}</span></div>
      ${(t.itemDiscountTotal + t.manualCartDiscount) ? `<div class="summary-row"><span>Discount</span><span class="pos-amount text-danger">−${money.format(t.itemDiscountTotal + t.manualCartDiscount)}</span></div>` : ''}
      ${t.autoDiscount ? `<div class="summary-row"><span>${escapeHtml(t.autoDiscountName || 'Automatic discount')}</span><span class="pos-amount text-danger">−${money.format(t.autoDiscount)}</span></div>` : ''}
      ${t.couponDiscount ? `<div class="summary-row"><span>Coupon ${escapeHtml(t.couponCode || '')}</span><span class="pos-amount text-danger">−${money.format(t.couponDiscount)}</span></div>` : ''}
      ${t.taxLines.map((tl) => `<div class="summary-row"><span>${escapeHtml(tl.name)}${tl.fixed ? '' : ` (${tl.rate}%)`}</span><span class="pos-amount">${money.format(tl.amount)}</span></div>`).join('')}
      <div class="summary-row summary-row--total"><span>Total</span><span class="pos-amount">${money.format(t.grandTotal)}</span></div>`;
  }

  function lineDiscountValue(l) {
    const gross = money.mul(l.unitPrice, l.qty);
    if (l.discountType === 'percent') return Math.min(money.percent(gross, l.discountValue), gross);
    if (l.discountType === 'fixed') return Math.min(money.mul(money.toMinor(l.discountValue), l.qty), gross);
    return 0;
  }

  /* -------- cart actions -------- */
  mount.querySelector('.js-clear').addEventListener('click', async () => {
    if (cart.isEmpty) return;
    if (await confirmDialog({ title: 'Clear the cart?', message: 'All items will be removed from this sale.', confirmLabel: 'Clear', danger: true })) {
      cart.clear();
    }
  });
  mount.querySelector('.js-discount').addEventListener('click', editCartDiscount);
  mount.querySelector('.js-held').addEventListener('click', openHeldSales);
  mount.querySelector('.js-hold')?.addEventListener('click', holdSale);
  els.pay.addEventListener('click', checkout);

  // tablet / mobile: the cart is a bottom sheet - tap the grabber to toggle
  const posEl = () => mount.closest('.pos');
  mount.querySelector('.pos-cart__head').addEventListener('click', (e) => {
    if (window.matchMedia('(max-width: 1024px)').matches && !e.target.closest('button')) {
      posEl()?.classList.toggle('is-cart-open');
    }
  });
  const openSheet = () => posEl()?.classList.add('is-cart-open');
  const closeSheet = () => posEl()?.classList.remove('is-cart-open');
  mount.querySelector('.js-cart-fab').addEventListener('click', openSheet);
  mount.querySelector('.js-sheet-backdrop').addEventListener('click', closeSheet);
  window.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());

  async function pickCustomer() {
    const m = openModal({ title: 'Select Customer', size: 'md', body: `
      <div class="input-search"><span class="input-search__icon">${icon('search', { size: 16 })}</span>
        <input class="input js-cs" placeholder="Search by name or phone…" autocomplete="off"></div>
      <div class="js-cs-results stack" style="--stack-gap:2px;margin-top:var(--sp-3);max-height:320px;overflow:auto"></div>
      <button class="btn btn--subtle btn--block js-cs-new" style="margin-top:var(--sp-3)">${icon('plus', { size: 15 })} New customer</button>` });
    const input = m.$('.js-cs');
    const results = m.$('.js-cs-results');
    const run = debounce(async () => {
      const res = await customerService.getCustomers({ search: input.value.trim(), pageSize: 12 });
      results.innerHTML = (res.data || []).map((c) => `<button class="btn btn--ghost js-pick" data-id="${c.id}" style="justify-content:space-between">
        <span>${escapeHtml(c.name)}</span><span class="muted">${escapeHtml(c.phone || '')}</span></button>`).join('') || '<p class="muted text-sm" style="padding:var(--sp-3)">No matches.</p>';
      results.querySelectorAll('.js-pick').forEach((b) => b.addEventListener('click', async () => {
        const c = (await customerService.getCustomers({ search: '', pageSize: 'all' })).data.find((x) => x.id === b.dataset.id) || (res.data || []).find((x) => x.id === b.dataset.id);
        cart.setCustomer(c);
        m.close();
      }));
    }, 200);
    input.addEventListener('input', run);
    run();
    m.$('.js-cs-new').addEventListener('click', () => {
      m.close();
      newCustomer();
    });
  }

  function newCustomer() {
    const m = openModal({ title: 'New Customer', size: 'sm', body: '<div></div>' });
    createForm(m.$('.modal__body'), {
      fields: [
        { name: 'name', label: 'Name', required: true },
        { name: 'phone', label: 'Phone', type: 'tel', required: true, hint: 'Primary identifier for lookup' },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'address', label: 'Address', type: 'textarea', rows: 2 },
      ],
      layout: 'stack',
      submitLabel: 'Create & select',
      onCancel: () => m.close(),
      onSubmit: async (v) => {
        const c = await customerService.createCustomer(v);
        cart.setCustomer(c);
        m.close();
        toast.success('Customer added');
      },
    });
  }

  function editCartDiscount() {
    const cd = cart.cartDiscount;
    const m = openModal({ title: 'Cart Discount', size: 'sm', body: `
      <div class="stack" style="--stack-gap:var(--sp-3)">
        <div class="segmented" role="group">
          <button data-t="percent" aria-pressed="${cd.type === 'percent'}">${icon('percent', { size: 14 })} Percentage</button>
          <button data-t="fixed" aria-pressed="${cd.type === 'fixed'}">${money.format(0).split(' ')[0]} Fixed amount</button>
        </div>
        <label class="field"><span class="label">Value</span>
          <input class="input js-dv" type="number" step="0.01" min="0" value="${cd.value || ''}" placeholder="0"></label>
        <p class="field-hint">Your role allows up to <strong>${store.get('user')?.discountLimitPct}%</strong>.</p>
      </div>`,
      footer: `<button class="btn btn--ghost js-remove-d">Remove</button><button class="btn btn--primary js-apply-d">Apply</button>` });
    let type = cd.type || 'percent';
    m.$$('.segmented button').forEach((b) => b.addEventListener('click', () => {
      type = b.dataset.t;
      m.$$('.segmented button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    m.$('.js-remove-d').addEventListener('click', () => {
      cart.setCartDiscount(null, 0);
      m.close();
    });
    m.$('.js-apply-d').addEventListener('click', () => {
      const val = Number(m.$('.js-dv').value) || 0;
      if (type === 'percent') {
        const limit = store.get('user')?.discountLimitPct ?? 0;
        if (val > limit && !can('sales.discount.override')) {
          toast.error(`Discount ${val}% exceeds your ${limit}% limit.`);
          return;
        }
      }
      cart.setCartDiscount(type, val);
      m.close();
    });
  }

  function editLineDiscount(lineId) {
    const line = cart.lines.find((l) => l.id === lineId);
    const m = openModal({ title: `Discount — ${line.name}`, size: 'sm', body: `
      <div class="stack" style="--stack-gap:var(--sp-3)">
        <div class="segmented"><button data-t="percent" aria-pressed="${line.discountType === 'percent'}">${icon('percent', { size: 14 })} Percent</button><button data-t="fixed" aria-pressed="${line.discountType === 'fixed'}">${money.format(0).split(' ')[0]} / unit</button></div>
        <input class="input js-v" type="number" step="0.01" min="0" value="${line.discountValue || ''}" placeholder="0">
      </div>`, footer: `<button class="btn btn--ghost js-clr">Clear</button><button class="btn btn--primary js-ok">Apply</button>` });
    let type = line.discountType || 'percent';
    m.$$('.segmented button').forEach((b) => b.addEventListener('click', () => {
      type = b.dataset.t;
      m.$$('.segmented button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    m.$('.js-clr').addEventListener('click', () => {
      cart.setLineDiscount(lineId, null, 0);
      m.close();
    });
    m.$('.js-ok').addEventListener('click', () => {
      cart.setLineDiscount(lineId, type, Number(m.$('.js-v').value) || 0);
      m.close();
    });
  }

  function editLinePrice(lineId) {
    const line = cart.lines.find((l) => l.id === lineId);
    const m = openModal({ title: `Edit price — ${line.name}`, size: 'sm', body: `
      <label class="field"><span class="label">Unit price (list ${money.format(line.listPrice)})</span>
      <input class="input js-p" type="number" step="0.01" min="0" value="${money.toMajor(line.unitPrice)}"></label>`,
      footer: `<button class="btn btn--ghost js-reset">Reset to list</button><button class="btn btn--primary js-ok">Apply</button>` });
    m.$('.js-reset').addEventListener('click', () => {
      cart.setPrice(lineId, line.listPrice);
      m.close();
    });
    m.$('.js-ok').addEventListener('click', () => {
      cart.setPrice(lineId, money.toMinor(m.$('.js-p').value));
      m.close();
    });
  }

  async function holdSale() {
    if (cart.isEmpty) {
      toast.warning('Nothing to hold.');
      return;
    }
    try {
      const draft = cart.toDraft();
      await salesService.holdSale({ ...draft, label: cart.customer?.name || `Hold ${new Date().toLocaleTimeString()}`, customerName: cart.customer?.name, grandTotal: cart.compute().grandTotal });
      toast.success('Sale held');
      cart.clear();
      focusBarcode();
    } catch (err) {
      toast.fromError(err);
    }
  }

  async function openHeldSales() {
    const m = openModal({ title: 'Held Sales', size: 'md', body: '<div class="loading-block"><span class="spinner"></span></div>' });
    try {
      const res = await salesService.getHeldSales();
      const list = res.data || [];
      m.setBody(list.length ? `<div class="held-list">${list.map((h) => `
        <div class="held-card" data-id="${h.id}">
          <div><strong>${escapeHtml(h.label)}</strong><br><span class="muted text-sm">${h.items.length} items · ${money.format(h.grandTotal)} · ${new Date(h.createdAt).toLocaleString()}</span></div>
          <div class="row">
            <button class="btn btn--sm btn--primary js-resume">Resume</button>
            <button class="btn btn--icon btn--sm btn--ghost js-drop">${icon('trash', { size: 14 })}</button>
          </div>
        </div>`).join('')}</div>` : `<div class="empty-state"><div class="empty-state__icon">${icon('inbox', { size: 22 })}</div><h3>No held sales</h3></div>`);
      m.$$('.held-card').forEach((card) => {
        card.querySelector('.js-resume').addEventListener('click', async () => {
          const held = list.find((x) => x.id === card.dataset.id);
          if (!cart.isEmpty && !(await confirmDialog({ title: 'Replace current cart?', message: 'Resuming a held sale will replace the current cart.', confirmLabel: 'Replace' }))) return;
          cart.loadFromHeld(held, products);
          m.close();
          focusBarcode();
        });
        card.querySelector('.js-drop').addEventListener('click', async () => {
          await salesService.deleteHeldSale(card.dataset.id);
          card.remove();
        });
      });
    } catch (err) {
      m.setBody(`<p class="text-danger">${escapeHtml(err.message)}</p>`);
    }
  }

  /* -------- checkout -------- */
  async function checkout() {
    if (submitting || cart.isEmpty) return;
    const totals = cart.compute();

    if (settings.pos?.requireOpenRegister) {
      // quick check via service; onNeedRegister lets shell open the register modal
      const { cashRegisterService } = await import('../../services/cash-register-service.js');
      const current = await cashRegisterService.getCurrent().catch(() => null);
      if (!current) {
        onNeedRegister?.();
        return;
      }
    }

    const payments = await openPayment({ total: totals.grandTotal, customer: cart.customer });
    if (!payments) return;

    submitting = true;
    els.pay.classList.add('is-loading');
    els.pay.innerHTML = `<span class="spinner spinner--invert"></span> Processing…`;

    const idempotencyKey = uuid();
    try {
      const sale = await checkoutMutex(() =>
        salesService.createSale({ ...cart.toDraft(), payments }, { idempotencyKey }),
      );
      bus.emit('pos:sale-completed', sale);
      await onSaleComplete(sale);
    } catch (err) {
      if (err.queued) {
        toast.warning('Network lost — sale queued for synchronization. It will complete automatically when you reconnect.', { duration: 8000 });
        cart.clear();
      } else {
        toast.error(err?.data?.message || err.message || 'The sale could not be completed. No changes were saved.', { duration: 7000 });
      }
    } finally {
      submitting = false;
      resetPayButton();
      renderSummary(cart.snapshot());
      focusBarcode();
    }
  }

  async function onSaleComplete(sale) {
    const change = sale.changeTotal || 0;
    toast.success(`${sale.invoiceNo} completed${change ? ` · change ${money.format(change)}` : ''}`, { duration: 3500 });
    cart.clear();
    closeSheet();

    const doPrint = settings.pos?.printAfterSale;
    const m = openModal({
      title: 'Sale Complete',
      size: 'sm',
      dismissible: true,
      body: `<div class="stack" style="--stack-gap:var(--sp-3);text-align:center">
        <span style="color:var(--success-solid)">${icon('check-circle', { size: 40 })}</span>
        <div><div class="strong" style="font-size:var(--fs-xl)">${money.format(sale.grandTotal)}</div>
        <p class="muted">${escapeHtml(sale.invoiceNo)}${change ? ` · Change ${money.format(change)}` : ''}</p></div>
      </div>`,
      footer: `<button class="btn btn--ghost js-next">Next Sale (Esc)</button>
        <button class="btn btn--outline js-print">${icon('print', { size: 15 })} Print</button>
        <button class="btn btn--primary js-email" hidden>Email</button>`,
    });
    m.$('.js-next').addEventListener('click', () => m.close());
    m.$('.js-print').addEventListener('click', () => reprint(sale));
    if (doPrint) setTimeout(() => reprint(sale), 150);
    m.el.addEventListener('keydown', (e) => e.key === 'Enter' && m.close());
  }

  async function reprint(sale) {
    const full = sale.items ? sale : await salesService.getSaleById(sale.id);
    const s = await settingsService.getSettings();
    printHtml(buildReceipt(full, { settings: s }));
  }

  /* -------- helpers -------- */
  function focusBarcode() {
    if (settings.pos?.autoFocusBarcode !== false) setTimeout(() => els.barcode.focus(), 30);
  }
  function flashPay() {
    els.pay.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }], { duration: 220 });
  }

  /* -------- keyboard shortcuts -------- */
  const shortcuts = (e) => {
    if (e.target?.matches?.('input, textarea, select') && !['F1', 'F2', 'F4', 'F8', 'F9'].includes(e.key)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    switch (e.key) {
      case 'F1': e.preventDefault(); els.search.focus(); els.search.select(); break;
      case 'F2': e.preventDefault(); els.barcode.focus(); break;
      case 'F4': e.preventDefault(); pickCustomer(); break;
      case 'F8': e.preventDefault(); if (can('sales.hold')) holdSale(); break;
      case 'F9': e.preventDefault(); checkout(); break;
      default:
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          checkout();
        }
    }
  };
  document.addEventListener('keydown', shortcuts);

  focusBarcode();

  return {
    destroy() {
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('keydown', onGlobalKey, true);
      clearTimeout(burstTimer);
    },
    cart,
    refresh: loadProducts,
  };
}

async function cameraScan(onResult) {
  if (!('BarcodeDetector' in window)) {
    toast.info('Camera scanning is not supported in this browser. Use a USB scanner into the barcode field.');
    return;
  }
  const m = openModal({ title: 'Scan Barcode', size: 'sm', body: `<video class="js-video" autoplay playsinline muted style="width:100%;border-radius:var(--radius-md);background:#000"></video><p class="muted text-sm" style="margin-top:var(--sp-2)">Point the camera at a barcode.</p>` });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = m.$('.js-video');
    video.srcObject = stream;
    const detector = new window.BarcodeDetector();
    const tick = async () => {
      if (!document.body.contains(video)) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          onResult(codes[0].rawValue);
          m.close();
          return;
        }
      } catch { /* frame not ready */ }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    m.setBody(`<p class="text-danger">Could not access the camera: ${escapeHtml(err.message)}</p>`);
  }
  const origClose = m.close;
  m.el.closest('.overlay').addEventListener('transitionend', () => stream?.getTracks().forEach((t) => t.stop()), { once: true });
}

export default renderPOS;
