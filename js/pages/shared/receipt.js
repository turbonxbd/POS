/**
 * receipt.js - build the printable invoice / receipt for a sale.
 *
 * Page size, spacing, logo and every visible field come from
 * settings.print.invoice.* (resolved by invoiceConfig()). Whatever width/height
 * the merchant configures is emitted as a real @page rule, so the print page IS
 * that physical size - never auto-converted to A4 / Letter.
 *
 * buildReceipt(sale, { settings }) -> scoped <style> + .receipt-preview markup.
 */
import { escapeHtml } from '../../utils/dom.js';
import money from '../../utils/money.js';
import { fmtDate, fmtTime } from '../../utils/date.js';
import { renderBarcode } from '../../components/barcode.js';
import { mediaService } from '../../services/media-service.js';
import store from '../../core/store.js';
import { invoiceConfig, resolveSize, toMm } from '../../core/print-config.js';

export function buildReceipt(sale, { settings = {} } = {}) {
  const cfg = invoiceConfig(settings);
  const sz = resolveSize(cfg);
  const items = sale.items || [];
  const biz = settings.business || store.get('business') || {};
  const logoUrl = cfg.showLogo && biz.logoId ? mediaService.getUrl(biz.logoId) : null;

  const n = (v) => money.format(v, { withSymbol: false });
  const row = (label, value, strong) =>
    `<div class="rc-row${strong ? ' rc-row--strong' : ''}"><span>${escapeHtml(label)}</span><span class="rc-num">${value}</span></div>`;

  /* ---- logo / image ---- */
  const logo = logoUrl
    ? `<div class="rc-logo rc-logo--${cfg.logoAlign}"><img src="${logoUrl}" alt="" style="${logoStyle(cfg)}"></div>`
    : '';

  /* ---- header ---- */
  const bizMetaLines = [
    cfg.showAddress && biz.address ? escapeHtml(biz.address) : '',
    cfg.showPhone && biz.phone ? 'Tel: ' + escapeHtml(biz.phone) : '',
    cfg.showEmail && biz.email ? escapeHtml(biz.email) : '',
    cfg.showBin && biz.vatNo ? 'BIN: ' + escapeHtml(biz.vatNo) : '',
  ].filter(Boolean).join('<br>');
  const header = `<div class="rc-header">
    ${cfg.showBusinessName ? `<div class="rc-biz">${escapeHtml(cfg.headerText || biz.name || 'TX Demo')}</div>` : ''}
    ${bizMetaLines ? `<div class="rc-meta">${bizMetaLines}</div>` : ''}
  </div>`;

  /* ---- invoice info ---- */
  const info = `<div class="rc-info">
    ${cfg.showInvoiceNo ? row('Invoice', escapeHtml(sale.invoiceNo)) : ''}
    ${cfg.showDate ? row('Date', fmtDate(sale.createdAt) + (cfg.showTime ? ' ' + fmtTime(sale.createdAt) : '')) : (cfg.showTime ? row('Time', fmtTime(sale.createdAt)) : '')}
    ${cfg.showCashier ? row('Cashier', escapeHtml(sale.cashierName || '—')) : ''}
    ${cfg.showCustomer ? row('Customer', escapeHtml(sale.customerName || 'Walk-in Customer')) : ''}
    ${cfg.showCustomerPhone && sale.customerPhone ? row('Phone', escapeHtml(sale.customerPhone)) : ''}
  </div>`;

  /* ---- product table ---- */
  const cols = [cfg.showQty && 'Qty', cfg.showPrice && 'Price', cfg.showLineDiscount && 'Disc', cfg.showLineTotal && 'Total'].filter(Boolean);
  const itemRows = items.map((it) => `<tr>
    <td class="rc-item">${cfg.showItemName ? escapeHtml(it.name) : ''}${it.variantLabel ? `<br><small>${escapeHtml(it.variantLabel)}</small>` : ''}</td>
    ${cfg.showQty ? `<td class="rc-num">${it.qty}</td>` : ''}
    ${cfg.showPrice ? `<td class="rc-num">${n(it.unitPrice)}</td>` : ''}
    ${cfg.showLineDiscount ? `<td class="rc-num">${n(it.discountTotal || 0)}</td>` : ''}
    ${cfg.showLineTotal ? `<td class="rc-num">${n(it.lineTotal)}</td>` : ''}
  </tr>`).join('');
  const table = `<table class="rc-table">
    <thead><tr><th>Item</th>${cols.map((c) => `<th class="rc-num">${c}</th>`).join('')}</tr></thead>
    <tbody>${itemRows}</tbody>
  </table>`;

  /* ---- totals ---- */
  const taxRows = (sale.taxLines || []).map((t) => row(t.fixed ? t.name : `${t.name} (${t.rate}%)`, n(t.amount))).join('');
  const payRows = cfg.showPaymentMethod
    ? (sale.payments || []).map((p) => row(methodLabel(p.method), n(p.amount))).join('')
    : '';
  const totals = `<div class="rc-totals">
    ${cfg.showSubtotal ? row('Subtotal', n(sale.subtotal)) : ''}
    ${cfg.showDiscount && sale.discountTotal ? row('Discount', '-' + n(sale.discountTotal)) : ''}
    ${cfg.showTax ? (cfg.showTaxBreakdown && taxRows ? taxRows : row('Tax', n(sale.taxTotal))) : ''}
    ${cfg.showGrandTotal ? `<div class="rc-row rc-grand"><span>TOTAL</span><span class="rc-num">${money.format(sale.grandTotal, { withSymbol: true })}</span></div>` : ''}
    ${cfg.showPaid ? payRows : ''}
    ${cfg.showChange && sale.changeTotal ? row('Change', n(sale.changeTotal), true) : ''}
    ${cfg.showDue && sale.dueTotal ? row('Amount Due', n(sale.dueTotal), true) : ''}
  </div>`;

  /* ---- footer ---- */
  const footer = cfg.showFooter && cfg.footerText
    ? `<div class="rc-footer">${escapeHtml(cfg.footerText).replace(/\n/g, '<br>')}</div>`
    : '';
  const barcode = cfg.showInvoiceBarcode
    ? `<div class="rc-barcode">${renderBarcode(sale.invoiceNo, { height: 38, moduleWidth: 1.2, showText: true })}</div>`
    : '';

  return `${style(cfg, sz)}<div class="receipt-preview inv-doc"><div class="rc">
    ${logo}${header}${info}${table}${totals}${footer}${barcode}
  </div></div>`;
}

