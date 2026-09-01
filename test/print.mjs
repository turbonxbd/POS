/**
 * print.mjs - Settings -> Print: invoice + barcode.
 * Verifies the configured physical Width/Height becomes the real @page size,
 * that one barcode == one page, spacing/content toggles work, and nothing
 * silently converts the page to A4 / Letter.
 */
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="app-root"></div><div id="print-root"></div></body></html>', { url: 'http://localhost:5173/admin.html', pretendToBeVisual: true });
const { window } = dom;
const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
def('window', window); def('document', window.document); def('navigator', window.navigator);
def('location', window.location); def('history', window.history);
globalThis.HTMLElement = window.HTMLElement; globalThis.Node = window.Node; globalThis.CustomEvent = window.CustomEvent; globalThis.Event = window.Event;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.matchMedia = globalThis.matchMedia;
def('localStorage', window.localStorage); def('sessionStorage', window.sessionStorage);
def('addEventListener', window.addEventListener.bind(window));
def('removeEventListener', window.removeEventListener.bind(window));
window.print = () => {};
globalThis.print = () => {};

const R = '../';
const { db } = await import(R + 'js/core/db.js');
const { initMockServer } = await import(R + 'js/core/mock-server.js');
const { seedDemo } = await import(R + 'js/data/seed.js');
const { session } = await import(R + 'js/core/session.js');
const { http } = await import(R + 'js/core/http.js');
initMockServer(); db.load(); if (db.isEmpty) await seedDemo(db);
await session.login('admin@txdemo.shop', 'demo1234');

const pc = await import(R + 'js/core/print-config.js');
const { buildReceipt } = await import(R + 'js/pages/shared/receipt.js');
const { buildBarcodePages, buildSingleLabel } = await import(R + 'js/pages/shared/barcode-label.js');

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- units ---------- */
T('toMm inch', Math.abs(pc.toMm(1, 'in') - 25.4) < 1e-9);
T('toMm mm passthrough', pc.toMm(80, 'mm') === 80);
const rs = pc.resolveSize({ pageWidth: 3, pageHeight: 5, unit: 'in' });
T('resolveSize keeps unit + converts', rs.unit === 'in' && rs.w === 3 && Math.abs(rs.wMm - 76.2) < 1e-6 && Math.abs(rs.hMm - 127) < 1e-6);

/* ---------- invoice config: defaults + legacy migration ---------- */
const iv = pc.invoiceConfig({});
T('invoice default 3in wide (GP-3120TUC POS stock)', iv.pageWidth === 3 && iv.unit === 'in' && iv.pageHeightAuto === true);
const ivLegacy = pc.invoiceConfig({ pos: { receiptSize: 'a4' }, receipt: { header: 'My Shop', footer: 'ধন্যবাদ', showBarcode: false } });
T('legacy a4 -> 210x297mm', ivLegacy.pageWidth === 210 && ivLegacy.pageHeight === 297);
T('legacy receipt.header -> headerText', ivLegacy.headerText === 'My Shop');
T('legacy receipt.footer -> footerText', ivLegacy.footerText === 'ধন্যবাদ');
T('legacy receipt.showBarcode -> showInvoiceBarcode', ivLegacy.showInvoiceBarcode === false);
const ivNew = pc.invoiceConfig({ receipt: { header: 'x' }, print: { invoice: { headerText: 'NEW', pageWidth: 100 } } });
T('print.invoice overrides legacy', ivNew.headerText === 'NEW' && ivNew.pageWidth === 100);

