/**
 * pagination.js - renders a pagination control as an HTML string.
 * Buttons carry .js-page[data-page]; the host wires clicks (data-table does).
 */
import { icon } from './icons.js';

export function renderPagination(page, totalPages) {
  if (totalPages <= 1) return '';
  const pages = pageList(page, totalPages);
  return `<nav class="pagination" aria-label="Pagination">
    <button class="js-page" data-page="1" ${page === 1 ? 'disabled' : ''} aria-label="First page">${icon('chevrons-left', { size: 14 })}</button>
    <button class="js-page" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">${icon('chevron-left', { size: 14 })}</button>
    ${pages
      .map((p) =>
        p === '…'
          ? '<button disabled>…</button>'
          : `<button class="js-page" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`,
      )
      .join('')}
    <button class="js-page" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''} aria-label="Next page">${icon('chevron-right', { size: 14 })}</button>
    <button class="js-page" data-page="${totalPages}" ${page === totalPages ? 'disabled' : ''} aria-label="Last page">${icon('chevrons-right', { size: 14 })}</button>
  </nav>`;
}

function pageList(current, total) {
  const delta = 1;
  const range = [];
  for (let i = Math.max(2, current - delta); i <= Math.min(total - 1, current + delta); i++) range.push(i);
  const out = [1];
  if (range[0] > 2) out.push('…');
  out.push(...range);
  if (range[range.length - 1] < total - 1) out.push('…');
  if (total > 1) out.push(total);
  return [...new Set(out)];
}

export default renderPagination;
