/**
 * print.js - render a printable document into #print-root and trigger print.
 * print.css hides everything except #print-root during @media print.
 */

let printRoot;

function ensureRoot() {
  if (printRoot && document.body.contains(printRoot)) return printRoot;
  printRoot = document.getElementById('print-root');
  if (!printRoot) {
    printRoot = document.createElement('div');
    printRoot.id = 'print-root';
    printRoot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(printRoot);
  }
  return printRoot;
}

/**
 * printHtml(htmlString) - inject trusted (pre-escaped) HTML and print.
 * Returns a promise resolving after the print dialog closes.
 */
/**
 * Shrink any barcode label whose stacked content is taller than the physical
 * label so it never bleeds onto the next die-cut label. Layout-box measurement
 * is unaffected by the print rotation transform, so this works at any rotation.
 */
function fitBarcodeLabels(root) {
  const PX_PER_MM = 96 / 25.4;
  root.querySelectorAll('.bc-canvas[data-fit-w]').forEach((cv) => {
    const stack = cv.querySelector('.bc-stack');
    if (!stack) return;
    stack.style.transform = '';
    const w = parseFloat(cv.dataset.fitW);
    const h = parseFloat(cv.dataset.fitH);
    if (!(w > 0) || !(h > 0)) return;
    const [pt, pr, pb, pl] = (cv.dataset.fitPad || '0|0|0|0').split('|').map(Number);
    const availW = (w - pl - pr) * PX_PER_MM;
    const availH = (h - pt - pb) * PX_PER_MM;
    const needW = stack.scrollWidth;
    const needH = stack.scrollHeight;
    const k = Math.min(1, needW ? availW / needW : 1, needH ? availH / needH : 1);
    if (k < 1 && k > 0) {
      stack.style.transformOrigin = 'center center';
      stack.style.transform = `scale(${k})`;
    }
  });
}

/**
 * Tighten the printed @page height of an auto-height receipt to the real
 * content height. receipt.js emits a valid two-length @page (width x a generous
 * max) so the browser never falls back to A4 / Letter; here we measure what
 * actually rendered and append a more specific @page so a short receipt does
 * not feed a long blank tail. A receipt taller than the baseline is left to
 * paginate.
 */
function fitReceiptPage(root) {
  const PX_PER_MM = 96 / 25.4;
  const el = root.querySelector('.receipt-preview.inv-doc[data-fit-page]');
  if (!el) return;
  const wmm = parseFloat(el.dataset.fitWmm);
  if (!(wmm > 0)) return;
  const hpx = el.scrollHeight || el.getBoundingClientRect().height;
  if (!(hpx > 0)) return;
  const hmm = Math.ceil(hpx / PX_PER_MM) + 1; // +1mm safety so nothing clips
  if (!(hmm > 4) || hmm > 5000) return;
  const s = root.ownerDocument.createElement('style');
  s.id = 'afia-fit-page';
  s.textContent = `@page { size: ${wmm.toFixed(2)}mm ${hmm}mm; margin: 0; }`;
  root.appendChild(s); // later @page rule wins the size descriptor
}

export function printHtml(htmlString) {
  const root = ensureRoot();
  root.innerHTML = htmlString;
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('afterprint', done);
      // Keep content briefly for slow renderers, then clear.
      setTimeout(() => {
        root.innerHTML = '';
        resolve();
      }, 300);
    };
    window.addEventListener('afterprint', done);
    // Give the browser a frame to lay out before printing.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { fitBarcodeLabels(root); } catch { /* non-fatal */ }
      try { fitReceiptPage(root); } catch { /* non-fatal */ }
      window.print();
      // Fallback if afterprint never fires (some browsers).
      setTimeout(done, 60000);
    }));
  });
}

/** Print an existing DOM node (clones it into print-root). */
export function printNode(node) {
  return printHtml(node.outerHTML);
}

/** Open a standalone print window (useful for popup-based receipt printers). */
export function printInWindow(htmlString, { title = 'Print', styles = [] } = {}) {
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) throw new Error('Popup blocked. Allow popups to print in a new window.');
  const styleLinks = styles.map((href) => `<link rel="stylesheet" href="${href}">`).join('');
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${styleLinks}</head><body>${htmlString}</body></html>`,
  );
  w.document.close();
  w.focus();
  w.onload = () => {
    w.print();
    w.onafterprint = () => w.close();
  };
  return w;
}