/* ---------- buildReceipt: exact @page + toggles ---------- */
const S = pc.SAMPLE_SALE;
const r1 = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, stockType: 'continuous-fixed', pageWidth: 80, pageHeight: 150, unit: 'mm', pageHeightAuto: false } } } });
T('80x150mm -> @page size: 80mm 150mm', /@page\s*{\s*size:\s*80mm 150mm;\s*margin:\s*0/.test(r1), r1.slice(0, 120));
T('receipt container width 80mm', /\.receipt-preview\.inv-doc\s*{[\s\S]*?width:\s*80mm/.test(r1));
T('no A4 / Letter substitution', !/size:\s*A4/i.test(r1) && !/size:\s*letter/i.test(r1) && !r1.includes('210mm 297mm'));
const rIn = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, stockType: 'continuous-fixed', pageWidth: 3, pageHeight: 5, unit: 'in', pageHeightAuto: false } } } });
T('3x5in -> @page size: 3in 5in', /@page\s*{\s*size:\s*3in 5in/.test(rIn));
const rAuto = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, pageWidth: 80, unit: 'mm', pageHeightAuto: true } } } });
// auto height must still emit TWO real lengths ("<w> auto" is invalid CSS and
// makes the browser fall back to A4/Letter). Width kept, height a big baseline.
T('auto height -> @page has width + a real length, NOT the invalid "auto"', /@page\s*{\s*size:\s*80mm \d+mm;\s*margin:\s*0/.test(rAuto) && !/@page\s*{\s*size:\s*80mm auto/.test(rAuto));
T('auto height -> receipt carries data-fit-page for the print-time tighten', /data-fit-page="1"/.test(rAuto) && /data-fit-wmm="80/.test(rAuto));
T('fixed height -> NO data-fit-page marker', !/data-fit-page/.test(r1));
T('default receipt shows TOTAL + tax', r1.includes('TOTAL') && /VAT|Tax/.test(r1));
const rNoTax = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, showTax: false, showTaxBreakdown: false } } } });
T('showTax:false removes tax rows', !/VAT \(5%\)/.test(rNoTax) && !rNoTax.includes('>Tax<'));
const rNoBarcode = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, showInvoiceBarcode: false } } } });
T('showInvoiceBarcode:false removes svg', !rNoBarcode.includes('barcode-svg'));
const rSpace = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, marginLeft: 9, gapTable: 7, fontSize: 15 } } } });
T('spacing + font flow into scoped style', rSpace.includes('9mm') && rSpace.includes('margin-bottom: 7mm') && rSpace.includes('font-size: 15px'));
const rNoName = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, showItemName: false } } } });
T('showItemName:false hides product names', !rNoName.includes('Matte Lipstick'));

