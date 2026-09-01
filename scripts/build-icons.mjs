/**
 * build-icons.mjs - generate the PWA PNG icons from scratch (no deps).
 *
 *   node scripts/build-icons.mjs
 *
 * Chrome desktop/Windows install and iOS "Add to Home Screen" want real PNGs,
 * not SVG. This rasterises the POS TXbd mark (a bold "A" on brand purple) into:
 *   assets/logos/icon-192.png        maskable-safe, rounded (purpose "any")
 *   assets/logos/icon-512.png        maskable-safe, rounded (purpose "any")
 *   assets/logos/icon-maskable-512.png   full-bleed square (purpose "maskable")
 *   assets/logos/apple-touch-icon.png    180x180, rounded, opaque bg
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'logos');

const PURPLE = [0x51, 0x45, 0xd8];
const WHITE = [0xff, 0xff, 0xff];

/** signed area sign — >0 if p is left of edge a->b */
const side = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = side(ax, ay, bx, by, px, py);
  const d2 = side(bx, by, cx, cy, px, py);
  const d3 = side(cx, cy, ax, ay, px, py);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** one icon as an RGBA buffer */
function draw(size, { rounded, opaqueBg }) {
  const s = size;
  const buf = Buffer.alloc(s * s * 4);
  const r = rounded ? s * 0.225 : 0; // corner radius
  // "A" geometry scaled to the canvas (with a safe margin for maskable)
  const m = rounded ? 0.16 : 0.24; // margin fraction — bigger for full-bleed maskable
  const top = s * m;
  const bot = s * (1 - m);
  const apex = [s * 0.5, top];
  const left = [s * (m + 0.02), bot];
  const right = [s * (1 - m - 0.02), bot];
  // inner counter: a smaller triangle leaving a crossbar near the bottom
  const iTop = s * (m + 0.16);
  const iBot = s * (1 - m - 0.16);
  const iApex = [s * 0.5, iTop];
  const iLeft = [s * (0.5 - (0.5 - m - 0.02) * ((iBot - top) / (bot - top))), iBot];
  const iRight = [s * (0.5 + (0.5 - m - 0.02) * ((iBot - top) / (bot - top))), iBot];

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      let a = 255;
      if (rounded) {
        // inside rounded rect?
        const cx = Math.min(Math.max(x, r), s - r);
        const cy = Math.min(Math.max(y, r), s - r);
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > r * r) a = 0;
      }
      let col = PURPLE;
      if (a > 0 && opaqueBg === false && !rounded) col = PURPLE;
      if (a > 0 && inTriangle(x + 0.5, y + 0.5, apex, left, right)) {
        col = inTriangle(x + 0.5, y + 0.5, iApex, iLeft, iRight) ? PURPLE : WHITE;
      }
      buf[i] = col[0];
      buf[i + 1] = col[1];
      buf[i + 2] = col[2];
      buf[i + 3] = a;
    }
  }
  return buf;
}

/* ---- minimal PNG encoder (RGBA, 8-bit, filter 0) ---- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const files = [
  ['icon-192.png', 192, { rounded: true, opaqueBg: false }],
  ['icon-512.png', 512, { rounded: true, opaqueBg: false }],
  ['icon-maskable-512.png', 512, { rounded: false, opaqueBg: true }],
  ['apple-touch-icon.png', 180, { rounded: true, opaqueBg: true }],
];
for (const [name, size, opts] of files) {
  writeFileSync(join(OUT, name), png(size, draw(size, opts)));
  console.log('wrote', name, `(${size}x${size})`);
}