/* ------------------------------------------------------------ style */

function logoStyle(cfg) {
  const s = [`max-width:${cfg.logoWidthMm}mm`];
  if (cfg.logoWidthMm > 0) s.push(`width:${cfg.logoWidthMm}mm`);
  if (cfg.logoHeightMm > 0 && !cfg.logoKeepAspect) s.push(`height:${cfg.logoHeightMm}mm`);
  else if (cfg.logoHeightMm > 0) s.push(`max-height:${cfg.logoHeightMm}mm`);
  s.push('height:auto', 'object-fit:contain');
  return s.join(';');
}

function style(cfg, sz) {
  const auto = cfg.pageHeightAuto || Number(cfg.pageHeight) <= 0;
  // Physical print rotation (0 | 90 | 180 | 270) - mirrors the driver's
  // Orientation. Screen preview is NEVER rotated. 180 (printer feeds flipped)
  // works at any height; 90/270 need a fixed height and swap the @page.
  const rot = [0, 90, 180, 270].includes(Number(cfg.printRotation)) ? Number(cfg.printRotation) : 0;
  const quarter = (rot === 90 || rot === 270) && !auto;
  const pageW = quarter ? `${sz.h}${sz.unit}` : `${sz.w}${sz.unit}`;
  const pageH = auto ? 'auto' : `${quarter ? sz.w : sz.h}${sz.unit}`;
  const pageSize = `${pageW} ${pageH}`;
  const rotCss = rot ? `transform: rotate(${rot}deg); transform-origin: center center;` : '';
  // 90/270 swap the box itself (in print only) to match the swapped @page, then
  // rotate it - the rotated footprint lands back on the physical page exactly.
  const quarterCss = quarter ? `width: ${sz.h}${sz.unit} !important; min-height: ${sz.w}${sz.unit} !important;` : '';
  // Exposed liner widths (driver field) fold into the horizontal padding.
  const padLeft = (Number(cfg.marginLeft) || 0) + Math.max(0, toMm(Number(cfg.linerLeft) || 0, cfg.unit));
  const padRight = (Number(cfg.marginRight) || 0) + Math.max(0, toMm(Number(cfg.linerRight) || 0, cfg.unit));
  return `<style>
    @page { size: ${pageSize}; margin: 0; }
    .receipt-preview.inv-doc {
      box-sizing: border-box;
      width: ${sz.w}${sz.unit};
      ${auto ? '' : `min-height: ${sz.h}${sz.unit};`}
      margin: 0 auto;
      padding: ${cfg.marginTop}mm ${padRight}mm ${cfg.marginBottom}mm ${padLeft}mm;
      background: #fff; color: #000;
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: ${cfg.fontSize}px; line-height: ${cfg.lineHeight};
    }
    .inv-doc .rc, .inv-doc .rc * { color: #000; }
    .inv-doc .rc-logo { display: flex; margin-bottom: ${cfg.gapImage}mm; }
    .inv-doc .rc-logo--left { justify-content: flex-start; }
    .inv-doc .rc-logo--center { justify-content: center; }
    .inv-doc .rc-logo--right { justify-content: flex-end; }
    .inv-doc .rc-header { text-align: center; margin-bottom: ${cfg.gapHeader}mm; }
    .inv-doc .rc-biz { font-weight: 700; font-size: 1.25em; }
    .inv-doc .rc-meta { font-size: 0.88em; line-height: 1.3; }
    .inv-doc .rc-info { margin-bottom: ${cfg.gapInfo}mm; padding-top: ${cfg.gapHeader}mm; border-top: 1px dashed #000; }
    .inv-doc .rc-row { display: flex; justify-content: space-between; gap: 3mm; }
    .inv-doc .rc-row--strong { font-weight: 700; }
    .inv-doc .rc-num { text-align: right; font-variant-numeric: tabular-nums; }
    .inv-doc .rc-table { width: 100%; border-collapse: collapse; margin-bottom: ${cfg.gapTable}mm;
      border-top: 1px dashed #000; border-bottom: 1px dashed #000; }
    .inv-doc .rc-table tr { break-inside: avoid; page-break-inside: avoid; }
    .inv-doc .rc-grand { break-inside: avoid; page-break-inside: avoid; }
    .inv-doc .rc-table th { text-align: left; font-size: 0.85em; padding: 1mm 0; border-bottom: 1px solid #000; }
    .inv-doc .rc-table td { padding: 0.9mm 0; vertical-align: top; }
    .inv-doc .rc-item { padding-right: 2mm; }
    .inv-doc .rc-totals { margin-bottom: ${cfg.gapTotals}mm; }
    .inv-doc .rc-grand { font-weight: 700; font-size: 1.12em; border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 1mm 0; margin: 1mm 0; }
    .inv-doc .rc-footer { text-align: center; margin-top: ${cfg.gapFooter}mm; font-size: 0.9em; }
    .inv-doc .rc-barcode { text-align: center; margin-top: ${cfg.gapFooter}mm; }
    .inv-doc .rc-barcode svg { max-width: 100%; height: auto; }
    @media print {
      .receipt-preview.inv-doc { box-shadow: none !important; margin: 0 auto !important; ${auto ? 'min-height:auto;' : ''} ${rotCss} ${quarterCss} }
    }
  </style>`;
}

function methodLabel(m) {
  return { cash: 'Cash', card: 'Card', mobile: 'Mobile Banking', bank_transfer: 'Bank Transfer', account: 'On Account' }[m] || m;
}

export default buildReceipt;
