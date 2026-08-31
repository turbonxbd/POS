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
