/**
 * build-dist.mjs - assemble the Hostinger upload bundle in server-php/dist/
 * (Node version of bin/build.php, for machines without PHP - e.g. Windows).
 *
 *   node server-php/build-dist.mjs --domain https://pos.yourdomain.com
 *
 * Options:
 *   --domain <url>   your live site URL. Rewrites the canonical / og:url / JSON-LD
 *                    links (which otherwise still point at the old GitHub Pages).
 *                    Optional but recommended for SEO.
 *   --api <path>     API base path the frontend calls. Default: /api
 *
 * Output:
 *   dist/public_html/  -> upload the CONTENTS into your Hostinger public_html/
 *   dist/app  dist/config  dist/storage  dist/migrations  dist/bin
 *                      -> upload one level ABOVE public_html/
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = dirname(fileURLToPath(import.meta.url)); // …/POS/server-php
const root = dirname(server); // …/POS
const dist = join(server, 'dist');

/* ---- args ---- */
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const API_BASE = opt('--api', '/api').replace(/\/$/, '');
let DOMAIN = opt('--domain', '').replace(/\/$/, '');
if (DOMAIN && !/^https?:\/\//.test(DOMAIN)) DOMAIN = 'https://' + DOMAIN;

/* ---- clean ---- */
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/* ---- public_html: static frontend ---- */
const pub = join(dist, 'public_html');
const FRONTEND = [
  'index.html', 'portal.html', 'login.html', 'admin.html', 'cashier.html',
  'superadmin.html', 'privacy.html', 'terms.html', '404.html',
  'manifest.webmanifest', 'service-worker.js', '.nojekyll',
  'css', 'js', 'assets',
];
for (const item of FRONTEND) {
  const src = join(root, item);
  if (existsSync(src)) cpSync(src, join(pub, item), { recursive: true });
}

/* ---- inject rest-mode env + fix canonical URLs in every HTML entry point ---- */
const env = JSON.stringify({
  APP_DATA_MODE: 'rest',
  APP_API_BASE_URL: API_BASE,
  APP_ENABLE_PWA: 'true',
});
const tag = `<script>window.__AFIA_ENV__=${env};</script>`;
const OLD_SITE = 'https://turbonxbd.github.io/POS';

for (const name of readdirSync(pub)) {
  if (!name.endsWith('.html')) continue;
  const path = join(pub, name);
  let c = readFileSync(path, 'utf8');
  if (!c.includes('__AFIA_ENV__')) {
    c = c.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n  ${tag}`);
  }
  if (DOMAIN) {
    // canonical / og:url / twitter / JSON-LD all use the same absolute prefix
    c = c.split(OLD_SITE).join(DOMAIN);
  }
  writeFileSync(path, c);
}

/* ---- public_html/api + .htaccess (merge server/public into public_html) ---- */
cpSync(join(server, 'public'), pub, { recursive: true });

/* ---- backend: upload ONE LEVEL ABOVE public_html ---- */
cpSync(join(server, 'app'), join(dist, 'app'), { recursive: true });
cpSync(join(server, 'migrations'), join(dist, 'migrations'), { recursive: true });
cpSync(join(server, 'bin'), join(dist, 'bin'), { recursive: true });
mkdirSync(join(dist, 'config'), { recursive: true });
cpSync(join(server, 'config', 'config.sample.php'), join(dist, 'config', 'config.sample.php'));
mkdirSync(join(dist, 'storage', 'backups'), { recursive: true });
mkdirSync(join(dist, 'storage', 'logs'), { recursive: true });

// Defence in depth: deny HTTP access to every backend folder, whatever the
// hosting layout puts them next to.
const DENY = 'Require all denied\n<IfModule !mod_authz_core.c>\n  Deny from all\n</IfModule>\n';
for (const d of ['app', 'config', 'storage', 'migrations', 'bin']) {
  writeFileSync(join(dist, d, '.htaccess'), DENY);
}

console.log(`\nBuilt ${dist}`);
console.log(`  API base    : ${API_BASE}`);
console.log(`  Canonical   : ${DOMAIN || '(unchanged - pass --domain to fix SEO URLs)'}`);
console.log(`  PWA         : enabled (installable app)`);
console.log('\nUpload:');
console.log('  dist/public_html/*        -> your Hostinger public_html/');
console.log('  dist/app dist/config dist/storage dist/migrations dist/bin');
console.log('                            -> one level ABOVE public_html/');
console.log('\nThen: rename config/config.sample.php -> config/config.php and fill it in.');
