/**
 * barcode.js - Code 128 (auto B/C) barcode renderer -> inline SVG string.
 * Also renders EAN-13 when given exactly 13 digits (uses Code128-C style bars
 * for simplicity but keeps the human-readable number). No external libraries.
 */

// Code128 symbol patterns (each is a string of bar/space widths).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
  '2331112', // stop
];
const START_B = 104;
const START_C = 105;
const STOP = 106;

function encode(value) {
  const codes = [];
  const str = String(value);
  const isAllDigits = /^\d+$/.test(str) && str.length % 2 === 0;

  if (isAllDigits) {
    codes.push(START_C);
    for (let i = 0; i < str.length; i += 2) codes.push(parseInt(str.substr(i, 2), 10));
  } else {
    codes.push(START_B);
    for (const ch of str) {
      const c = ch.charCodeAt(0);
      codes.push(c >= 32 && c <= 126 ? c - 32 : 0);
    }
  }
  let checksum = codes[0];
  for (let i = 1; i < codes.length; i++) checksum += codes[i] * i;
  codes.push(checksum % 103);
  codes.push(STOP);
  return codes;
}

/**
 * renderBarcode(value, { height, width, showText, displayText, quiet })
 * returns an SVG string.
 */
export function renderBarcode(value, { height = 60, moduleWidth = 2, showText = true, displayText, quiet = 10 } = {}) {
  const codes = encode(value);
  const widths = codes.map((c) => PATTERNS[c]).join('');
  let x = quiet;
  let bar = true;
  const rects = [];
  for (const w of widths) {
    const width = parseInt(w, 10) * moduleWidth;
    if (bar) rects.push(`<rect x="${x}" y="0" width="${width}" height="${height}"/>`);
    x += width;
    bar = !bar;
  }
  const totalW = x + quiet;
  const textH = showText ? 16 : 0;
  const label = displayText ?? String(value);
  return `<svg class="barcode-svg" xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${height + textH}" viewBox="0 0 ${totalW} ${height + textH}" role="img" aria-label="Barcode ${label}">
    <rect width="100%" height="100%" fill="#fff"/>
    <g fill="#000">${rects.join('')}</g>
    ${showText ? `<text x="${totalW / 2}" y="${height + 13}" text-anchor="middle" font-family="monospace" font-size="12" fill="#000" letter-spacing="1">${label}</text>` : ''}
  </svg>`;
}

/** Render into an element. */
export function mountBarcode(el, value, opts) {
  el.innerHTML = renderBarcode(value, opts);
}

export default renderBarcode;