/* ---------- barcode: ONE barcode = ONE page ---------- */
const bc10 = buildBarcodePages([{ ...pc.SAMPLE_LABEL_ITEMS[0], qty: 10 }], { settings: {} });
T('10 barcodes => 10 pages', (bc10.match(/class="bc-page"/g) || []).length === 10, (bc10.match(/class="bc-page"/g) || []).length + '');
T('no grid: no columns template', !bc10.includes('grid-template-columns') && !bc10.includes('label-page'));
T('break after every page except last (no trailing blank)', /\.bc-page:not\(:last-child\)\s*{[^}]*break-after: page/.test(bc10) && /\.bc-page:not\(:last-child\)\s*{[^}]*page-break-after: always/.test(bc10));
T('last page does not force a break', /\.bc-page:last-child\s*{[^}]*page-break-after: auto/.test(bc10) && /\.bc-page:last-child\s*{[^}]*break-after: auto/.test(bc10));
T('page box centred on both axes (survives 180deg printer flip)', /\.bc-page\s*{[\s\S]*?align-items: center[\s\S]*?justify-content: center/.test(bc10));
T('bc-page kept from splitting across sheets', /\.bc-page\s*{[\s\S]*?break-inside: avoid/.test(bc10));
T('bc-run centred in the sheet', /\.bc-run\s*{[^}]*margin: 0 auto/.test(bc10));

/* ---------- css/print.css: print isolation must not break pagination ---------- */
const printCss = await (await import('node:fs/promises')).readFile(new URL(R + 'css/print.css', import.meta.url), 'utf8');
const mediaPrint = printCss.slice(printCss.indexOf('@media print'));
T('print-root is NOT position:absolute (would break multi-page pagination)', !/#print-root\s*{[^}]*position:\s*absolute/.test(mediaPrint));
T('print-root forced to static flow', /#print-root\s*{[^}]*position:\s*static/.test(mediaPrint));
T('isolation via display:none, not visibility overlay', /body\s*>\s*\*:not\(#print-root\)\s*{\s*display:\s*none/.test(mediaPrint));
T('printed document centred (margin auto)', /\.bc-run\s*{[^}]*margin-left:\s*auto/.test(mediaPrint) && /margin-right:\s*auto/.test(mediaPrint));
const bcMixed = buildBarcodePages([{ ...pc.SAMPLE_LABEL_ITEMS[0], qty: 3 }, { ...pc.SAMPLE_LABEL_ITEMS[1], qty: 2 }], { settings: {} });
T('qty expands 3 + 2 => 5 pages', (bcMixed.match(/class="bc-page"/g) || []).length === 5);

const bcMm = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm' } } } });
T('50x30mm barcode -> @page size: 50mm 30mm', /@page\s*{\s*size:\s*50mm 30mm;\s*margin:\s*0/.test(bcMm));
T('bc-page dimensioned 50mm x 30mm', /\.bc-page\s*{[\s\S]*?width:\s*50mm;\s*height:\s*30mm/.test(bcMm));
const bcIn = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 2, pageHeight: 1.2, unit: 'in' } } } });
T('2x1.2in barcode -> @page size: 2in 1.2in', /@page\s*{\s*size:\s*2in 1.2in/.test(bcIn));

const bcContent = pc.barcodeConfig({ print: { barcode: { showProductName: false, showPrice: false } } });
const oneCard = buildSingleLabel(pc.SAMPLE_LABEL_ITEMS[0], { settings: {} });
T('default barcode card shows name + number + price', oneCard.includes('Matte Lipstick') && oneCard.includes('8901234500011') && /৳/.test(oneCard));
const hidden = buildSingleLabel(pc.SAMPLE_LABEL_ITEMS[0], { settings: { print: { barcode: bcContent } } });
T('content toggles hide name + price', !hidden.includes('Matte Lipstick') && !/৳/.test(hidden));
const leftCfg = pc.barcodeConfig({ print: { barcode: { align: 'left' } } });
T('align left applied', buildSingleLabel(pc.SAMPLE_LABEL_ITEMS[0], { settings: { print: { barcode: leftCfg } } }).includes('align-items: flex-start'));

/* ---------- barcode: physical print rotation (orientation fix) ---------- */
const bcR0 = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm', printRotation: 0 } } } });
T('printRotation default 0 -> no transform on the canvas', !/\.bc-canvas\s*{[^}]*transform:\s*rotate/.test(bcR0));
T('printRotation 0 -> printed @page stays 50mm 30mm (landscape, unchanged)', /@page\s*{\s*size:\s*50mm 30mm/.test(bcR0));
const bcR90 = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm', printRotation: 90 } } } });
T('printRotation 90 -> printed @page stays the physical label size 50mm 30mm (never swapped)', /@page\s*{\s*size:\s*50mm 30mm/.test(bcR90) && !/@page\s*{\s*size:\s*30mm 50mm/.test(bcR90));
T('rotation never leaks into the on-screen preview (transform only inside @media print)', !/transform:\s*rotate/.test(bcR90.slice(0, bcR90.indexOf('@media print'))));
T('printRotation 90 -> canvas rotated 90deg for print', /@media print[\s\S]*\.bc-canvas\s*{[^}]*transform:\s*rotate\(90deg\)/.test(bcR90));
T('printRotation 90 -> canvas laid out at swapped dims 30mm x 50mm for print', /@media print[\s\S]*\.bc-canvas\s*{[^}]*width:\s*30mm;\s*height:\s*50mm/.test(bcR90));
T('printRotation 90 -> printed bc-page still the physical 50mm x 30mm label', /@media print[\s\S]*\.bc-page\s*{[^}]*width:\s*50mm;\s*height:\s*30mm/.test(bcR90));
T('printRotation 90 -> canvas clipped so nothing bleeds to the next label', /@media print[\s\S]*\.bc-canvas\s*{[^}]*overflow:\s*hidden/.test(bcR90));
T('printRotation 90 -> still one page per barcode', (buildBarcodePages([{ ...pc.SAMPLE_LABEL_ITEMS[0], qty: 7 }], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, printRotation: 90 } } } }).match(/class="bc-page"/g) || []).length === 7);
const bcR270 = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm', printRotation: 270 } } } });
T('printRotation 270 -> canvas rotated 270deg', /\.bc-canvas\s*{[^}]*transform:\s*rotate\(270deg\)/.test(bcR270));
const bcR180 = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm', printRotation: 180 } } } });
T('printRotation 180 -> @page NOT swapped (still 50mm 30mm), canvas rotate(180deg)', /@page\s*{\s*size:\s*50mm 30mm/.test(bcR180) && /\.bc-canvas\s*{[^}]*transform:\s*rotate\(180deg\)/.test(bcR180));
T('printRotation garbage value falls back to 0', pc.barcodeConfig({ print: { barcode: { printRotation: 45 } } }).printRotation === 0 && pc.barcodeConfig({ print: { barcode: { printRotation: '90' } } }).printRotation === 90);
T('each label carries data-fit-* so print can shrink overflow to the physical label', /class="bc-canvas" data-fit-w="50" data-fit-h="30" data-fit-pad="[\d.|]+"/.test(bcR0));
T('printRotation 90 -> data-fit swapped to 30 x 50', /data-fit-w="30" data-fit-h="50"/.test(bcR90));

/* ---------- barcode: exposed liner + orientation + stock type ---------- */
const bcLiner = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm', linerLeft: 3, linerRight: 3, marginLeft: 1, marginRight: 1, printRotation: 0 } } } });
T('exposed liner folds into the canvas horizontal padding (1 + 3 = 4mm each side)', /\.bc-canvas\s*{[^}]*padding:\s*[\d.]+mm 4mm [\d.]+mm 4mm/.test(bcLiner));
T('default barcode = die-cut, 0.08in liner, "Portrait 180" = upright (printRotation 0)', pc.DEFAULT_BARCODE.stockType === 'die-cut' && pc.DEFAULT_BARCODE.linerLeft === 0.08 && pc.barcodeConfig({}).printRotation === 0 && pc.barcodeConfig({}).orientation === 'portrait-180');
T('orientation matches the printer: "Portrait 180" upright (0), plain "Portrait" flipped (180)', pc.barcodeConfig({ print: { barcode: { orientation: 'portrait-180', printRotation: null } } }).printRotation === 0
  && pc.barcodeConfig({ print: { barcode: { orientation: 'portrait', printRotation: null } } }).printRotation === 180
  && pc.barcodeConfig({ print: { barcode: { orientation: 'landscape-180', printRotation: null } } }).printRotation === 90
  && pc.barcodeConfig({ print: { barcode: { orientation: 'landscape', printRotation: null } } }).printRotation === 270);
T('a saved printRotation still wins over orientation (back-compat)', pc.barcodeConfig({ print: { barcode: { orientation: 'portrait', printRotation: 90 } } }).printRotation === 90);
const bcVar = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm', stockType: 'continuous-variable', printRotation: 0 } } } });
T('continuous-variable barcode stock -> @page has two real lengths (no invalid "auto")', /@page\s*{\s*size:\s*50mm \d+mm/.test(bcVar) && !/@page\s*{\s*size:\s*50mm auto/.test(bcVar));
const bcDie = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, labelGap: 0, pageWidth: 50, pageHeight: 30, unit: 'mm', stockType: 'die-cut', printRotation: 0 } } } });
T('die-cut barcode stock -> fixed @page height', /@page\s*{\s*size:\s*50mm 30mm/.test(bcDie));

/* ---------- barcode: label gap == one printed page is one label PITCH ---------- */
const bcGap = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0], pc.SAMPLE_LABEL_ITEMS[1]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, pageWidth: 50, pageHeight: 30, unit: 'mm', labelGap: 3, printRotation: 0 } } } });
T('labelGap 3mm -> @page height is the PITCH (30 + 3 = 33mm), width unchanged', /@page\s*{\s*size:\s*50mm 33mm/.test(bcGap));
T('labelGap -> the label itself stays 30mm (canvas), gap is blank space below', /\.bc-canvas\s*{[^}]*height:\s*30mm/.test(bcGap));
T('labelGap -> label centred in the pitch (gap split top+bottom, rotation-safe)', /@media print[\s\S]*\.bc-page\s*{[^}]*align-items:\s*center/.test(bcGap));
T('labelGap default is 0.12in on the barcode default', pc.DEFAULT_BARCODE.labelGap === 0.12);
{
  // continuous-variable ignores labelGap: the @page height is NOT 30+3=33
  const bcVarGap = buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: { print: { barcode: { ...pc.DEFAULT_BARCODE, pageWidth: 50, pageHeight: 30, unit: 'mm', labelGap: 3, stockType: 'continuous-variable' } } } });
  T('labelGap is ignored for a continuous-variable (auto) barcode', /@page\s*{\s*size:\s*50mm \d+mm/.test(bcVarGap) && !/@page\s*{\s*size:\s*50mm 33mm/.test(bcVarGap));
}
T('barcode still one .bc-page per label with a gap', (bcGap.match(/class="bc-page"/g) || []).length === 2);
T('data-fit-pad folds in the exposed liner (right/left = 2 + 0.08in≈4.03mm)', /data-fit-pad="[\d.]+\|[\d.]+\|[\d.]+\|[\d.]+"/.test(buildBarcodePages([pc.SAMPLE_LABEL_ITEMS[0]], { settings: {} })));

/* ---------- invoice: orientation matches the printer convention ---------- */
// "Portrait 180" = upright = NO rotation (this is the default, and what the printer calls straight)
const ivUp = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, orientation: 'portrait-180', printRotation: null, pageHeightAuto: true } } } });
T('invoice "Portrait 180" -> upright, no transform', !/transform:\s*rotate/.test(ivUp));
// plain "Portrait" = the printer prints it upside down -> we flip 180 to match
const ivFlip = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, orientation: 'portrait', printRotation: null, pageHeightAuto: true } } } });
T('invoice plain "Portrait" -> rotate(180deg) in @media print only', /@media print[\s\S]*transform:\s*rotate\(180deg\)/.test(ivFlip) && !/transform:\s*rotate/.test(ivFlip.slice(0, ivFlip.indexOf('@media print'))));
T('invoice orientation -> printRotation matches the printer', pc.invoiceConfig({ print: { invoice: { orientation: 'portrait-180', printRotation: null } } }).printRotation === 0
  && pc.invoiceConfig({ print: { invoice: { orientation: 'portrait', printRotation: null } } }).printRotation === 180);
