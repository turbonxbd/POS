/**
 * settings.js - business, POS, inventory, receipt, notification, security & print
 * settings. Persisted through settingsService -> PUT /settings.
 *
 * Settings -> Print is the ONE place that controls the physical print output for
 * both the invoice/receipt (js/pages/shared/receipt.js) and barcode pages
 * (js/pages/shared/barcode-label.js), resolved by js/core/print-config.js.
 */
import { pageShell } from '../shared/page-kit.js';
import { icon } from '../../components/icons.js';
import { escapeHtml } from '../../utils/dom.js';
import { blockLoader } from '../../components/skeleton.js';
import { toast } from '../../components/toast.js';
import { debounce } from '../../utils/debounce.js';
import { printHtml } from '../../utils/print.js';
import money from '../../utils/money.js';
import settingsService from '../../services/settings-service.js';
import taxService from '../../services/tax-service.js';
import { mediaService } from '../../services/media-service.js';
import bus from '../../core/event-bus.js';
import store from '../../core/store.js';
import {
  DEFAULT_INVOICE, DEFAULT_BARCODE, UNITS, STOCK_TYPES, ORIENTATIONS, orientationToDeg,
  invoiceConfig, barcodeConfig, resolveSize, SAMPLE_SALE, SAMPLE_LABEL_ITEMS,
} from '../../core/print-config.js';
import { buildReceipt } from '../shared/receipt.js';
import { buildBarcodePages } from '../shared/barcode-label.js';

const SECTIONS = [
  { id: 'business', label: 'Business', icon: 'building' },
  { id: 'pos', label: 'POS', icon: 'pos' },
  { id: 'inventory', label: 'Inventory', icon: 'warehouse' },
  { id: 'receipt', label: 'Receipt & Invoice', icon: 'receipt' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'print', label: 'Print', icon: 'print' },
];

