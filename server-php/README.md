# POS TXbd — Server-side backend (PHP + MySQL, for Hostinger Web Hosting)

Self-hosted backend so **all business data lives inside your own Hostinger
account** — no external database, no Firebase/Supabase, no third-party API.

```
User browser
   -> POS website (static, served by Hostinger)
      -> /api  (this PHP app, front controller only)
         -> MySQL database in the same Hostinger account
            -> nightly mysqldump backups in ~/storage/backups
```

It implements the **same REST contract** the frontend already speaks
(`js/core/mock/*.routes.js` — identical URL paths and JSON shapes), so the
frontend only needs `APP_DATA_MODE=rest` + `APP_API_BASE_URL=/api`, which
`php bin/build.php` injects.

## Status — all modules implemented

| Area | Endpoints | Tests |
|---|---|---|
| Auth | `/auth/login\|me\|logout\|change-password` — Argon2id/bcrypt, signed httpOnly session, CSRF, login throttle | 8 |
| Catalog | products (+variants + branch stock), categories, brands, `/barcode/*`, `/products/lookup` | 4 |
| Inventory | overview, movements, adjustments, transfers, valuation, **reorder / low-stock report** | 3 |
| Sales | atomic checkout, **server invoice numbers**, idempotency, held sales, returns + exchanges, **credit / due sales + `POST /sales/:id/payment`**, **loyalty-point redemption** | 8 |
| Purchasing | suppliers (+ statement + payments), purchases (create/**edit draft** with per-line discount / VAT / freight, receive, cancel), purchase returns | 1 |
| People | customers (+ history + balance + loyalty ledger), roles, employees | 3 |
| Finance | expenses, taxes (percent + fixed), discounts (+ **product / category scope**, coupon validate), cash register (open / movements / **blind** close / **X-report data**) | 4 |
| Org | branches, settings (deep-merge), notifications, **audit logs with user / branch / date filters**, **backup export + import** | 4 |
| Analytics | `/dashboard` (+ `branchId=all`) + 23 report types (`/reports/:type`, incl. **dead-stock / ageing** and **loyalty points**) | 7 |
| Media | `/media` upload (base64) + `/media/:id` serve, per-merchant | 2 |
| Plans | `GET /plans` (public) + `/platform/plans` CRUD — one pricing source; each plan carries `setupPrice`, `monthlyPrice`, `includedBranches`, `extraBranchPrice` | 1 |
| Platform settings | `GET /public-settings` (public contact subset), `GET/PATCH /platform/settings` — WhatsApp / business info / billing defaults / gateway driver + `paymentMethods[]` (bKash/Nagad/bank/card: account number, Bangla + English instructions, enabled flag). Payment methods are NEVER in the public subset. | 1 |
| Signup | `POST /signup` (public) provisions an isolated merchant + pending subscription + auto-login; `POST /support` | 1 |
| Billing (merchant self-service) | `GET /billing/summary` (+ enabled `paymentMethods`), `POST /billing/pay` (setup / monthly), `POST /billing/branch-request`, `POST /billing/payments/:id/cancel` — amounts computed server-side; manual submissions require a transaction ID + payer account number, land `pending`, notify Super Admin, and return a prefilled WhatsApp link | 1 |
| Chat | `POST /chat` + `GET /chat/:id?since=` (public, polled), `/platform/chat*` (Super Admin) — real storage, no websockets | 1 |
| Sync | `GET /sync/changes?since=<cursor>` — the merchant's tables that hold a row newer than the cursor (names only, merchant-scoped). The frontend polls this ~every 3.5s in `rest` mode and re-fetches what changed, so other devices/branches update with no page refresh. Shared hosting can't hold WebSocket/SSE, so the poll is the transport | 1 |
| Platform (Super Admin) | dashboard (+ `attention` counts), **approvals inbox** (`GET /platform/approvals`, `POST /platform/approvals/:merchantId/{approve,reject}` — one action verifies the newest pending payment / activates the account / notifies the merchant), merchants (paginated + tag filter + detail), **internal notes & tags**, **message a merchant**, **reset the owner's password** (`POST /platform/merchants/:id/reset-owner`), subscriptions, `subscription-payments` (record + Approve/**Reject** with reason, typed `initial`/`monthly`/`branch`), revenue (by type / month / plan, approved + rejected counts, upcoming), `platform/notifications` (payment-request bell), **`GET /platform/audit` activity log**, support | 3 |
| Access gate | `App::enforceAccessGate` — a blocked subscription (expired past grace / suspended / cancelled) returns 402 on merchant writes; GET + `/billing/*` stay open | (in billing) |
| **Total** | | **65/65 passing** (`php tests/run.php`) |

## Security model (industry-standard practices, not "100% secure")

- **Tenant isolation** — `Repo` is constructed with the logged-in user's
  `merchant_id`; every query it builds is `WHERE merchant_id = ? AND (...)`.
  Media, backup, platform routes scope explicitly too. Tests prove Shop B sees
  0 of Shop A's products / images / sales.
- **AuthZ server-side** — `Context::requirePermission()` on every mutating route;
  the frontend's checks only hide buttons. Platform routes require
  `is_platform_admin = 1`.
- **Passwords** — `password_hash()` (Argon2id where the PHP build supports it,
  else bcrypt); never stored/logged in plaintext; auto-rehash on upgrade.
- **Sessions** — random 256-bit id in an HMAC-signed, `HttpOnly`, `Secure`,
  `SameSite=Lax` cookie; server-side `sessions` row, sliding + absolute expiry;
  logout / password-change / employee-deactivate / merchant-suspend revoke them.
- **CSRF** — readable `csrf_token` cookie matched against `X-CSRF-Token` on every
  unsafe request.
- **Login throttle** — 8 failures / email / 15 min → 429.
- **File exposure** — only `public/api/index.php` is web-reachable; `app/`,
  `config/`, `storage/` sit ABOVE `public_html`; `.htaccess` also denies
  `.sql/.log/.ini/.php` (other than the front controller) and directory listing.
- **Backups** — `bin/backup.php` (mysqldump, keeps 14) for a Hostinger cron;
  Admin → Backup export/import for a manual JSON snapshot (now includes images).

## Deploy to Hostinger — step by step

> **The full walkthrough is [`../DEPLOY.md`](../DEPLOY.md)** (custom domain, SSL,
> phpMyAdmin vs SSH, verification checklist, updating). This section is the short
> version.

### 1. Build the upload bundle (on your computer)

```bash
# Node (no PHP needed - Windows-friendly):
node server-php/build-dist.mjs --domain https://pos.yourdomain.com

# …or PHP:
php server-php/bin/build.php --domain https://pos.yourdomain.com
```

`--domain` rewrites the canonical / og:url / JSON-LD links (SEO); optional.
The build wires **rest mode** (`APP_DATA_MODE=rest`, `APP_API_BASE_URL=/api`) and
**enables the installable PWA** (`APP_ENABLE_PWA=true`).

`dist/` contains:
- `public_html/` — the static site + `api/` + `.htaccess` (rest-mode wired in)
- `app/  migrations/  bin/  config/  storage/` — the backend, to sit **above** the web root

### 2. Create the database (hPanel)

Databases → **MySQL Databases** → create one (e.g. `uXXXX_afiapos`) and a user.
Note host (usually `localhost`), db name, user, password.

### 3. Upload

Using File Manager or FTP, into your account **home directory** (the folder that
*contains* `public_html`):

```
/home/uXXXX/
├── public_html/        ← upload the CONTENTS of dist/public_html/ here
├── app/                ← dist/app/
├── migrations/         ← dist/migrations/
├── bin/                ← dist/bin/
├── config/             ← dist/config/   (then: copy config.sample.php → config.php)
└── storage/            ← dist/storage/   (chmod 775 backups/ and logs/)
```

### 4. Configure

Edit `config/config.php`:
- `db.dsn` / `db.user` / `db.password` — from step 2
- `session.secret` — `php -r "echo bin2hex(random_bytes(32));"`
- `session.cookie_secure` — leave `true` (serve the site over HTTPS; free with
  Hostinger)
- `gateway.*` — leave blank until you wire a real payment provider. The billing
  system runs on the `manual` driver (merchant submits a transaction ID + payer
  account number, you Approve/Reject it from **Super Admin → Payment Requests**)
  or the `mock` driver (instant success, for demos). The driver and the visible
  payment methods (bKash/Nagad/bank/card numbers + Bangla instructions) are
  configured in **Super Admin → Payment Settings**. Real bKash / SSLCommerz /
  card keys go in `config/config.php` under `gateway` and are read only by
  `app/Support/Gateway.php` — never by the frontend or the `platform_settings`
  record.

### 5. Create the schema + first login

Either import `migrations/schema.sql` via **phpMyAdmin → Import**, or run over SSH:

```bash
cd ~ && php bin/install.php
php bin/seed.php "TX Demo" you@yourdomain.com 'a-strong-password'
# add "platform" as a 4th arg for a Super Admin account (superadmin.html)
```

`bin/install.php` creates every table (including `plans`, `platform_settings`,
`platform_notifications`, `subscriptions`, `subscription_payments`,
`branch_requests`, `chat_threads`, `chat_messages`) and seeds the 3 default
plans + the platform settings row (with the default bKash/Nagad/bank/card
payment methods).
On an existing database, `bin/install.php` / `bin/seed.php` also run the
idempotent `Provision::migratePlanFields` + `ensurePlatformSettings` backfills.
After first login as Super Admin, set your real WhatsApp number and business
details in **Settings**, and review the plan prices in **Plans**.

### 6. Verify

- `https://yourdomain/api/health` → `{"status":"ok", ...}`
- `https://yourdomain/` → the POS portal; sign in with the seeded owner.
- Change that password immediately from your profile.

### 7. Automatic backups (hPanel → Advanced → Cron Jobs)

```
0 2 * * *   php /home/uXXXX/bin/backup.php
```

Writes a full DB dump to `storage/backups/` daily and keeps the newest 14
(`mysqldump` when available, portable PHP dump otherwise). **Also copy those
files off the server** — a nightly rsync/SFTP to a second host or a cloud drive,
or point the cron at a script that uploads after dumping. A backup that only
lives on the same disk as the database is not a backup.

**Super Admin → Backups** shows every dump with its size + age, and offers
*Back up now* (runs the script), *Download*, and *Delete*. The merchant panel's
**Settings → Backup** still does per-merchant JSON export/import.

In the browser-only (mock) build there is no server: `js/core/backup-auto.js`
keeps the newest 5 full snapshots of the whole dataset in IndexedDB (auto every
5 min + on tab close) and the same Super Admin → Backups page restores from
them. Deploy this PHP backend for a real multi-merchant product — the mock
stores each merchant's data in that merchant's own browser only.

## Local development / tests

Needs PHP 8.1+ with `pdo_sqlite` (bundled). No MySQL required.

```bash
php tests/run.php     # runs every route handler in-process on SQLite
```

The SQL is written to the portable subset that runs on both MySQL and SQLite, so
what the tests exercise is what production runs.

## Free-tier note

Hostinger Web/Cloud plans include MySQL and storage inside the same account — no
per-request or per-write ceiling like a serverless free tier. Watch disk usage
(images live in the `media` table); prune old backups (the script keeps 14).