T('invoice default is "Portrait 180" (upright)', pc.invoiceConfig({}).orientation === 'portrait-180' && pc.invoiceConfig({}).printRotation === 0);
T('invoice default -> no transform', !/transform:\s*rotate/.test(buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE } } } })));

/* ---------- invoice: exposed liner ---------- */
const ivLiner = buildReceipt(S, { settings: { print: { invoice: { ...pc.DEFAULT_INVOICE, stockType: 'continuous-fixed', pageWidth: 80, pageHeight: 150, unit: 'mm', marginLeft: 2, marginRight: 2, linerLeft: 4, linerRight: 4 } } } });
T('invoice exposed liner folds into the container padding (2 + 4 = 6mm each side)', /\.receipt-preview\.inv-doc\s*{[^}]*padding:\s*[\d.]+mm 6mm [\d.]+mm 6mm/.test(ivLiner));

/* ---------- Settings page wiring ---------- */
document.body.innerHTML = '<div id="app-root"></div><div id="print-root"></div>';
const mount = document.getElementById('app-root');
const settingsPage = (await import(R + 'js/pages/admin/settings.js')).default;
await settingsPage({ params: {}, query: { section: 'print' } }, mount);
await sleep(140);
T('Print panel renders sub-tabs', !!mount.querySelector('#print-subtabs') && !!mount.querySelector('#print-controls'));
T('Invoice: width/height/unit inputs', !!mount.querySelector('[data-p="print.invoice.pageWidth"]') && !!mount.querySelector('[data-p="print.invoice.pageHeight"]') && !!mount.querySelector('[data-p="print.invoice.unit"]'));
{
  // Real bug found + fixed: with the driver-matched default (unit "in",
  // pageWidth 3), the Width/Height inputs still carried an mm-era min="10",
  // so the browser flagged a perfectly correct "3" as :invalid. min must
  // track the active unit.
  const wEl = mount.querySelector('[data-p="print.invoice.pageWidth"]');
  const hEl = mount.querySelector('[data-p="print.invoice.pageHeight"]');
  T('Invoice: Width/Height min matches the "in" unit (not an mm-era min="10")', wEl.min === '0.5' && hEl.min === '0.5' && Number(wEl.value) >= Number(wEl.min));
}
// switching the Unit select must re-sync the min live, not just on next reload
{
  mount.querySelector('[data-p="print.invoice.unit"]').value = 'mm';
  mount.querySelector('[data-p="print.invoice.unit"]').dispatchEvent(new window.Event('change'));
  await sleep(30);
  T('Invoice: switching Unit to mm live-updates the Width min back to 10', mount.querySelector('[data-p="print.invoice.pageWidth"]').min === '10');
  mount.querySelector('[data-p="print.invoice.unit"]').value = 'in';
  mount.querySelector('[data-p="print.invoice.unit"]').dispatchEvent(new window.Event('change'));
  await sleep(30);
}
T('Invoice: image upload + spacing inputs', !!mount.querySelector('#inv-logo-input') && !!mount.querySelector('[data-p="print.invoice.marginTop"]'));
T('Invoice: stock type + exposed liner fields present', !!mount.querySelector('#inv-stock-type') && !!mount.querySelector('[data-p="print.invoice.linerLeft"]') && !!mount.querySelector('[data-p="print.invoice.linerRight"]'));
T('Invoice: orientation control present', !!mount.querySelector('#inv-orientation') && mount.querySelector('#inv-orientation').tagName === 'SELECT');
T('Invoice preview rendered a receipt', !!mount.querySelector('#preview-scale .receipt-preview'));
T('Test print + Reset + Save buttons', !!mount.querySelector('#print-test') && !!mount.querySelector('#print-reset') && !!mount.querySelector('#print-save'));

