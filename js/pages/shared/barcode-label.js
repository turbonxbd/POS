/**
 * barcode-label.js - printable barcode pages.
 *
 * ONE barcode == ONE physical page, always. `buildBarcodePages([...], {settings})`
 * emits a scoped <style> with a real @page rule at the configured Width x Height
 * (mm | in) plus one <div class="bc-page"> per barcode (expanded by item.qty).
 * N barcodes -> N pages. No grid, no blank pages.
 *
 * All geometry comes from settings.print.barcode.* via barcodeConfig().
 */
import { escapeHtml } from '../../utils/dom.js';
import money from '../../utils/money.js';
import { renderBarcode } from '../../components/barcode.js';
import { barcodeConfig, resolveSize, clamp, toMm } from '../../core/print-config.js';
import store from '../../core/store.js';

const MM_PX = 96 / 25.4; // CSS reference px per mm

/** Exposed-liner widths in mm (driver field), resolved in the page's unit. */
function linerMm(cfg) {
  return {
    left: Math.max(0, toMm(Number(cfg.linerLeft) || 0, cfg.unit)),
    right: Math.max(0, toMm(Number(cfg.linerRight) || 0, cfg.unit)),
  };
}

/** One barcode page's inner content (the stacked elements). */
export function renderBarcodeCard(item, cfg, { bizName = '' } = {}) {
  const sz = resolveSize(cfg);
  const lnr = linerMm(cfg);
  const innerWmm = Math.max(2, sz.wMm - cfg.marginLeft - cfg.marginRight - lnr.left - lnr.right);
  const innerHmm = Math.max(2, sz.hMm - cfg.marginTop - cfg.marginBottom);

  // barcode symbol: honour configured width/height, but never exceed the printable area
  const barHmm = clamp(cfg.barcodeHeightMm, 3, innerHmm);
  const barWmm = clamp(cfg.barcodeWidthMm, 8, innerWmm);
  let moduleWidthPx = 0.33 * MM_PX;
  const probe = renderBarcode(item.barcode || '00000000', { height: barHmm * MM_PX, moduleWidth: moduleWidthPx, showText: false, quiet: 2 });
  const probeW = Number(/width="([\d.]+)"/.exec(probe)?.[1] || 0);
  if (probeW > 0) moduleWidthPx *= (barWmm * MM_PX) / probeW; // scale to the target width, no distortion (height stays)

  // fixed TOP -> BOTTOM order
  const parts = [];

  // 1. Brand name
  if (cfg.showBrand && item.brandName) parts.push(`<div class="bc-l bc-brand" style="font-size:${cfg.brandNameSize}px;margin-bottom:${cfg.gapName}mm">${escapeHtml(item.brandName)}</div>`);
  // (optional) business name
  if (cfg.showBusinessName && bizName) parts.push(`<div class="bc-l bc-biz" style="font-size:${cfg.businessNameSize}px;margin-bottom:${cfg.gapName}mm">${escapeHtml(bizName)}</div>`);
  // 2. Product name
  if (cfg.showProductName && item.name) parts.push(`<div class="bc-l bc-name" style="font-size:${cfg.productNameSize}px;margin-bottom:${cfg.gapName}mm">${escapeHtml(item.name)}</div>`);
  // 3. Attributes: Color | Size | Variant  (only enabled + present)
  const a = item.attributes || {};
  const attrBits = [
    cfg.showColor && a.color,
    cfg.showSize && a.size,
    cfg.showVariant && a.variant,
  ].filter(Boolean).map((s) => escapeHtml(String(s)));
  if (attrBits.length) parts.push(`<div class="bc-l bc-attrs" style="font-size:${cfg.attrSize}px;margin-bottom:${cfg.gapBarcode}mm">${attrBits.join(' <span class="bc-attrs__sep">|</span> ')}</div>`);
  // (optional) SKU
  if (cfg.showSku && item.sku) parts.push(`<div class="bc-l bc-sku" style="font-size:${cfg.numberSize}px;margin-bottom:${cfg.gapBarcode}mm">${escapeHtml(item.sku)}</div>`);
  // 4. Barcode graphic
  if (cfg.showBarcode) parts.push(`<div class="bc-l bc-bars" style="margin-bottom:${cfg.gapNumber}mm">${renderBarcode(item.barcode || '00000000', { height: barHmm * MM_PX, moduleWidth: moduleWidthPx, showText: false, quiet: 2 })}</div>`);
  // 5. Barcode number
  if (cfg.showBarcodeNumber && item.barcode) parts.push(`<div class="bc-l bc-num" style="font-size:${cfg.numberSize}px;margin-bottom:${cfg.gapPrice}mm">${escapeHtml(item.barcode)}</div>`);
  // 6. Price: struck MRP + selling price
  const hasMrp = cfg.showMrp && item.mrp != null && Number(item.mrp) > Number(item.sellingPrice || 0);
  if ((cfg.showPrice || hasMrp) && item.sellingPrice != null) {
    const mrpBit = hasMrp
      ? `<s class="bc-mrp" style="font-size:${cfg.mrpSize}px">${money.format(item.mrp)}</s> `
      : '';
    parts.push(`<div class="bc-l bc-price" style="font-size:${cfg.priceSize}px">${mrpBit}<span class="bc-sell">${money.format(item.sellingPrice)}</span></div>`);
  }
  // (optional) custom text
  if (cfg.showCustomText && cfg.customText) parts.push(`<div class="bc-l bc-custom" style="font-size:${cfg.businessNameSize}px">${escapeHtml(cfg.customText)}</div>`);

  return `<div class="bc-stack">${parts.join('')}</div>`;
}

