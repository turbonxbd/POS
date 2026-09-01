/**
 * print-config.js - the ONE centralized print configuration.
 *
 * Everything printable reads its layout from settings.print.invoice.* and
 * settings.print.barcode.* through invoiceConfig() / barcodeConfig(). Legacy
 * settings.receipt.* / settings.pos.receiptSize values are honoured as
 * fall-backs so existing installs keep working after the upgrade.
 *
 * Physical sizes are stored as plain numbers + a unit ('mm' | 'in') and resolved
 * to millimetres with toMm() so the print CSS can emit real @page dimensions -
 * whatever width/height the merchant enters IS the print page size.
 */

/* ------------------------------------------------------------ units */

export function toMm(value, unit = 'mm') {
  const n = Number(value) || 0;
  if (unit === 'in') return n * 25.4;
  if (unit === 'cm') return n * 10;
  return n; // mm
}

export function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export const UNITS = [
  { value: 'mm', label: 'mm' },
  { value: 'in', label: 'inch' },
];

/* ------------------------------------------------------------ defaults */

export const DEFAULT_INVOICE = {
  // A. custom physical page size (the actual print page)
  //
  // Matched to the GP-3120TUC "POS" stock: Continuous (Variable Length),
  // 3.00 in max width, 7.00 in max length. pageHeightAuto keeps the roll
  // growing to the content so there is never a short-cut or a blank tail.
  pageWidth: 3,
  pageHeight: 7,
  pageHeightAuto: true, // let the page grow to fit the content (thermal rolls) - no blank pages
  unit: 'in', // mm | in

  // B. outer spacing (page margins), millimetres.
  // The driver already reserves its own 0.5 in top/bottom feed area on the
  // POS stock, so keep these small or the receipt wastes paper.
  marginTop: 3,
  marginBottom: 5,
  marginLeft: 3,
  marginRight: 3,

  // spacing between the invoice sections, millimetres
  gapHeader: 2, // after the business header
  gapImage: 2, // below the logo / image
  gapInfo: 2, // after the invoice-info block
  gapTable: 2, // after the product table
  gapTotals: 2, // after the totals block
  gapFooter: 3, // above the footer

  // type
  fontSize: 13, // px
  lineHeight: 1.4,

  // C. logo / image
  showLogo: true,
  logoWidthMm: 24,
  logoHeightMm: 0, // 0 = auto (keeps aspect ratio)
  logoAlign: 'center', // left | center | right
  logoKeepAspect: true,

  // header text
  headerText: '', // overrides the business name line when set

  // D. content show / hide
  showBusinessName: true,
  showAddress: true,
  showPhone: true,
  showEmail: false,
  showBin: true,
  showInvoiceNo: true,
  showDate: true,
  showTime: true,
  showCustomer: true,
  showCustomerPhone: true,
  showCashier: true,
  showItemName: true,
  showQty: true,
  showPrice: true,
  showLineDiscount: true,
  showLineTotal: true,
  showSubtotal: true,
  showDiscount: true,
  showTax: true,
  showTaxBreakdown: true,
  showGrandTotal: true,
  showPaid: true,
  showChange: true,
  showDue: true,
  showPaymentMethod: true,
  showFooter: true,
  showInvoiceBarcode: true,

  footerText: 'Thank you for shopping with us!\nExchange within 7 days with the receipt.',
};

export const DEFAULT_BARCODE = {
  // ONE barcode == ONE page, always. Not user-toggleable.
  onePerPage: true,

  // custom physical page size (the actual print page for EACH barcode)
  //
  // Matched to the GP-3120TUC "BARCODE L" stock: Die-Cut Labels, 1.50 in x
  // 1.00 in, 0.08 in exposed liner each side (folded into marginLeft/Right).
  pageWidth: 1.5,
  pageHeight: 1,
  unit: 'in', // mm | in

  // the barcode symbol box, millimetres
  // usable width = 38.1mm - 4mm side margins ~= 34mm; keep a quiet zone.
  barcodeWidthMm: 32,
  barcodeHeightMm: 11,

  // outer spacing (page margins), millimetres.
  // Left/Right = the 0.08 in (~2mm) exposed liner so the bars never ride the
  // die-cut edge; Top/Bottom keep the stack off the label edge.
  marginTop: 1.5,
  marginBottom: 1.5,
  marginLeft: 2,
  marginRight: 2,

  // spacing between the stacked elements, millimetres
  gapName: 0.6,
  gapBarcode: 0.6,
  gapNumber: 0.5,
  gapPrice: 0.6,

  // alignment of the whole stack
  align: 'center', // left | center | right

  /**
   * printRotation - degrees to rotate EACH label for the physical print only
   * (0 | 90 | 180 | 270). The on-screen preview is never rotated.
   *
   * Use this when the label printer / driver sends the barcode out turned the
   * wrong way (e.g. a landscape 50x30 label coming out bottom-to-top because the
   * driver's paper orientation is portrait). 90 or 270 also swap the emitted
   * @page to portrait so the printer stops re-rotating the page itself.
   */
  // 180 matches the driver's "Portrait 180" orientation on the BARCODE L stock,
  // so the printed label comes out upright instead of upside-down.
  printRotation: 180,

  /**
   * content - rendered TOP -> BOTTOM in this fixed order:
   *   Brand -> Business name -> Product name -> Attributes -> SKU
   *   -> Barcode -> Barcode number -> Price -> Custom text
   */
  showBrand: false,
  showBusinessName: false,
  showProductName: true,
  showSku: false,
  showColor: false, // product attribute (Color | Size | Variant), above the barcode
  showSize: false,
  showVariant: false,
  showBarcode: true,
  showBarcodeNumber: true,
  showPrice: true,
  showMrp: false, // struck MRP + active selling price ("৳520  ৳500", no "MRP" text)
  showCustomText: false,
  customText: '',

  // type sizes, px - tuned to fit the 1.5 x 1.0 in label
  brandNameSize: 8,
  businessNameSize: 7,
  productNameSize: 8,
  numberSize: 8,
  priceSize: 10,
  mrpSize: 7,
  attrSize: 7,
};