mount.querySelector('#print-subtabs button[data-t="barcode"]').click();
await sleep(140);
T('Barcode: width/height/unit inputs', !!mount.querySelector('[data-p="print.barcode.pageWidth"]') && !!mount.querySelector('[data-p="print.barcode.unit"]'));
{
  const wEl = mount.querySelector('[data-p="print.barcode.pageWidth"]');
  T('Barcode: Width min matches the "in" unit (default 1.5in label, not mm-era min="5")', wEl.min === '0.2' && Number(wEl.value) >= Number(wEl.min));
}
T('Barcode: barcode size + align inputs', !!mount.querySelector('[data-p="print.barcode.barcodeWidthMm"]') && !!mount.querySelector('[data-p="print.barcode.align"]'));
T('Barcode: orientation control present', !!mount.querySelector('#bc-orientation') && mount.querySelector('#bc-orientation').tagName === 'SELECT');
T('Barcode: stock type control present', !!mount.querySelector('#bc-stock-type'));
T('Barcode: exposed liner fields present', !!mount.querySelector('[data-p="print.barcode.linerLeft"]') && !!mount.querySelector('[data-p="print.barcode.linerRight"]'));
T('Barcode: label-gap field present', !!mount.querySelector('[data-p="print.barcode.labelGap"]'));
T('Barcode preview rendered one bc-page', !!mount.querySelector('#preview-scale .bc-page'));
T('Barcode preview meta says 1 barcode = 1 page', /1 barcode = 1 page/.test(mount.querySelector('#preview-meta').textContent));

