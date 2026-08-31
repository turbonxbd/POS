/**
 * money.mjs - display formatting: poisha (.00) is hidden unless a value has it.
 */
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear() };
globalThis.window = globalThis;
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;

const money = (await import('../js/utils/money.js')).default;

let pass = 0, fail = 0;
const T = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && x ? ' :: ' + x : '')); };

T('whole amount shows no .00', money.format(10000) === '৳ 100', money.format(10000));
T('big whole amount is grouped, no fraction', money.format(1234500) === '৳ 12,345', money.format(1234500));
T('an amount with poisha keeps it', money.format(10025) === '৳ 100.25', money.format(10025));
T('poisha under ten keeps the leading zero', money.format(10005) === '৳ 100.05', money.format(10005));
T('trailing-zero poisha (x.20) is shown', money.format(10020) === '৳ 100.20', money.format(10020));
T('zero is just the symbol + 0', money.format(0) === '৳ 0', money.format(0));
T('negative whole amount', money.format(-5000) === '-৳ 50', money.format(-5000));
T('negative with poisha', money.format(-5050) === '-৳ 50.50', money.format(-5050));
T('withSymbol:false drops the symbol', money.format(10000, { withSymbol: false }) === '100', money.format(10000, { withSymbol: false }));
T('forceFraction:true restores the 2-dp column', money.format(10000, { forceFraction: true }) === '৳ 100.00', money.format(10000, { forceFraction: true }));
T('math is unaffected — add/sub stay exact in poisha', money.add(10025, 9975) === 20000 && money.format(money.add(10025, 9975)) === '৳ 200');

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
