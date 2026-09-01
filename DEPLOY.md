# Deploy POS TXbd to Hostinger (custom domain + MySQL)

This puts the **real** product live: one central database, every merchant
isolated, works across devices/branches, automatic backups, installable app.

> The GitHub Pages build is the *mock* build — data lives only in one browser.
> For a real business you must deploy this PHP backend. That is what this guide does.

**You need:** a Hostinger Web / Cloud plan (includes PHP 8 + MySQL), your domain
pointed at it, and either Node **or** PHP on your computer to build the bundle.

---

## 1 — Build the upload bundle (on your computer)

From the repo root (`POS/`):

```bash
# Node (Windows-friendly):
node server-php/build-dist.mjs --domain https://pos.yourdomain.com

# …or PHP:
php server-php/bin/build.php --domain https://pos.yourdomain.com
```

`--domain` is your live URL — it fixes the SEO/canonical links. Leave it off if
you don't have the domain yet (you can rebuild later).

This creates **`server-php/dist/`**:

```
dist/
├── public_html/     → the website + /api + .htaccess  (rest-mode already wired in)
├── app/             → the backend code
├── migrations/      → schema.sql
├── bin/             → install / seed / backup scripts
├── config/          → config.sample.php
└── storage/         → backups + logs (empty)
```

---

## 2 — Create the database (hPanel)

**Databases → MySQL Databases** → create a database + user (tick "all
privileges"). Write down: **host** (usually `localhost`), **database name**,
**user**, **password**.

---

## 3 — Upload

Open **File Manager** (or FTP) at your account **home directory** — the folder
that *contains* `public_html`.

| Upload this | To here |
|---|---|
| **contents of** `dist/public_html/` | `public_html/` |
| `dist/app/` | `app/` (beside public_html) |
| `dist/migrations/` | `migrations/` |
| `dist/bin/` | `bin/` |
| `dist/config/` | `config/` |
| `dist/storage/` | `storage/` |

Result:

```
/home/uXXXX/
├── public_html/     ← website + api/
├── app/  migrations/  bin/  config/  storage/     ← NOT web-reachable
```

Then in File Manager: **rename `config/config.sample.php` → `config/config.php`**,
and set `storage/backups` and `storage/logs` to permission **775**.

---

## 4 — Configure `config/config.php`

```php
'db' => [
  'dsn'      => 'mysql:host=localhost;dbname=uXXXX_pos;charset=utf8mb4',
  'user'     => 'uXXXX_pos',
  'password' => 'the password from step 2',
],
'session' => [
  'secret'        => '…64 random hex chars…',   // node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  'cookie_secure' => true,                       // keep true — HTTPS only
],
'app' => [ 'env' => 'production' ],
```

Leave `gateway.*` blank — billing runs on the **manual** driver (a merchant
submits a bKash/Nagad transaction ID, you approve it in Super Admin → Payment
Requests). Wire real gateway keys later, here, only if you need automatic
payments.

---

## 5 — HTTPS

hPanel → **SSL** → install the free certificate for your domain, then turn on
**Force HTTPS**. (The `.htaccess` also forces it, but the panel toggle is
cleaner.) The session cookie is `Secure` — the site must be HTTPS.

---

## 6 — Create the schema + your Super Admin login

**Option A — phpMyAdmin (no SSH):** hPanel → phpMyAdmin → your database →
**Import** → choose `migrations/schema.sql` → Go. Then create the first account:
you still need one command, so use Option B for the seed, or ask support to
enable SSH.

**Option B — SSH** (hPanel → Advanced → SSH Access):

```bash
cd ~
php bin/install.php                       # creates every table + 3 plans + platform settings
php bin/seed.php "POS TXbd" you@yourdomain.com 'a-strong-password' platform
```

The 4th word `platform` makes it a **Super Admin** (the `superadmin.html`
panel). Merchants are created after this — either you add them, or they sign up
themselves from the Live page.

---

## 7 — Verify

| Check | Expect |
|---|---|
| `https://yourdomain/api/health` | `{"status":"ok", …}` |
| `https://yourdomain/` | the marketing / Live page |
| `https://yourdomain/portal.html` | merchant sign-in |
| `https://yourdomain/superadmin.html` | Super Admin sign-in (use the seeded account) |
| Sign in → add a product → open the same account in another browser | the product is there (central DB, not per-browser) |
| Turn off Wi-Fi | full-screen **"No Internet"** on every page within ~12s |
| Chrome address bar / the "Install POS TXbd" button | installs as a standalone app, opens into the Portal |

Change the seeded password from your profile immediately.

---

## 8 — Automatic backups (hPanel → Advanced → Cron Jobs)

```
0 2 * * *   php /home/uXXXX/bin/backup.php
```

Daily MySQL dump into `storage/backups/`, keeps the newest 14. **Also pull those
files off the server** (a second cron that SFTPs them somewhere, or a manual
weekly download) — a backup on the same disk as the database is not a backup.
Super Admin → Backups lists them with *Back up now / Download / Delete*.

---

## 9 — Updating later

1. `git pull` (or download the new code)
2. rebuild: `node server-php/build-dist.mjs --domain https://pos.yourdomain.com`
3. re-upload `dist/public_html/*` and `dist/app/*` (leave `config/`, `storage/`,
   the database alone — updates never touch merchant data)
4. if `migrations/schema.sql` changed, re-run the new statements (or
   `php bin/install.php` on a copy to diff); existing installs also get the
   idempotent backfills from `bin/install.php`
5. installed apps show **"Update available — Reload now"** automatically once the
   new `service-worker.js` is live (its `VERSION` is bumped every release)

---

## What's already handled for you

- **Tenant isolation** — every query is `WHERE merchant_id = ?`; Shop B sees 0 of
  Shop A's data (proven by `php server-php/tests/run.php`).
- **Fresh accounts** — a new merchant starts with 1 branch, 1 tax, 0 products /
  customers / sales.
- **Real-time across devices** — the app polls `GET /sync/changes` every ~3.5s
  and re-fetches only what changed (shared hosting can't hold WebSockets).
- **No data loss on save** — offline → the UI is blocked so nothing half-saves;
  a failed save while online shows an error and keeps your form.
- **Passwords** — Argon2id/bcrypt hashes only; no plaintext anywhere, ever.
- **Sessions / CSRF / login throttle** — enforced server-side.
- **Code ≠ data** — `app/`, `config/`, `storage/` sit above `public_html`.