export const DEFAULT_PRINT = {
  invoice: { ...DEFAULT_INVOICE },
  barcode: { ...DEFAULT_BARCODE },
};

/* ------------------------------------------------------------ resolve */

export function invoiceConfig(settings = {}) {
  const legacy = settings.receipt || {};
  const seed = {
    headerText: legacy.header ?? DEFAULT_INVOICE.headerText,
    footerText: legacy.footer ?? DEFAULT_INVOICE.footerText,
    showLogo: legacy.showLogo ?? DEFAULT_INVOICE.showLogo,
    showCashier: legacy.showCashier ?? DEFAULT_INVOICE.showCashier,
    showInvoiceBarcode: legacy.showBarcode ?? DEFAULT_INVOICE.showInvoiceBarcode,
    showTaxBreakdown: legacy.showTaxBreakdown ?? DEFAULT_INVOICE.showTaxBreakdown,
  };
  // migrate an old 58 / 80 / a4 receipt size into a concrete custom size
  if (!settings.print?.invoice) {
    const p = settings.pos?.receiptSize;
    if (p === '58') Object.assign(seed, { pageWidth: 58, pageHeight: 150, unit: 'mm' });
    else if (p === '80') Object.assign(seed, { pageWidth: 80, pageHeight: 150, unit: 'mm' });
    else if (p === 'a4') Object.assign(seed, { pageWidth: 210, pageHeight: 297, unit: 'mm' });
  }
  return { ...DEFAULT_INVOICE, ...seed, ...(settings.print?.invoice || {}) };
}

export function barcodeConfig(settings = {}) {
  const merged = { ...DEFAULT_BARCODE, ...(settings.print?.barcode || {}), onePerPage: true };
  const r = Math.round(Number(merged.printRotation) || 0) % 360;
  merged.printRotation = [0, 90, 180, 270].includes(r) ? r : 0;
  return merged;
}

/**
 * resolveSize(cfg) -> { w, h, unit, wMm, hMm }
 * Keeps the merchant's own unit for the @page rule, and the millimetre
 * equivalent for any layout maths / preview scaling.
 */
export function resolveSize(cfg) {
  const unit = cfg.unit === 'in' || cfg.unit === 'cm' ? cfg.unit : 'mm';
  const w = Math.max(0.2, Number(cfg.pageWidth) || 0);
  const h = Math.max(0.2, Number(cfg.pageHeight) || 0);
  return {
    w, h, unit,
    wMm: clamp(toMm(w, unit), 10, 1200),
    hMm: clamp(toMm(h, unit), 10, 2000),
  };
}

/* ------------------------------------------------------------ sample data */

export const SAMPLE_SALE = {
  id: 'sample',
  invoiceNo: 'AFIA-BAN-00042',
  createdAt: '2026-08-28T14:12:00.000+06:00',
  cashierName: 'Rakib Hasan',
  customerName: 'Nusrat Jahan',
  customerPhone: '01711-000000',
  branchName: 'Banani Flagship',
  subtotal: 189500,
  discountTotal: 15000,
  taxTotal: 8175,
  grandTotal: 182675,
  changeTotal: 7325,
  dueTotal: 0,
  taxLines: [{ taxId: 't1', name: 'VAT', rate: 5, base: 163500, amount: 8175 }],
  payments: [{ method: 'cash', amount: 190000, direction: 'in' }],
  items: [
    { name: 'Matte Lipstick — Ruby', sku: 'LIP-RUBY-01', barcode: '8901234500011', qty: 2, unitPrice: 45000, discountTotal: 5000, taxAmount: 4250, lineTotal: 89250 },
    { name: 'Hydrating Face Serum 30ml', sku: 'SRM-HYD-30', barcode: '8901234500028', qty: 1, unitPrice: 99500, discountTotal: 10000, taxAmount: 3925, lineTotal: 93425 },
  ],
};

export const SAMPLE_LABEL_ITEMS = [
  { name: 'Matte Lipstick — Ruby', brandName: 'Demo Brand', sku: 'LIP-RUBY-01', barcode: '8901234500011', sellingPrice: 45000, mrp: 52000, costPrice: 26000, attributes: { color: 'Ruby', size: '3.5 g', variant: 'Matte' } },
  { name: 'Hydrating Face Serum 30ml', brandName: 'GlowLab', sku: 'SRM-HYD-30', barcode: '8901234500028', sellingPrice: 99500, mrp: 110000, costPrice: 61000, attributes: { size: '30 ml' } },
  { name: 'Kajal Pencil Black', brandName: 'Demo Brand', sku: 'KAJ-BLK', barcode: '8901234500035', sellingPrice: 18000, mrp: 20000, costPrice: 9000, attributes: { color: 'Black' } },
];

export default {
  toMm,
  clamp,
  UNITS,
  DEFAULT_INVOICE,
  DEFAULT_BARCODE,
  DEFAULT_PRINT,
  invoiceConfig,
  barcodeConfig,
  resolveSize,
  SAMPLE_SALE,
  SAMPLE_LABEL_ITEMS,
};
