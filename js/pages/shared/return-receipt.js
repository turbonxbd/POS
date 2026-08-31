/**
 * return-receipt.js - printable Exchange / Return receipt.
 *
 * Reuses the invoice print configuration (page size, margins, spacing, font)
 * from settings.print.invoice so it prints on the same paper as a normal
 * receipt - no second printing system.
 */
import { escapeHtml } from '../../utils/dom.js';
import money from '../../utils/money.js';
import { fmtDate, fmtTime } from '../../utils/date.js';
import { renderBarcode } from '../../components/barcode.js';
import store from '../../core/store.js';
import { invoiceConfig, resolveSize } from '../../core/print-config.js';

/**
 * buildReturnReceipt(ret, { sale, settings }) -> scoped <style> + markup.
 * `ret` is the sale_returns doc; `sale` (optional) the decorated original sale.
 */
export function buildReturnReceipt(ret, { sale = null, settings = {} } = {}) {
  const cfg = invoiceConfig(settings);
  const sz = resolveSize(cfg);
  const biz = settings.business || store.get('business') || {};
  const isExchange = ret.type === 'exchange';
  const n = (v) => money.format(v, { withSymbol: false });
  const row = (label, value, strong) =>
    `<div class="rc-row${strong ? ' rc-row--strong' : ''}"><span>${escapeHtml(label)}</span><span class="rc-num">${value}</span></div>`;

  const auto = cfg.pageHeightAuto || Number(cfg.pageHeight) <= 0;
  const pageSize = auto ? `${sz.w}${sz.unit} auto` : `${sz.w}${sz.unit} ${sz.h}${sz.unit}`;

  const retLines = (ret.items || []).map((it) => `<tr>
    <td class="rc-item">${escapeHtml(it.name)}</td><td class="rc-num">${it.qty}</td><td class="rc-num">${n(it.refund)}</td></tr>`).join('');
  const repLines = (ret.replacementItems || []).map((it) => `<tr>
    <td class="rc-item">${escapeHtml(it.name)}</td><td class="rc-num">${it.qty}</td><td class="rc-num">${n(it.lineTotal)}</td></tr>`).join('');

  const style = `<style>
    @page { size: ${pageSize}; margin: 0; }
    .receipt-preview.inv-doc {
      box-sizing: border-box; width: ${sz.w}${sz.unit}; ${auto ? '' : `min-height:${sz.h}${sz.unit};`}
      margin: 0 auto;
      padding: ${cfg.marginTop}mm ${cfg.marginRight}mm ${cfg.marginBottom}mm ${cfg.marginLeft}mm;
      background:#fff; color:#000; font-family: var(--font-mono, monospace);
      font-size:${cfg.fontSize}px; line-height:${cfg.lineHeight};
    }
    .inv-doc .rc, .inv-doc .rc * { color:#000; }
    .inv-doc .rc-title { text-align:center; font-weight:700; font-size:1.2em; }
    .inv-doc .rc-header { text-align:center; margin-bottom:${cfg.gapHeader}mm; }
    .inv-doc .rc-biz { font-weight:700; font-size:1.1em; }
    .inv-doc .rc-sec { margin:${cfg.gapInfo}mm 0 1mm; font-weight:700; border-top:1px dashed #000; padding-top:1mm; }
    .inv-doc .rc-row { display:flex; justify-content:space-between; gap:3mm; }
    .inv-doc .rc-row--strong { font-weight:700; }
    .inv-doc .rc-num { text-align:right; font-variant-numeric:tabular-nums; }
    .inv-doc table { width:100%; border-collapse:collapse; }
    .inv-doc tr { break-inside:avoid; page-break-inside:avoid; }
    .inv-doc th, .inv-doc td { padding:0.7mm 0; text-align:left; font-size:0.95em; }
    .inv-doc thead th { border-bottom:1px solid #000; font-size:0.85em; }
    .inv-doc .rc-item { padding-right:2mm; }
    .inv-doc .rc-grand { font-weight:700; font-size:1.12em; border-top:1px solid #000; border-bottom:1px solid #000; padding:1mm 0; margin:1mm 0; }
    .inv-doc .rc-foot { text-align:center; margin-top:${cfg.gapFooter}mm; font-size:0.9em; }
    .inv-doc .rc-barcode { text-align:center; margin-top:${cfg.gapFooter}mm; }
    @media print { .receipt-preview.inv-doc { box-shadow:none !important; margin:0 auto !important; ${auto ? 'min-height:auto;' : ''} } }
  </style>`;

  return `${style}<div class="receipt-preview inv-doc"><div class="rc">
    <div class="rc-header">
      ${cfg.showBusinessName ? `<div class="rc-biz">${escapeHtml(cfg.headerText || biz.name || 'TX Demo')}</div>` : ''}
      ${biz.phone ? `<div>Tel: ${escapeHtml(biz.phone)}</div>` : ''}
    </div>
    <div class="rc-title">${isExchange ? 'EXCHANGE RECEIPT' : 'RETURN RECEIPT'}</div>

    <div class="rc-sec">Original Sale</div>
    ${row('Invoice', escapeHtml(ret.invoiceNo))}
    ${row('Date', fmtDate(ret.at) + ' ' + fmtTime(ret.at))}
    ${row(isExchange ? 'Exchange ref' : 'Return ref', escapeHtml(ret.reference))}
    ${row('Customer', escapeHtml(ret.customerName || sale?.customerName || 'Walk-in Customer'))}
    ${row('Cashier', escapeHtml(ret.cashierName || '—'))}
    ${row('Branch', escapeHtml(sale?.branchName || biz.name || '—'))}

    <div class="rc-sec">Returned Products</div>
    <table><thead><tr><th>Item</th><th class="rc-num">Qty</th><th class="rc-num">Value</th></tr></thead><tbody>${retLines}</tbody></table>
    ${row('Reason', escapeHtml(String(ret.reason || '').replace(/_/g, ' ')))}
    ${row('Returned value', n(ret.returnRefund), true)}

    ${isExchange ? `<div class="rc-sec">Replacement Products</div>
    <table><thead><tr><th>Item</th><th class="rc-num">Qty</th><th class="rc-num">Price</th></tr></thead><tbody>${repLines}</tbody></table>
    ${row('Replacement value', n(ret.replacementTotal), true)}
    <div class="rc-row rc-grand"><span>${ret.difference > 0 ? 'CUSTOMER PAID' : ret.difference < 0 ? 'REFUNDED' : 'NO DIFFERENCE'}</span><span class="rc-num">${money.format(Math.abs(ret.difference), { withSymbol: true })}</span></div>
    ${ret.difference !== 0 ? row('Method', escapeHtml(ret.refundMethod)) : ''}`
    : `<div class="rc-row rc-grand"><span>REFUND</span><span class="rc-num">${money.format(ret.refundTotal, { withSymbol: true })}</span></div>
    ${row('Method', escapeHtml(ret.refundMethod))}`}

    <div class="rc-foot">Keep this receipt for your records.</div>
    <div class="rc-barcode">${renderBarcode(ret.reference, { height: 34, moduleWidth: 1.1, showText: true })}</div>
  </div></div>`;
}

export default buildReturnReceipt;
