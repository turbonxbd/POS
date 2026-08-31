# Tests

Node smoke tests for the frontend. **The app has no runtime dependencies** —
these tests only need `jsdom` to simulate a browser DOM.

```bash
cd test
npm install      # installs jsdom (dev-only)
npm test         # runs all three suites
```

| Suite | What it checks |
|---|---|
| `backend.mjs` | The mock backend end-to-end + the §50 data-integrity rules: stock reconciles with the inventory ledger, no negative stock, unique invoice numbers, **idempotent checkout** (no double sale / double deduction), **atomic rollback** on a failed sale, returns restock correctly, payment validation, RBAC, settings deep-merge, all 14 reports, persistence to `localStorage`. |
| `render.mjs` | Every admin page + the 3 detail pages + the POS render into a jsdom document without throwing and produce their expected DOM. |
| `pos-checkout.mjs` | Full cashier flow: add products → change quantity → open payment → pay exact cash → sale created → success dialog → cart cleared, with no console errors. |

Run an individual suite directly:

```bash
node test/backend.mjs
```

These are lightweight assertions, not a framework. They run against a fresh
seeded demo dataset each time (in-memory `localStorage`).
