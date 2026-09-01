/**
 * register-report.js - X-Report (mid-shift read, no close) and Z-Report
 * (end-of-shift, printed on close) receipt HTML. Shared by the cashier terminal
 * and the admin Cash Register page so both print the same document.
 */
import store from '../../core/store.js';
import money from '../../utils/money.js';
import { fmtDateTime } from '../../utils/date.js';
import { escapeHtml } from '../../utils/dom.js';

const row = (l, v) => `<div class="rcpt__row"><span>${l}</span><span class="num">${v}</span></div>`;
const m0 = (v) => money.format(v || 0, { withSymbol: false });

function head(s, kind) {
  const biz = store.get('business') || {};
  return `<div class="rcpt__center"><div class="rcpt__biz-name">${escapeHtml(biz.name || 'POS TXbd')}</div>
    <div class="rcpt__biz-meta">REGISTER ${kind}</div></div>
    <hr class="rcpt__hr">
    ${row('Session', escapeHtml(s.reference || '—'))}
    ${row('Cashier', escapeHtml(s.cashierName || '—'))}
    ${row('Opened', fmtDateTime(s.openedAt))}`;
}

function cashLines(s) {
  return `${row('Opening cash', m0(s.openingCash))}
    ${row('Cash sales', m0(s.cashSales))}
    ${row('Card / other', m0(s.cardSales))}
    ${row('Cash refunds', '-' + m0(s.cashRefunds))}
    ${row('Cash expenses', '-' + m0(s.cashExpenses))}
    ${row('Cash in/out', m0((s.cashIn || 0) - (s.cashOut || 0)))}`;
}

/** Mid-shift read. Shows expected but does not close the register. */
export function xReport(s) {
  return `<div class="receipt-preview size-80"><div class="rcpt">
    ${head(s, 'X-REPORT (mid-shift)')}
    ${row('Printed', fmtDateTime(new Date().toISOString()))}
    <hr class="rcpt__hr">
    ${cashLines(s)}
    <div class="rcpt__grand rcpt__row"><span>EXPECTED IN DRAWER</span><span class="num">${m0(s.expectedCash)}</span></div>
    ${row('Transactions', s.salesCount ?? '—')}
    <hr class="rcpt__hr">
    <div class="rcpt__thanks">X-Report does not close the register.</div>
  </div></div>`;
}

/** End-of-shift. Printed after the register is closed. */
export function zReport(s) {
  return `<div class="receipt-preview size-80"><div class="rcpt">
    ${head(s, 'Z-REPORT')}
    ${row('Closed', fmtDateTime(s.closedAt))}
    <hr class="rcpt__hr">
    ${cashLines(s)}
    <div class="rcpt__grand rcpt__row"><span>EXPECTED</span><span class="num">${m0(s.closingExpectedCash ?? s.expectedCash)}</span></div>
    ${row('Counted', m0(s.closingCountedCash))}
    ${row('Difference', m0(s.difference))}
    <hr class="rcpt__hr">
    <div class="rcpt__thanks">${escapeHtml(s.closingNote || '')}</div>
  </div></div>`;
}
