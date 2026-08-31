/**
 * chart.js - dependency-free canvas charts (line, area, bar, stackedBar, hbar,
 * donut). Theme-aware (reads CSS custom properties), retina-crisp, responsive
 * via ResizeObserver, with hover tooltips. Rebuilds on theme toggle.
 *
 * createChart(mount, { type, data, options })
 *   line/area/bar/stackedBar: data = { labels:[], series:[{ name, values:[], color? }] }
 *   hbar: data = { items:[{ label, value }] }
 *   donut: data = { items:[{ label, value }] }
 */
import bus from '../core/event-bus.js';
import money from '../utils/money.js';
import { compactNum } from '../utils/format.js';

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function palette() {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--chart-${i}`, '#888'));
}

export function createChart(mount, config) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-canvas-wrap';
  wrap.style.height = (config.options?.height || 260) + 'px';
  const canvas = document.createElement('canvas');
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  wrap.append(canvas, tip);
  mount.replaceChildren(wrap);

  const ctx = canvas.getContext('2d');
  let hover = null;
  let geometry = null;

  function draw() {
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 2) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const type = config.type;
    if (type === 'donut') geometry = drawDonut(ctx, rect, config, hover);
    else if (type === 'hbar') geometry = drawHBar(ctx, rect, config, hover);
    else geometry = drawCartesian(ctx, rect, config, hover);
  }

  function fmt(v) {
    if (config.options?.valueFormat === 'money') return money.format(v);
    if (config.options?.valueFormat === 'compact') return compactNum(v);
    return String(Math.round(v));
  }

  function showAt(clientX, clientY) {
    if (!geometry) return;
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const hit = geometry.hitTest?.(x, y);
    if (hit) {
      hover = hit.index;
      tip.style.opacity = '1';
      tip.style.left = hit.x + 'px';
      tip.style.top = hit.y + 'px';
      tip.innerHTML = `<strong>${hit.title}</strong>${hit.rows.map((row) => `${row.label}: ${fmt(row.value)}`).join('<br>')}`;
      draw();
    } else if (hover != null) {
      hover = null;
      tip.style.opacity = '0';
      draw();
    }
  }
  function hideTip() {
    hover = null;
    tip.style.opacity = '0';
    draw();
  }

  canvas.addEventListener('mousemove', (e) => showAt(e.clientX, e.clientY));
  canvas.addEventListener('mouseleave', hideTip);
  // touch: tap / drag to inspect, works on mobile & tablet
  canvas.addEventListener('touchstart', (e) => {
    if (!e.touches[0]) return;
    showAt(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (!e.touches[0]) return;
    showAt(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  canvas.addEventListener('touchend', () => setTimeout(hideTip, 1800), { passive: true });

  if (typeof config.options?.onClick === 'function') {
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('click', (e) => {
      if (!geometry?.hitTest) return;
      const r = canvas.getBoundingClientRect();
      const hit = geometry.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit) config.options.onClick(hit.index, hit);
    });
  }

  const ro = new ResizeObserver(() => draw());
  ro.observe(wrap);
  const off = bus.on('theme:changed', () => requestAnimationFrame(draw));
  requestAnimationFrame(draw);

  return {
    update(next) {
      Object.assign(config, next);
      draw();
    },
    destroy() {
      ro.disconnect();
      off();
      mount.replaceChildren();
    },
  };
}

/* ---------------------------------------------------------- cartesian */
function drawCartesian(ctx, rect, config, hoverIdx) {
  const { labels = [], series = [] } = config.data;
  const opts = config.options || {};
  const colors = palette();
  const axis = cssVar('--chart-axis', '#888');
  const grid = cssVar('--chart-grid', '#ddd');
  const font = '11px ' + cssVar('--font-sans', 'sans-serif');
  ctx.font = font;

  const padL = opts.valueFormat === 'money' ? 64 : 44;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const W = rect.width - padL - padR;
  const H = rect.height - padT - padB;

  const stacked = config.type === 'stackedBar';
  let max = 0;
  if (stacked) {
    labels.forEach((_, i) => {
      const sum = series.reduce((s, ser) => s + (ser.values[i] || 0), 0);
      max = Math.max(max, sum);
    });
  } else {
    series.forEach((ser) => ser.values.forEach((v) => (max = Math.max(max, v || 0))));
  }
  max = niceMax(max || 1);

  // grid + y labels
  ctx.strokeStyle = grid;
  ctx.fillStyle = axis;
  ctx.lineWidth = 1;
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const y = padT + (H * s) / steps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + W, y);
    ctx.stroke();
    const val = max * (1 - s / steps);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.valueFormat === 'money' ? money.format(val, { withSymbol: false }) : compactNum(val), padL - 8, y);
  }

  const n = labels.length;
  const slot = W / Math.max(1, n);
  const bars = [];

  // x labels (thinned)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const every = Math.ceil(n / 8);
  labels.forEach((lab, i) => {
    if (i % every === 0 || i === n - 1) ctx.fillText(String(lab), padL + slot * i + slot / 2, padT + H + 8);
  });

  const yFor = (v) => padT + H - (v / max) * H;

  if (config.type === 'bar' || stacked) {
    const groupW = slot * 0.62;
    labels.forEach((_, i) => {
      let acc = 0;
      const barW = stacked ? groupW : groupW / series.length;
      series.forEach((ser, si) => {
        const v = ser.values[i] || 0;
        const x = stacked ? padL + slot * i + (slot - groupW) / 2 : padL + slot * i + (slot - groupW) / 2 + si * barW;
        const h = (v / max) * H;
        const y = stacked ? yFor(acc + v) : yFor(v);
        ctx.fillStyle = ser.color || colors[si % colors.length];
        if (hoverIdx === i) ctx.globalAlpha = 1;
        else ctx.globalAlpha = hoverIdx == null ? 1 : 0.55;
        roundRect(ctx, x, y, Math.max(1, barW - 2), Math.max(1, stacked ? h : padT + H - y), 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        acc += v;
      });
      bars.push({ x0: padL + slot * i, x1: padL + slot * (i + 1) });
    });
  } else {
    // line / area
    series.forEach((ser, si) => {
      const color = ser.color || colors[si % colors.length];
      ctx.beginPath();
      ser.values.forEach((v, i) => {
        const x = padL + slot * i + slot / 2;
        const y = yFor(v || 0);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      if (config.type === 'area') {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + H);
        grad.addColorStop(0, hexA(color, 0.28));
        grad.addColorStop(1, hexA(color, 0.02));
        ctx.lineTo(padL + slot * (n - 1) + slot / 2, padT + H);
        ctx.lineTo(padL + slot / 2, padT + H);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        ser.values.forEach((v, i) => {
          const x = padL + slot * i + slot / 2;
          const y = yFor(v || 0);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ser.values.forEach((v, i) => {
        const x = padL + slot * i + slot / 2;
        const y = yFor(v || 0);
        ctx.beginPath();
        ctx.arc(x, y, hoverIdx === i ? 4 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    });
    labels.forEach((_, i) => bars.push({ x0: padL + slot * i, x1: padL + slot * (i + 1) }));
  }

  if (hoverIdx != null && bars[hoverIdx]) {
    ctx.strokeStyle = hexA(axis, 0.4);
    ctx.setLineDash([3, 3]);
    const cx = (bars[hoverIdx].x0 + bars[hoverIdx].x1) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, padT);
    ctx.lineTo(cx, padT + H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  return {
    hitTest(x, y) {
      if (x < padL || x > padL + W || y < padT || y > padT + H) return null;
      const i = Math.floor((x - padL) / slot);
      if (i < 0 || i >= n) return null;
      return {
        index: i,
        x: padL + slot * i + slot / 2,
        y: padT + 10,
        title: String(labels[i]),
        rows: series.map((s, si) => ({ label: s.name, value: s.values[i] || 0 })),
      };
    },
  };
}

/* ------------------------------------------------------------- donut */
function drawDonut(ctx, rect, config, hoverIdx) {
  const items = (config.data.items || []).filter((d) => d.value > 0);
  const colors = palette();
  const total = items.reduce((s, d) => s + d.value, 0) || 1;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const R = Math.min(cx, cy) - 8;
  const r = R * 0.58;
  let a0 = -Math.PI / 2;
  const arcs = [];
  items.forEach((d, i) => {
    const a1 = a0 + (d.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, hoverIdx === i ? R + 3 : R, a0, a1);
    ctx.arc(cx, cy, r, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = d.color || colors[i % colors.length];
    ctx.globalAlpha = hoverIdx == null || hoverIdx === i ? 1 : 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    arcs.push({ a0, a1 });
    a0 = a1;
  });
  ctx.fillStyle = cssVar('--text-strong', '#111');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 16px ' + cssVar('--font-sans', 'sans-serif');
  const centerVal = hoverIdx != null ? items[hoverIdx].value : total;
  ctx.fillText(config.options?.valueFormat === 'money' ? money.format(centerVal, { withSymbol: false }) : compactNum(centerVal), cx, cy - 6);
  ctx.font = '11px ' + cssVar('--font-sans', 'sans-serif');
  ctx.fillStyle = cssVar('--text-muted', '#888');
  ctx.fillText(hoverIdx != null ? String(items[hoverIdx].label).slice(0, 16) : 'Total', cx, cy + 12);

  return {
    hitTest(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < r || dist > R + 4) return null;
      let ang = Math.atan2(dy, dx);
      if (ang < -Math.PI / 2) ang += Math.PI * 2;
      const idx = arcs.findIndex((a) => ang >= a.a0 && ang < a.a1);
      if (idx < 0) return null;
      return { index: idx, x, y, title: String(items[idx].label), rows: [{ label: 'Value', value: items[idx].value }, { label: 'Share', value: Math.round((items[idx].value / total) * 100) }] };
    },
  };
}

/* -------------------------------------------------------------- hbar */
function drawHBar(ctx, rect, config, hoverIdx) {
  const items = config.data.items || [];
  const colors = palette();
  const max = niceMax(Math.max(1, ...items.map((d) => d.value)));
  const rowH = Math.min(34, (rect.height - 8) / Math.max(1, items.length));
  const labelW = Math.min(150, rect.width * 0.4);
  ctx.font = '11px ' + cssVar('--font-sans', 'sans-serif');
  ctx.textBaseline = 'middle';
  const rows = [];
  items.forEach((d, i) => {
    const y = 4 + i * rowH;
    ctx.fillStyle = cssVar('--text-secondary', '#555');
    ctx.textAlign = 'left';
    ctx.fillText(clip(ctx, String(d.label), labelW - 8), 0, y + rowH / 2);
    const bw = ((rect.width - labelW - 40) * d.value) / max;
    ctx.fillStyle = d.color || colors[i % colors.length];
    ctx.globalAlpha = hoverIdx == null || hoverIdx === i ? 1 : 0.55;
    roundRect(ctx, labelW, y + rowH * 0.18, Math.max(2, bw), rowH * 0.64, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = cssVar('--text-muted', '#888');
    ctx.textAlign = 'left';
    ctx.fillText(config.options?.valueFormat === 'money' ? money.format(d.value, { withSymbol: false }) : compactNum(d.value), labelW + bw + 6, y + rowH / 2);
    rows.push({ y0: y, y1: y + rowH });
  });
  return {
    hitTest(x, y) {
      const i = rows.findIndex((r) => y >= r.y0 && y <= r.y1);
      if (i < 0) return null;
      return { index: i, x, y: rows[i].y0, title: String(items[i].label), rows: [{ label: 'Value', value: items[i].value }] };
    },
  };
}

/* ---------------------------------------------------------- helpers */
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function hexA(hex, a) {
  const c = hex.replace('#', '');
  const n = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function clip(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}

export function chartLegend(items) {
  const colors = palette();
  return `<div class="chart-legend">${items
    .map((it, i) => `<span><i style="background:${it.color || colors[i % colors.length]}"></i>${it.label ?? it.name}</span>`)
    .join('')}</div>`;
}

export default createChart;
