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

/**
 * Stock type - mirrors the label printer driver's "Type" dropdown so the
 * merchant can match it 1:1.
 *   die-cut / continuous-fixed -> fixed page height (@page W H)
 *   continuous-variable        -> the page grows to the content (@page W auto)
 */
export const STOCK_TYPES = [
  { value: 'die-cut', label: 'Die-Cut Labels' },
  { value: 'continuous-fixed', label: 'Continuous (Fixed Length)' },
  { value: 'continuous-variable', label: 'Continuous (Variable Length)' },
];

/**
 * Orientation - mirrors the driver's Orientation radio group. The SAME value
 * the driver uses must be set here: our CSS pre-rotates the content by the same
 * angle, which cancels the driver's rotation so the label prints upright.
 *   portrait 0deg · landscape 90deg · portrait-180 180deg · landscape-180 270deg
 */
export const ORIENTATIONS = [
  { value: 'portrait', label: 'Portrait', deg: 0 },
  { value: 'landscape', label: 'Landscape', deg: 90 },
  { value: 'portrait-180', label: 'Portrait 180°', deg: 180 },
  { value: 'landscape-180', label: 'Landscape 180°', deg: 270 },
];

export function orientationToDeg(v) {
  return (ORIENTATIONS.find((o) => o.value === v) || ORIENTATIONS[0]).deg;
}
export function degToOrientation(deg) {
  const d = ((Math.round(Number(deg) || 0) % 360) + 360) % 360;
  return (ORIENTATIONS.find((o) => o.deg === d) || ORIENTATIONS[0]).value;
}

/* ------------------------------------------------------------ defaults */

export const DEFAULT_INVOICE = {
  // A. custom physical page size (the actual print page)
  //
  // Matched to the GP-3120TUC "POS" stock: Continuous (Variable Length),
  // 3.00 in max width, 7.00 in max length. pageHeightAuto keeps the roll
  // growing to the content so there is never a short-cut or a blank tail.
  stockType: 'continuous-variable', // driver "Type" - see STOCK_TYPES
  pageWidth: 3,
  pageHeight: 7,
  pageHeightAuto: true, // let the page grow to fit the content (thermal rolls) - no blank pages
  unit: 'in', // mm | in

  // Extra rotation for the physical print, almost always 0. The printer driver
  // owns orientation ("Portrait 180" etc. in Printing Preferences) - the page is
  // always sent upright. `orientation` is kept only so an older saved value
  // still resolves via degToOrientation() in invoiceConfig().
  orientation: 'portrait',
  printRotation: 0,

  // Exposed liner widths (driver field), in the page unit. Kept off the print
  // area on BOTH sides so nothing rides the label edge. 0 for a plain roll.
  linerLeft: 0,
  linerRight: 0,

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
  // 1.00 in, 0.08 in exposed liner each side.
  stockType: 'die-cut', // driver "Type" - see STOCK_TYPES
  pageWidth: 1.5,
  pageHeight: 1,
  unit: 'in', // mm | in

  /**
   * labelGap - the blank die-cut gap BETWEEN two labels, in the page unit.
   *
   * Cheap thermal printers driven from a browser feed the paper continuously:
   * they advance exactly one printed page and do NOT re-sense the gap. If the
   * printed page is only the label height, every label after the first drifts
   * down into the gap (the price ends up on the next label). Baking the gap in
   * makes ONE printed page == ONE physical label PITCH, so the run stays
   * registered. Set it to the real gap you measure between two labels
   * (~2-3 mm / 0.08-0.12 in is typical). Set 0 only if the driver is in
   * die-cut / gap-sensor mode and already re-registers each label.
   */
  labelGap: 0.12,

  // Exposed liner widths (driver "Exposed Liner Widths"), in the page unit.
  // The content box is inset by these so the bars never touch the die-cut edge.
  linerLeft: 0.08,
  linerRight: 0.08,

  // the barcode symbol box, millimetres
  // usable width = 38.1mm - 4mm side margins ~= 34mm; keep a quiet zone.
  barcodeWidthMm: 30,
  barcodeHeightMm: 9,

  // outer spacing (page margins), millimetres. Kept tight so the whole stack
  // clears a 1.0 in (25.4 mm) label with room to spare.
  marginTop: 1,
  marginBottom: 1,
  marginLeft: 2,
  marginRight: 2,

  // spacing between the stacked elements, millimetres
  gapName: 0.4,
  gapBarcode: 0.4,
  gapNumber: 0.4,
  gapPrice: 0.4,

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
  /**
   * orientation / printRotation - rotate EACH label for the physical print
   * only (screen preview is never rotated).
   *
   * Use rotation in ONE place, not two. The printer driver's own "Orientation:
   * Portrait 180" already flips the page; if you ALSO set 180 here the two
   * turns fight (the label comes out reading bottom-to-top). So the default is
   * 0 - let the driver do the flip. Only set this to 180 if you instead put the
   * driver back to plain Portrait and want the flip done here.
   */
  orientation: 'portrait',
  printRotation: 0,

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
  const savedInv = settings.print?.invoice || {};
  if (!settings.print?.invoice) {
    const p = settings.pos?.receiptSize;
    if (p === '58') Object.assign(seed, { pageWidth: 58, pageHeight: 150, unit: 'mm' });
    else if (p === '80') Object.assign(seed, { pageWidth: 80, pageHeight: 150, unit: 'mm' });
    else if (p === 'a4') Object.assign(seed, { pageWidth: 210, pageHeight: 297, unit: 'mm' });
  }
  const cfg = { ...DEFAULT_INVOICE, ...seed, ...savedInv };
  // Stock type <-> fixed/auto height. Only an explicitly saved stockType drives
  // pageHeightAuto, so older configs (A4 fixed, etc.) keep their behaviour.
  if (savedInv.stockType) cfg.pageHeightAuto = savedInv.stockType === 'continuous-variable';
  else cfg.stockType = cfg.pageHeightAuto ? 'continuous-variable' : 'die-cut';
  // orientation -> printRotation (a directly saved printRotation still wins).
  if (savedInv.orientation && savedInv.printRotation == null) cfg.printRotation = orientationToDeg(savedInv.orientation);
  const r = ((Math.round(Number(cfg.printRotation) || 0) % 360) + 360) % 360;
  cfg.printRotation = [0, 90, 180, 270].includes(r) ? r : 0;
  cfg.orientation = degToOrientation(cfg.printRotation);
  return cfg;
}

export function barcodeConfig(settings = {}) {
  const saved = settings.print?.barcode || {};
  const merged = { ...DEFAULT_BARCODE, ...saved, onePerPage: true };
  // orientation is the friendly control; printRotation is derived from it unless
  // the saved config pins printRotation directly (older settings win).
  if (saved.orientation && saved.printRotation == null) merged.printRotation = orientationToDeg(saved.orientation);
  const r = Math.round(Number(merged.printRotation) || 0) % 360;
  merged.printRotation = [0, 90, 180, 270].includes(r) ? r : 0;
  merged.orientation = degToOrientation(merged.printRotation);
  if (saved.stockType) merged.pageHeightAuto = saved.stockType === 'continuous-variable';
  else merged.stockType = merged.pageHeightAuto ? 'continuous-variable' : 'die-cut';
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
  STOCK_TYPES,
  ORIENTATIONS,
  orientationToDeg,
  degToOrientation,
  DEFAULT_INVOICE,
  DEFAULT_BARCODE,
  DEFAULT_PRINT,
  invoiceConfig,
  barcodeConfig,
  resolveSize,
  SAMPLE_SALE,
  SAMPLE_LABEL_ITEMS,
};