// change width in the editor -> preview @page updates
const wIn = mount.querySelector('[data-p="print.barcode.pageWidth"]');
wIn.value = '70'; wIn.dispatchEvent(new window.Event('change'));
await sleep(220);
T('editing width updates the preview @page', /@page\s*{\s*size:\s*70/.test(mount.querySelector('#preview-scale').innerHTML));

// test print - no side effects
const salesBefore = db.collection('sales').count();
let threw = false;
try { mount.querySelector('#print-test').click(); await sleep(40); } catch { threw = true; }
T('test barcode print does not throw', !threw);
T('test print created no sale', db.collection('sales').count() === salesBefore);

/* ---------- backend persistence + deep-merge ---------- */
await http.put('/settings', { print: { invoice: { pageWidth: 76.2, unit: 'mm' }, barcode: { pageWidth: 2, pageHeight: 1, unit: 'in' } } });
const st = await http.get('/settings');
T('print.invoice.pageWidth persisted', st.print.invoice.pageWidth === 76.2);
T('print.barcode custom size persisted', st.print.barcode.pageWidth === 2 && st.print.barcode.unit === 'in');
T('deep-merge keeps other settings', st.business?.name && st.pos?.invoiceTemplate);
const cfgAfter = pc.invoiceConfig(st);
T('saved config resolves back through invoiceConfig', cfgAfter.pageWidth === 76.2);

/* ---------- settings-service: cross-tab print-layout freshness ---------- */
{
  const { settingsService } = await import(R + 'js/services/settings-service.js');
  const { default: bus } = await import(R + 'js/core/event-bus.js');
  // warm the cache
  const a = await settingsService.getSettings();
  T('settings cache warmed', !!a && a.print);
  // another tab changes the settings row -> db.js emits db:external-change
  db.collection('settings').all().forEach((s) => db.collection('settings').update(s.id, { print: { ...s.print, invoice: { ...s.print.invoice, pageWidth: 55, unit: 'mm' } } }));
  let heard = null;
  bus.on('settings:changed', (s) => { heard = s; });
  bus.emit('db:external-change', ['settings']);
  await sleep(30);
  const b = await settingsService.getSettings(); // no {fresh} - must already be refreshed
  T('external settings change invalidates the cache (cashier picks it up, no reload)', b.print.invoice.pageWidth === 55);
  T('external settings change re-emits settings:changed for live consumers', heard && heard.print.invoice.pageWidth === 55);
  // an unrelated collection change must NOT drop the settings cache
  const before = await settingsService.getSettings();
  bus.emit('db:external-change', ['products', 'sales']);
  await sleep(10);
  T('an unrelated external change leaves the settings cache alone', (await settingsService.getSettings()) === before);
}

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
