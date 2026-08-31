/**
 * skeleton.js - loading placeholders.
 */

export function tableSkeleton(cols = 5, rows = 6) {
  const cell = '<td><div class="skeleton skeleton--text" style="width:70%"></div></td>';
  const row = `<tr>${cell.repeat(cols)}</tr>`;
  return `<table class="table"><tbody>${row.repeat(rows)}</tbody></table>`;
}

export function cardSkeleton(count = 1) {
  const one = `<div class="card card--pad stack">
    <div class="skeleton skeleton--title"></div>
    <div class="skeleton skeleton--text"></div>
    <div class="skeleton skeleton--text" style="width:80%"></div>
  </div>`;
  return one.repeat(count);
}

export function kpiSkeleton(count = 4) {
  const one = `<div class="kpi">
    <div class="skeleton skeleton--text" style="width:50%"></div>
    <div class="skeleton" style="height:2rem;width:60%"></div>
    <div class="skeleton skeleton--text" style="width:40%"></div>
  </div>`;
  return `<div class="kpi-grid">${one.repeat(count)}</div>`;
}

export function lines(n = 3) {
  return Array.from({ length: n }, (_, i) => `<div class="skeleton skeleton--text" style="width:${90 - i * 12}%"></div>`).join('');
}

export function blockLoader(label = 'Loading…') {
  return `<div class="loading-block"><span class="spinner"></span><span>${label}</span></div>`;
}
