/**
 * run.mjs - runs every test file in sequence and reports a combined result.
 *   cd test && npm install && npm test
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['money.mjs', 'backend.mjs', 'render.mjs', 'pos-checkout.mjs', 'portal.mjs', 'app-boot.mjs', 'dashboard.mjs', 'i18n.mjs', 'print.mjs', 'product-barcode.mjs', 'exchange-return.mjs', 'platform.mjs', 'billing.mjs', 'chat.mjs', 'e2e-flow.mjs', 'sync.mjs', 'net-guard.mjs'];

let failed = 0;
for (const s of suites) {
  console.log('\n\x1b[1m▶ ' + s + '\x1b[0m');
  const r = spawnSync(process.execPath, [join(here, s)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log('\n' + (failed ? `\x1b[31m${failed} suite(s) failed\x1b[0m` : '\x1b[32mAll suites passed\x1b[0m'));
process.exit(failed ? 1 : 0);