function style(cfg, sz) {
  const alignItems = { left: 'flex-start', center: 'center', right: 'flex-end' }[cfg.align] || 'center';
  const textAlign = cfg.align || 'center';
  const barsJustify = alignItems === 'flex-start' ? 'flex-start' : alignItems === 'flex-end' ? 'flex-end' : 'center';

  // Physical print rotation (0 | 90 | 180 | 270). Screen preview is NEVER rotated.
  // The printed @page ALWAYS stays the configured physical label size - the label
  // printer feeds a fixed pitch, so a swapped page size drifts across the die-cut
  // gaps. For 90/270 the .bc-canvas is laid out at swapped dimensions and rotated
  // inside the fixed page instead.
  const rot = [0, 90, 180, 270].includes(Number(cfg.printRotation)) ? Number(cfg.printRotation) : 0;
  const quarter = rot === 90 || rot === 270;
  const canvasW = quarter ? sz.h : sz.w; // pre-rotation canvas width (merchant unit)
  const canvasH = quarter ? sz.w : sz.h; // pre-rotation canvas height
  const rotCss = rot ? `transform: rotate(${rot}deg);` : '';

  // Continuous (Variable Length) stock: the label grows down the roll to fit
  // the content, so emit an auto page height. Die-Cut / Fixed keep the exact
  // physical size. Auto is ignored under a 90/270 turn (undefined geometry).
  const auto = !!cfg.pageHeightAuto && !quarter;
  const pageSize = auto ? `${sz.w}${sz.unit} auto` : `${sz.w}${sz.unit} ${sz.h}${sz.unit}`;
  const pageHeightCss = auto ? `min-height: ${sz.h}${sz.unit}; height: auto;` : `height: ${sz.h}${sz.unit};`;

  // Exposed liner widths fold into the canvas's horizontal padding so the bars
  // never ride the die-cut edge (matches the driver's "Exposed Liner Widths").
  const lnr = linerMm(cfg);
  const padLeft = (Number(cfg.marginLeft) || 0) + lnr.left;
  const padRight = (Number(cfg.marginRight) || 0) + lnr.right;

  return `<style>
    /* Real physical label size. Never auto-converted to A4 / Letter, never swapped. */
    @page { size: ${pageSize}; margin: 0; }

    /* ---- shared (screen preview keeps the label upright, unrotated) ---- */
    .bc-run { width: ${sz.w}${sz.unit}; margin: 0 auto; }
    .bc-page {
      box-sizing: border-box; overflow: hidden; background: #fff; color: #000;
      width: ${sz.w}${sz.unit}; ${pageHeightCss}
      margin: 0 auto;
      /* frame only - centres the label canvas on both axes */
      display: flex; align-items: center; justify-content: center;
      break-inside: avoid; page-break-inside: avoid;
    }
    /* .bc-canvas carries the actual label geometry (margins + stacked content).
       It is the element that gets rotated for the physical print. */
    .bc-canvas {
      box-sizing: border-box;
      width: ${sz.w}${sz.unit}; ${pageHeightCss}
      padding: ${cfg.marginTop}mm ${padRight}mm ${cfg.marginBottom}mm ${padLeft}mm;
      display: flex; flex-direction: column;
      align-items: ${alignItems}; justify-content: center;
    }
    .bc-stack { display: flex; flex-direction: column; align-items: ${alignItems}; text-align: ${textAlign}; width: 100%; max-width: 100%; }
    .bc-stack .bc-l { width: 100%; line-height: 1.1; }
    .bc-stack .bc-brand { font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
    .bc-stack .bc-name { font-weight: 600; }
    .bc-stack .bc-attrs { font-weight: 500; letter-spacing: 0.2px; }
    .bc-stack .bc-attrs__sep { opacity: 0.55; margin: 0 1px; }
    .bc-stack .bc-price { font-weight: 700; }
    .bc-stack .bc-mrp { font-weight: 400; opacity: 0.8; text-decoration: line-through; }
    .bc-stack .bc-sell { font-weight: 700; }
    .bc-stack .bc-num { font-family: var(--font-mono, monospace); letter-spacing: 0.3px; }
    .bc-stack svg { max-width: 100%; height: auto; display: block; }
    .bc-stack .bc-bars { display: flex; justify-content: ${barsJustify}; width: 100%; }

    @media print {
      html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
      .bc-run { width: ${sz.w}${sz.unit}; margin: 0 auto !important; }
      /* .bc-page is the exact printed label. .bc-canvas holds the content at its
         layout dimensions (swapped for a 90/270 turn) and is rotated + clipped
         inside the fixed page so nothing bleeds onto the next physical label. */
      .bc-page {
        width: ${sz.w}${sz.unit}; ${pageHeightCss}
        margin: 0 auto; overflow: hidden;
      }
      /* Break AFTER every label except the last -> exactly N pages, no trailing
         blank page. 1 barcode = 1 page, strict. */
      .bc-page:not(:last-child) { break-after: page; page-break-after: always; }
      .bc-page:last-child { break-after: auto; page-break-after: auto; }
      .bc-canvas {
        width: ${canvasW}${sz.unit}; ${auto ? 'min-height: ' + canvasH + sz.unit + '; height: auto;' : 'height: ' + canvasH + sz.unit + ';'}
        overflow: hidden;
        transform-origin: center center; ${rotCss}
      }
    }
  </style>`;
}

