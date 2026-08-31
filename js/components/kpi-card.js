/**
 * kpi-card.js - dashboard stat card. renderKpi(cfg) -> HTML string.
 * Pass `href` to make the whole card a drill-down link.
 */
import { icon } from './icons.js';
import { escapeHtml } from '../utils/dom.js';

export function renderKpi({ label, value, icon: ic = 'chart', tone = 'brand', trend = null, foot = '', small = false, href = null, sub = '' }) {
  const toneCls = { brand: '', success: 'kpi__icon--success', warning: 'kpi__icon--warning', danger: 'kpi__icon--danger', info: 'kpi__icon--info' }[tone] || '';
  let trendHtml = '';
  if (trend && Number.isFinite(trend.value)) {
    const up = trend.value >= 0;
    trendHtml = `<span class="kpi__trend kpi__trend--${up ? 'up' : 'down'}">${icon(up ? 'trending-up' : 'trending-down', { size: 13 })} ${Math.abs(trend.value).toFixed(1)}%</span>`;
  }
  const tag = href ? 'a' : 'div';
  const attrs = href ? ` href="${escapeHtml(href)}" class="kpi kpi--link"` : ' class="kpi"';
  return `<${tag}${attrs}>
    <div class="kpi__top">
      <span class="kpi__label">${escapeHtml(label)}</span>
      <span class="kpi__icon ${toneCls}">${icon(ic, { size: 17 })}</span>
    </div>
    <div class="kpi__value ${small ? 'is-sm' : ''}">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="kpi__sub">${escapeHtml(sub)}</div>` : ''}
    ${trendHtml || foot ? `<div class="kpi__foot">${trendHtml}${foot ? `<span>${escapeHtml(foot)}</span>` : ''}${href ? `<span class="kpi__drill">${icon('chevron-right', { size: 13 })}</span>` : ''}</div>` : (href ? `<div class="kpi__foot"><span class="kpi__drill">View report ${icon('chevron-right', { size: 13 })}</span></div>` : '')}
  </${tag}>`;
}

export default renderKpi;