export default async function settingsPage(ctx, mount) {
  mount.innerHTML = blockLoader('Loading settings…');
  const [settings, taxRes] = await Promise.all([
    settingsService.getSettings({ fresh: true }),
    taxService.getTaxes({ pageSize: 'all' }),
  ]);
  const taxes = taxRes.data || taxRes;
  const draft = structuredClone(settings);
  // Always give the Print editor a complete value set (migrates legacy receipt.*).
  draft.print = { invoice: invoiceConfig(settings), barcode: barcodeConfig(settings) };
  let active = ctx.query.section || 'business';
  let printTab = 'invoice';

  const shell = pageShell(mount, { title: 'Settings', subtitle: 'Configure how the POS works for your business.' });
  shell.body.innerHTML = `<div class="settings-layout">
    <nav class="settings-nav">
      ${SECTIONS.map((s) => `<button data-s="${s.id}" class="${s.id === active ? 'is-active' : ''}">${icon(s.icon, { size: 16 })} ${s.label}</button>`).join('')}
    </nav>
    <div id="settings-panel"></div>
  </div>`;

  shell.body.querySelectorAll('.settings-nav button').forEach((b) =>
    b.addEventListener('click', () => {
      active = b.dataset.s;
      shell.body.querySelectorAll('.settings-nav button').forEach((x) => x.classList.toggle('is-active', x === b));
      renderPanel();
    }),
  );

  function set(path, value) {
    const parts = path.split('.');
    let o = draft;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ||= {};
    o[parts[parts.length - 1]] = value;
  }
  function get(path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), draft);
  }

  /* ---- control builders ---- */
  function field(label, path, control, hint) {
    return `<label class="field"><span class="label">${escapeHtml(label)}</span>${control}${hint ? `<span class="field-hint">${escapeHtml(hint)}</span>` : ''}</label>`;
  }
  const text = (path, val, extra = '') => `<input class="input js-f" data-p="${path}" value="${escapeHtml(val ?? '')}" ${extra}>`;
  const numI = (path, val, extra = '') => `<input class="input js-f" type="number" data-p="${path}" value="${val ?? 0}" ${extra}>`;
  const sw = (path, val, label) => `<label class="switch"><input type="checkbox" class="js-f" data-p="${path}" data-bool="1" ${val ? 'checked' : ''}><span class="switch__track"><span class="switch__thumb"></span></span><span>${escapeHtml(label)}</span></label>`;
  const sel = (path, val, opts, attrs = '') => `<select class="select js-f" data-p="${path}" ${attrs}>${opts.map((o) => `<option value="${o.value}" ${String(o.value) === String(val) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
  const area = (path, val, rows = 3) => `<textarea class="textarea js-f" data-p="${path}" rows="${rows}">${escapeHtml(val || '')}</textarea>`;
  const togGrid = (pairs) => `<div class="tog-grid">${pairs.map(([p, l]) => sw(p, get(p), l)).join('')}</div>`;

  function bindFields(scope, after) {
    scope.querySelectorAll('.js-f').forEach((el) => {
      el.addEventListener('change', () => {
        const path = el.dataset.p;
        let val = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.money) val = money.toMinor(el.value);
        else if (el.type === 'number') val = Number(el.value);
        set(path, val);
        after?.(path);
      });
    });
  }

  function renderPanel() {
    const p = shell.body.querySelector('#settings-panel');
    if (active === 'print') return renderPrintPanel(p);

    let html = '<div class="card card--pad stack" style="--stack-gap:var(--sp-4)">';
    const b = draft.business || {};
    const pos = draft.pos || {};
    const inv = draft.inventory || {};
    const nt = draft.notifications || {};
    const sec = draft.security || {};

    if (active === 'business') {
      const logoUrl = b.logoId ? mediaService.getUrl(b.logoId) : null;
      html += `<div class="form-section-title">Business identity</div>
        <div class="row" style="gap:var(--sp-4);align-items:center">
          ${logoUrl ? `<img class="thumb thumb--lg" src="${logoUrl}" alt="">` : `<div class="thumb thumb--lg thumb-placeholder">${escapeHtml((b.name || 'A')[0])}</div>`}
          <label class="btn btn--outline btn--sm">Upload logo<input type="file" accept="image/*" hidden id="logo-input"></label>
          ${logoUrl ? '<button class="btn btn--ghost btn--sm" id="logo-remove">Remove</button>' : ''}
        </div>
        <div class="field-grid">
          ${field('Business name', 'business.name', text('business.name', b.name), null)}
          ${field('Legal name', 'business.legalName', text('business.legalName', b.legalName))}
          ${field('Phone', 'business.phone', text('business.phone', b.phone))}
          ${field('Email', 'business.email', text('business.email', b.email))}
          ${field('Website', 'business.website', text('business.website', b.website))}
          ${field('VAT / BIN number', 'business.vatNo', text('business.vatNo', b.vatNo))}
          ${field('Invoice prefix', 'business.invoicePrefix', text('business.invoicePrefix', b.invoicePrefix))}
          ${field('Currency', 'business.currency', sel('business.currency', b.currency || 'BDT', [{ value: 'BDT', label: 'Bangladeshi Taka (৳)' }, { value: 'USD', label: 'US Dollar ($)' }, { value: 'INR', label: 'Indian Rupee (₹)' }]), 'Applies on next reload')}
        </div>
        ${field('Address', 'business.address', area('business.address', b.address, 2))}`;
    }

    if (active === 'pos') {
      html += `<div class="form-section-title">Checkout behaviour</div>
        <div class="field-grid">
          ${field('Invoice number template', 'pos.invoiceTemplate', text('pos.invoiceTemplate', pos.invoiceTemplate), 'Tokens: {PREFIX} {BR} {SEQ} {YY} {MM}')}
          ${field('Default tax for new products', 'pos.defaultTaxId', sel('pos.defaultTaxId', pos.defaultTaxId || '', [{ value: '', label: 'None' }, ...taxes.map((t) => ({ value: t.id, label: `${t.name} (${t.rate}%)` }))]))}
          ${field('Hold sale limit', 'pos.holdSaleLimit', numI('pos.holdSaleLimit', pos.holdSaleLimit, 'min="1"'))}
          ${field('Loyalty points per ৳', 'pos.loyaltyPerCurrency', numI('pos.loyaltyPerCurrency', pos.loyaltyPerCurrency, 'step="0.01" min="0"'), 'Points a customer earns per ৳1 spent')}
          ${field('৳ per point on redeem', 'pos.loyaltyRedeemValue', numI('pos.loyaltyRedeemValue', pos.loyaltyRedeemValue ?? 1, 'step="0.01" min="0"'), '0 = redemption off')}
          ${field('Minimum points to redeem', 'pos.loyaltyMinRedeem', numI('pos.loyaltyMinRedeem', pos.loyaltyMinRedeem, 'min="0"'))}
        </div>
        ${sw('pos.printAfterSale', pos.printAfterSale, 'Automatically print a receipt after each sale')}
        ${sw('pos.autoFocusBarcode', pos.autoFocusBarcode, 'Auto-focus the barcode field between scans')}
        ${sw('pos.requireOpenRegister', pos.requireOpenRegister, 'Require an open cash register to sell')}
        ${sw('pos.blindClose', pos.blindClose, 'Blind register close — cashier counts the drawer without seeing the expected amount')}
        ${sw('pos.allowPriceOverride', pos.allowPriceOverride, 'Allow price override at the till (with permission)')}
        ${sw('pos.showProductImages', pos.showProductImages, 'Show product images in the POS grid')}
        <p class="field-hint">Invoice paper size, spacing, logo and visible fields are all in <strong>Settings → Print → Invoice</strong>.</p>`;
    }

    if (active === 'inventory') {
      html += `<div class="form-section-title">Stock rules</div>
        ${sw('inventory.allowNegativeStock', inv.allowNegativeStock, 'Allow selling below zero stock (negative stock)')}
        ${sw('inventory.autoReorderAlerts', inv.autoReorderAlerts, 'Create low-stock notifications automatically')}
        <div class="field-grid">
          ${field('Global low-stock threshold', 'inventory.lowStockThreshold', numI('inventory.lowStockThreshold', inv.lowStockThreshold, 'min="0"'), 'Used when a product has no minimum set')}
          ${field('Valuation method', 'inventory.valuationMethod', sel('inventory.valuationMethod', inv.valuationMethod || 'moving_average', [{ value: 'moving_average', label: 'Moving average cost' }, { value: 'fifo', label: 'FIFO (planned)' }]))}
        </div>`;
    }

    if (active === 'receipt') {
      const iv = draft.print.invoice;
      html += `<div class="form-section-title">Receipt content</div>
        <p class="muted text-sm">Full invoice customisation with a live preview is in <strong>Settings → Print → Invoice</strong>. These quick toggles stay in sync.</p>
        <div class="field-grid">
          ${field('Header text', 'print.invoice.headerText', text('print.invoice.headerText', iv.headerText))}
        </div>
        ${field('Footer text', 'print.invoice.footerText', area('print.invoice.footerText', iv.footerText, 3), 'Shown at the bottom of every receipt')}
        ${sw('print.invoice.showLogo', iv.showLogo, 'Show business logo')}
        ${sw('print.invoice.showCashier', iv.showCashier, 'Show cashier name')}
        ${sw('print.invoice.showInvoiceBarcode', iv.showInvoiceBarcode, 'Print invoice barcode')}
        ${sw('print.invoice.showTaxBreakdown', iv.showTaxBreakdown, 'Show tax breakdown by rate')}`;
    }

    if (active === 'notifications') {
      html += `<div class="form-section-title">Alert me about</div>
        ${sw('notifications.lowStock', nt.lowStock, 'Low stock & out of stock')}
        ${sw('notifications.newSale', nt.newSale, 'Every new sale')}
        ${sw('notifications.refund', nt.refund, 'Refunds & returns')}
        ${sw('notifications.purchaseReceived', nt.purchaseReceived, 'Stock received against purchases')}
        ${sw('notifications.registerClose', nt.registerClose, 'Register closing with a difference')}`;
    }

    if (active === 'security') {
      html += `<div class="form-section-title">Access & session</div>
        <div class="field-grid">
          ${field('Idle sign-out (minutes)', 'security.sessionIdleTimeoutMin', numI('security.sessionIdleTimeoutMin', sec.sessionIdleTimeoutMin, 'min="1"'))}
        </div>
        ${sw('security.requirePinForRefund', sec.requirePinForRefund, 'Require manager approval for refunds')}
        ${sw('security.requirePinForDiscount', sec.requirePinForDiscount, 'Require manager approval for over-limit discounts')}
        <div class="alert alert--info"><div class="alert__body">Password hashing, rate limiting, CSRF and secure sessions are enforced by the backend. This frontend never stores secrets.</div></div>`;
    }

    html += `<div class="form-actions"><button class="btn btn--primary" id="save-settings">Save changes</button></div></div>`;
    p.innerHTML = html;

    bindFields(p);
    p.querySelector('#save-settings').addEventListener('click', save);
    p.querySelector('#logo-input')?.addEventListener('change', async (e) => {
      try {
        const { id } = await mediaService.upload(e.target.files[0]);
        set('business.logoId', id);
        renderPanel();
      } catch (err) { toast.fromError(err); }
    });
    p.querySelector('#logo-remove')?.addEventListener('click', () => {
      set('business.logoId', null);
      renderPanel();
    });
  }

  /* ================================================= PRINT panel ============ */

  function renderPrintPanel(host) {
    host.innerHTML = `<div class="card card--pad print-pane">
      <div class="print-pane__head">
        <div class="segmented" id="print-subtabs" role="tablist">
          <button data-t="invoice" aria-pressed="${printTab === 'invoice'}">Invoice</button>
          <button data-t="barcode" aria-pressed="${printTab === 'barcode'}">Barcode</button>
        </div>
        <div class="print-pane__actions">
          <button class="btn btn--outline btn--sm" id="print-test">${icon('print', { size: 14 })} <span class="js-test-label"></span></button>
          <button class="btn btn--ghost btn--sm" id="print-reset"><span class="js-reset-label"></span></button>
          <button class="btn btn--primary btn--sm" id="print-save">Save print settings</button>
        </div>
      </div>
      <div class="print-pane__grid">
        <div class="print-pane__controls" id="print-controls"></div>
        <aside class="print-pane__preview">
          <div class="print-pane__preview-meta" id="preview-meta"></div>
          <div class="print-pane__preview-frame" id="preview-frame">
            <div class="print-pane__preview-scale" id="preview-scale"></div>
          </div>
        </aside>
      </div>
    </div>`;

    host.querySelectorAll('#print-subtabs button').forEach((btn) =>
      btn.addEventListener('click', () => {
        printTab = btn.dataset.t;
        host.querySelectorAll('#print-subtabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
        updateActionLabels();
        renderControls();
        refreshPreview();
      }),
    );
    host.querySelector('#print-save').addEventListener('click', save);
    host.querySelector('#print-test').addEventListener('click', testPrint);
    host.querySelector('#print-reset').addEventListener('click', resetSection);

    updateActionLabels();
    renderControls();
    refreshPreview();
  }

  function updateActionLabels() {
    const host = shell.body.querySelector('#settings-panel');
    if (!host) return;
    host.querySelector('.js-test-label').textContent = printTab === 'invoice' ? 'Test print' : 'Test barcode print';
    host.querySelector('.js-reset-label').textContent = printTab === 'invoice' ? 'Reset' : 'Reset';
  }

  function renderControls() {
    const c = shell.body.querySelector('#print-controls');
    c.innerHTML = printTab === 'invoice' ? invoiceControls() : barcodeControls();
    bindFields(c, () => schedulePreview());
    c.querySelectorAll('[data-rerender]').forEach((el) =>
      el.addEventListener('change', () => { renderControls(); refreshPreview(); }),
    );
    // Stock type drives the auto/fixed page height; keep them in step.
    c.querySelector('#inv-stock-type')?.addEventListener('change', (e) => {
      set('print.invoice.stockType', e.target.value);
      set('print.invoice.pageHeightAuto', e.target.value === 'continuous-variable');
      renderControls(); refreshPreview();
    });
    c.querySelector('#bc-stock-type')?.addEventListener('change', (e) => {
      set('print.barcode.stockType', e.target.value);
      set('print.barcode.pageHeightAuto', e.target.value === 'continuous-variable');
      renderControls(); refreshPreview();
    });
    // Orientation is the friendly control; keep printRotation (degrees) in step.
    c.querySelector('#bc-orientation')?.addEventListener('change', (e) => {
      set('print.barcode.orientation', e.target.value);
      set('print.barcode.printRotation', orientationToDeg(e.target.value));
      refreshPreview();
    });
    c.querySelector('#inv-orientation')?.addEventListener('change', (e) => {
      set('print.invoice.orientation', e.target.value);
      set('print.invoice.printRotation', orientationToDeg(e.target.value));
      refreshPreview();
    });
    // invoice logo upload / replace / remove (shares business.logoId)
    c.querySelector('#inv-logo-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const { id } = await mediaService.upload(file);
        set('business.logoId', id);
        set('print.invoice.showLogo', true);
        renderControls();
        refreshPreview();
      } catch (err) { toast.fromError(err); }
    });
    c.querySelector('#inv-logo-remove')?.addEventListener('click', () => {
      set('business.logoId', null);
      renderControls();
      refreshPreview();
    });
  }

  /* ---- Invoice controls ---- */
  function invoiceControls() {
    const iv = draft.print.invoice;
    const b = draft.business || {};
    const logoUrl = b.logoId ? mediaService.getUrl(b.logoId) : null;
    const mm = (p, l, extra = 'min="0" step="0.5"') => field(l, `print.invoice.${p}`, numI(`print.invoice.${p}`, iv[p], extra));
    const sz = resolveSize(iv);
    const u = iv.unit === 'in' ? 'in' : 'mm';
    return `
      <div class="form-section-title">Stock — match your printer driver</div>
      <p class="field-hint">Open the printer's <strong>Printing Preferences → Stock</strong> and copy the same <strong>Type</strong>, <strong>size</strong> and <strong>Exposed Liner Widths</strong> here. Invoice and Barcode are independent — they never share a value.</p>
      <div class="field-grid">
        ${field('Type', 'print.invoice.stockType', `<select class="select" id="inv-stock-type">${STOCK_TYPES.map((o) => `<option value="${o.value}" ${o.value === (iv.stockType || 'continuous-variable') ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`)}
        ${field('Unit', 'print.invoice.unit', sel('print.invoice.unit', iv.unit, UNITS, 'data-rerender'))}
      </div>
      <div class="field-grid">
        ${field(`Width (${u})`, 'print.invoice.pageWidth', numI('print.invoice.pageWidth', iv.pageWidth, `min="${u === 'in' ? '0.5' : '10'}" step="0.1"`))}
        ${field(`Max length (${u})`, 'print.invoice.pageHeight', numI('print.invoice.pageHeight', iv.pageHeight, `min="${u === 'in' ? '0.5' : '10'}" step="0.1"`))}
      </div>
      <div class="field-grid">
        ${field(`Exposed liner — left (${u})`, 'print.invoice.linerLeft', numI('print.invoice.linerLeft', iv.linerLeft ?? 0, 'min="0" step="0.01"'))}
        ${field(`Exposed liner — right (${u})`, 'print.invoice.linerRight', numI('print.invoice.linerRight', iv.linerRight ?? 0, 'min="0" step="0.01"'))}
      </div>
      ${field('Orientation', 'print.invoice.orientation', `<select class="select" id="inv-orientation">${ORIENTATIONS.map((o) => `<option value="${o.value}" ${o.value === (iv.orientation || 'portrait') ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`)}
      <p class="field-hint"><strong>Rotate in one place only.</strong> If the printer driver is set to "Portrait 180", leave this on <strong>Portrait</strong>. If the driver is plain Portrait and the receipt prints upside down, set this to <strong>Portrait 180°</strong>. 180 in both = upside down. 90°/270° need a fixed height (Continuous&nbsp;Fixed or Die-Cut).</p>
      ${sw('print.invoice.pageHeightAuto', iv.pageHeightAuto, 'Auto height — grow to fit content (on for Continuous / Variable Length)')}
      <p class="field-hint">Print page targets <strong>${sz.w}${sz.unit} × ${iv.pageHeightAuto ? 'auto' : sz.h + sz.unit}</strong> (${sz.wMm.toFixed(1)} mm wide) at 100% / actual size. In the browser print dialog set <strong>Scale 100%</strong>, <strong>Margins: None</strong>, headers/footers off.</p>

      <div class="form-section-title">Spacing</div>
      <div class="field-grid">
        ${mm('marginTop', 'Top (mm)')}
        ${mm('marginBottom', 'Bottom (mm)')}
        ${mm('marginLeft', 'Left (mm)')}
        ${mm('marginRight', 'Right (mm)')}
      </div>
      <div class="field-grid">
        ${mm('gapHeader', 'After header (mm)')}
        ${mm('gapImage', 'After logo (mm)')}
        ${mm('gapInfo', 'After invoice info (mm)')}
        ${mm('gapTable', 'After product table (mm)')}
        ${mm('gapTotals', 'After totals (mm)')}
        ${mm('gapFooter', 'Before footer (mm)')}
        ${field('Font size (px)', 'print.invoice.fontSize', numI('print.invoice.fontSize', iv.fontSize, 'min="7" max="20" step="0.5"'))}
        ${field('Line height', 'print.invoice.lineHeight', numI('print.invoice.lineHeight', iv.lineHeight, 'min="1" max="2.2" step="0.05"'))}
      </div>

      <div class="form-section-title">Image / logo</div>
      ${sw('print.invoice.showLogo', iv.showLogo, 'Show image / logo on the invoice')}
      <div class="row" style="gap:var(--sp-3);align-items:center;flex-wrap:wrap">
        ${logoUrl ? `<img src="${logoUrl}" alt="" style="width:56px;height:56px;object-fit:contain;background:var(--bg-inset);border-radius:var(--radius-sm)">` : '<div class="thumb thumb-placeholder">—</div>'}
        <label class="btn btn--outline btn--sm">${logoUrl ? 'Replace image' : 'Upload image'}<input type="file" accept="image/*" hidden id="inv-logo-input"></label>
        ${logoUrl ? '<button type="button" class="btn btn--ghost btn--sm" id="inv-logo-remove">Remove image</button>' : ''}
      </div>
      <div class="field-grid">
        ${mm('logoWidthMm', 'Image width (mm)')}
        ${mm('logoHeightMm', 'Image height (mm, 0 = auto)')}
        ${field('Position', 'print.invoice.logoAlign', sel('print.invoice.logoAlign', iv.logoAlign, [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]))}
      </div>
      ${sw('print.invoice.logoKeepAspect', iv.logoKeepAspect, 'Keep aspect ratio (no distortion)')}

      <div class="form-section-title">Header</div>
      ${field('Header text (overrides business name)', 'print.invoice.headerText', text('print.invoice.headerText', iv.headerText))}
      ${togGrid([
        ['print.invoice.showBusinessName', 'Business name'],
        ['print.invoice.showAddress', 'Address'],
        ['print.invoice.showPhone', 'Phone'],
        ['print.invoice.showEmail', 'Email'],
        ['print.invoice.showBin', 'BIN / VAT'],
      ])}

      <div class="form-section-title">Invoice info</div>
      ${togGrid([
        ['print.invoice.showInvoiceNo', 'Invoice number'],
        ['print.invoice.showDate', 'Date'],
        ['print.invoice.showTime', 'Time'],
        ['print.invoice.showCustomer', 'Customer'],
        ['print.invoice.showCustomerPhone', 'Customer phone'],
        ['print.invoice.showCashier', 'Cashier'],
      ])}

      <div class="form-section-title">Product table</div>
      ${togGrid([
        ['print.invoice.showItemName', 'Product name'],
        ['print.invoice.showQty', 'Quantity'],
        ['print.invoice.showPrice', 'Price'],
        ['print.invoice.showLineDiscount', 'Discount'],
        ['print.invoice.showLineTotal', 'Line total'],
      ])}

      <div class="form-section-title">Totals</div>
      ${togGrid([
        ['print.invoice.showSubtotal', 'Subtotal'],
        ['print.invoice.showDiscount', 'Discount'],
        ['print.invoice.showTax', 'Tax'],
        ['print.invoice.showTaxBreakdown', 'Tax breakdown'],
        ['print.invoice.showGrandTotal', 'Grand total'],
        ['print.invoice.showPaid', 'Paid'],
        ['print.invoice.showChange', 'Change'],
        ['print.invoice.showDue', 'Due'],
        ['print.invoice.showPaymentMethod', 'Payment method'],
      ])}

      <div class="form-section-title">Footer</div>
      ${sw('print.invoice.showFooter', iv.showFooter, 'Show footer text')}
      ${sw('print.invoice.showInvoiceBarcode', iv.showInvoiceBarcode, 'Show invoice barcode')}
      ${field('Footer text', 'print.invoice.footerText', area('print.invoice.footerText', iv.footerText, 3))}`;
  }

  /* ---- Barcode controls ---- */
  function barcodeControls() {
    const bc = draft.print.barcode;
    const mm = (p, l, extra = 'min="0" step="0.5"') => field(l, `print.barcode.${p}`, numI(`print.barcode.${p}`, bc[p], extra));
    const px = (p, l) => field(l + ' (px)', `print.barcode.${p}`, numI(`print.barcode.${p}`, bc[p], 'min="5" max="28" step="0.5"'));
    const sz = resolveSize(bc);
    const u = bc.unit === 'in' ? 'in' : 'mm';
    return `
      <div class="alert alert--info" style="margin-bottom:var(--sp-3)"><div class="alert__body">
        <strong>One barcode = one page.</strong> Always on. 10 barcodes → 10 separate pages.
        These settings are fully separate from the Invoice tab.
      </div></div>

      <div class="form-section-title">Stock — match your printer driver</div>
      <p class="field-hint">Copy the printer's <strong>Printing Preferences → Stock</strong>: same <strong>Type</strong>, <strong>Label Size</strong> and <strong>Exposed Liner Widths</strong>. For "BARCODE L" that is Die-Cut Labels, 1.5 × 1.0 in, liner 0.08 in each side.</p>
      <div class="field-grid">
        ${field('Type', 'print.barcode.stockType', `<select class="select" id="bc-stock-type">${STOCK_TYPES.map((o) => `<option value="${o.value}" ${o.value === (bc.stockType || 'die-cut') ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`)}
        ${field('Unit', 'print.barcode.unit', sel('print.barcode.unit', bc.unit, UNITS, 'data-rerender'))}
      </div>
      <div class="field-grid">
        ${field(`Label width (${u})`, 'print.barcode.pageWidth', numI('print.barcode.pageWidth', bc.pageWidth, `min="${u === 'in' ? '0.2' : '5'}" step="0.1"`))}
        ${field(`Label height (${u})`, 'print.barcode.pageHeight', numI('print.barcode.pageHeight', bc.pageHeight, `min="${u === 'in' ? '0.2' : '5'}" step="0.1"`))}
      </div>
      <div class="field-grid">
        ${field(`Exposed liner — left (${u})`, 'print.barcode.linerLeft', numI('print.barcode.linerLeft', bc.linerLeft ?? 0, 'min="0" step="0.01"'))}
        ${field(`Exposed liner — right (${u})`, 'print.barcode.linerRight', numI('print.barcode.linerRight', bc.linerRight ?? 0, 'min="0" step="0.01"'))}
        ${field(`Gap between labels (${u})`, 'print.barcode.labelGap', numI('print.barcode.labelGap', bc.labelGap ?? 0, 'min="0" step="0.01"'))}
      </div>
      <p class="field-hint">Every barcode page targets <strong>${sz.w}${sz.unit} × ${sz.h}${sz.unit}</strong> (${sz.wMm.toFixed(1)} × ${sz.hMm.toFixed(1)} mm), plus a <strong>${(Number(bc.labelGap) || 0)}${u}</strong> blank gap below each label. The liner is kept clear on both sides so the bars never touch the die-cut edge.</p>
      <p class="field-hint"><strong>Gap between labels</strong> = the blank strip you measure between two stickers. It keeps a multi-label run registered when the printer feeds continuously. Set 0 only if the driver is in Die-Cut / gap-sensor mode and re-reads every label.</p>

      <div class="form-section-title">Barcode size</div>
      <div class="field-grid">
        ${mm('barcodeWidthMm', 'Barcode width (mm)', 'min="8" step="0.5"')}
        ${mm('barcodeHeightMm', 'Barcode height (mm)', 'min="3" max="60" step="0.5"')}
      </div>
      <p class="field-hint">The bars scale to the target width; the height is kept exactly, so the code never distorts. It is clamped to fit the printable area.</p>

      <div class="form-section-title">Content</div>
      <p class="field-hint">Sticker order, top to bottom: <strong>Brand → Product name → Color | Size | Variant → Barcode → Number → Price</strong>.</p>
      ${togGrid([
        ['print.barcode.showBrand', 'Show Brand'],
        ['print.barcode.showBusinessName', 'Business name'],
        ['print.barcode.showProductName', 'Product name'],
        ['print.barcode.showColor', 'Show Color'],
        ['print.barcode.showSize', 'Show Size'],
        ['print.barcode.showVariant', 'Show Variant'],
        ['print.barcode.showSku', 'SKU'],
        ['print.barcode.showBarcode', 'Barcode'],
        ['print.barcode.showBarcodeNumber', 'Barcode number'],
        ['print.barcode.showPrice', 'Selling price'],
        ['print.barcode.showCustomText', 'Custom text'],
      ])}
      ${sw('print.barcode.showMrp', bc.showMrp, 'Show MRP & Selling Price  (struck MRP then the selling price, e.g. ৳520  ৳500)')}
      <p class="field-hint">Color / Size / Variant only appear when the product actually has that attribute.</p>
      ${bc.showCustomText ? field('Custom text', 'print.barcode.customText', text('print.barcode.customText', bc.customText)) : ''}
      <div class="field-grid">
        ${px('brandNameSize', 'Brand name')}
        ${px('productNameSize', 'Product name')}
        ${px('businessNameSize', 'Business name')}
        ${px('attrSize', 'Attributes')}
        ${px('numberSize', 'Number / SKU')}
        ${px('priceSize', 'Price')}
        ${px('mrpSize', 'MRP')}
      </div>

      <div class="form-section-title">Spacing</div>
      <div class="field-grid">
        ${mm('marginTop', 'Top (mm)')}
        ${mm('marginBottom', 'Bottom (mm)')}
        ${mm('marginLeft', 'Left (mm)')}
        ${mm('marginRight', 'Right (mm)')}
      </div>
      <div class="field-grid">
        ${mm('gapName', 'After name (mm)')}
        ${mm('gapBarcode', 'After name/SKU before barcode (mm)')}
        ${mm('gapNumber', 'After barcode (mm)')}
        ${mm('gapPrice', 'After number (mm)')}
      </div>

      <div class="form-section-title">Position</div>
      ${field('Alignment', 'print.barcode.align', sel('print.barcode.align', bc.align, [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' }]))}
      ${field('Orientation', 'print.barcode.orientation', `<select class="select" id="bc-orientation">${ORIENTATIONS.map((o) => `<option value="${o.value}" ${o.value === (bc.orientation || 'portrait') ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`)}
      <p class="field-hint"><strong>Rotate in one place only — not two.</strong> If the printer driver's own Orientation is set to "Portrait 180", leave this on <strong>Portrait</strong> (the driver does the flip). If the driver is on plain Portrait and the label prints upside down, set this to <strong>Portrait 180°</strong> instead. Setting 180 in both makes the label read bottom-to-top. Affects the physical print only, never this preview.</p>`;
  }

  /* ---- preview ---- */
  const schedulePreview = debounce(() => refreshPreview(), 160);

  function refreshPreview() {
    const scale = shell.body.querySelector('#preview-scale');
    const meta = shell.body.querySelector('#preview-meta');
    if (!scale) return;
    let html;
    if (printTab === 'invoice') {
      const sz = resolveSize(draft.print.invoice);
      html = buildReceipt(SAMPLE_SALE, { settings: draft });
      meta.textContent = `Live preview · ${sz.w}${sz.unit} wide${draft.print.invoice.pageHeightAuto ? ' · auto height' : ' × ' + sz.h + sz.unit} · sample data`;
    } else {
      const sz = resolveSize(draft.print.barcode);
      html = buildBarcodePages([SAMPLE_LABEL_ITEMS[0]], { settings: draft });
      meta.textContent = `Live preview · ${sz.w}${sz.unit} × ${sz.h}${sz.unit} · 1 barcode = 1 page · sample data`;
    }
    scale.innerHTML = html;
    fitPreview();
  }

  function fitPreview() {
    const frame = shell.body.querySelector('#preview-frame');
    const scale = shell.body.querySelector('#preview-scale');
    if (!frame || !scale) return;
    scale.style.transform = 'scale(1)';
    const content = scale.querySelector('.receipt-preview, .bc-run, .bc-page');
    const cw = content?.getBoundingClientRect().width || 0;
    const fw = frame.clientWidth || 0;
    const k = cw > 0 && fw > 0 ? Math.min(1, (fw - 4) / cw) : 1;
    scale.style.transform = `scale(${k})`;
    scale.style.transformOrigin = 'top left';
    scale.style.height = content ? `${content.getBoundingClientRect().height * k}px` : 'auto';
  }

  /* ---- actions ---- */
  function resetSection() {
    if (printTab === 'invoice') draft.print.invoice = structuredClone(DEFAULT_INVOICE);
    else draft.print.barcode = structuredClone(DEFAULT_BARCODE);
    renderControls();
    refreshPreview();
    toast.info(`${printTab === 'invoice' ? 'Invoice' : 'Barcode'} print settings reset — Save to apply.`);
  }

  function testPrint() {
    if (printTab === 'invoice') {
      printHtml(buildReceipt(SAMPLE_SALE, { settings: draft }));
    } else {
      // 3 distinct sample barcodes -> 3 separate pages
      printHtml(buildBarcodePages(SAMPLE_LABEL_ITEMS.map((x) => ({ ...x, qty: 1 })), { settings: draft }));
    }
    toast.info('Test print uses sample data — no sale, invoice or stock change.');
  }

  /* ---- save ---- */
  async function save() {
    // keep the legacy receipt.* mirror so any old code path still reads sane values
    draft.receipt = {
      ...(draft.receipt || {}),
      header: draft.print.invoice.headerText,
      footer: draft.print.invoice.footerText,
      showLogo: draft.print.invoice.showLogo,
      showCashier: draft.print.invoice.showCashier,
      showBarcode: draft.print.invoice.showInvoiceBarcode,
      showTaxBreakdown: draft.print.invoice.showTaxBreakdown,
    };

    const btn = shell.body.querySelector('#save-settings, #print-save');
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.innerHTML = '<span class="spinner spinner--invert"></span> Saving…'; }
    try {
      await settingsService.updateSettings(draft);
      // the server mirrors settings.business onto the businesses + merchants
      // rows; reflect that in the running session so every panel shows the
      // same name/details without a reload.
      if (draft.business) {
        store.set({ business: { ...(store.get('business') || {}), ...draft.business } });
        bus.emit('business:changed', store.get('business'));
      }
      bus.emit('settings:changed', draft);
      toast.success('Settings saved');
    } catch (err) {
      toast.fromError(err);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || 'Save changes'; }
    }
  }

  renderPanel();
}