/** One printable page: a .bc-page frame wrapping the rotatable .bc-canvas.
 * data-fit-* carry the printed canvas size + margins in mm so the print step can
 * shrink content that would overflow the physical label (rotation-independent). */
function page(item, cfg, ctx) {
  const sz = resolveSize(cfg);
  const quarter = Number(cfg.printRotation) === 90 || Number(cfg.printRotation) === 270;
  const fitW = quarter ? sz.hMm : sz.wMm;
  const fitH = quarter ? sz.wMm : sz.hMm;
  const pad = [cfg.marginTop, cfg.marginRight, cfg.marginBottom, cfg.marginLeft].map((n) => Number(n) || 0).join('|');
  return `<div class="bc-page"><div class="bc-canvas" data-fit-w="${fitW}" data-fit-h="${fitH}" data-fit-pad="${pad}">${renderBarcodeCard(item, cfg, ctx)}</div></div>`;
}

function expand(items) {
  const out = [];
  for (const it of items) {
    const q = Math.max(1, Math.floor(Number(it.qty) || 1));
    for (let i = 0; i < q; i++) out.push(it);
  }
  return out;
}

/** buildBarcodePages(items, { settings, bizName }) -> full print HTML, one page per barcode. */
export function buildBarcodePages(items, { settings = {}, cfg, bizName } = {}) {
  cfg = cfg || barcodeConfig(settings);
  bizName = bizName ?? (settings.business?.name || store.get('business')?.name || '');
  const sz = resolveSize(cfg);
  const flat = expand(items);
  if (!flat.length) return `${style(cfg, sz)}<div class="bc-run"></div>`;
  const pages = flat.map((it) => page(it, cfg, { bizName })).join('');
  return `${style(cfg, sz)}<div class="bc-run">${pages}</div>`;
}

/** One page at real size for the settings / generator preview. */
export function buildSingleLabel(item, { settings = {}, cfg, bizName } = {}) {
  cfg = cfg || barcodeConfig(settings);
  bizName = bizName ?? (settings.business?.name || store.get('business')?.name || '');
  const sz = resolveSize(cfg);
  return `${style(cfg, sz)}<div class="bc-run">${page(item, cfg, { bizName })}</div>`;
}

// back-compat alias
export const buildLabelSheet = buildBarcodePages;

export default buildBarcodePages;
