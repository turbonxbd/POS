<?php
/**
 * bin/build.php - assemble the upload bundle in ./dist.
 *
 * dist/public_html/   -> upload the CONTENTS to your Hostinger public_html
 * dist/app/           -> upload beside public_html (one level up)
 * dist/config/        -> upload beside public_html; then rename config.sample.php
 * dist/storage/       -> upload beside public_html
 *
 * The frontend is copied from the repo root and gets window.__AFIA_ENV__
 * injected so it talks to /api. The source repo is left untouched.
 *
 *   php bin/build.php
 */
declare(strict_types=1);

$root = dirname(__DIR__, 2);          // repo root (…/POS)
$server = dirname(__DIR__);            // …/POS/server-php
$dist = $server . '/dist';

$rrmdir = static function (string $dir) use (&$rrmdir) {
    if (!is_dir($dir)) {
        return;
    }
    foreach (scandir($dir) as $f) {
        if ($f === '.' || $f === '..') {
            continue;
        }
        $path = "$dir/$f";
        is_dir($path) ? $rrmdir($path) : unlink($path);
    }
    rmdir($dir);
};
$copy = static function (string $src, string $dst) use (&$copy) {
    if (is_dir($src)) {
        @mkdir($dst, 0755, true);
        foreach (scandir($src) as $f) {
            if ($f === '.' || $f === '..') {
                continue;
            }
            $copy("$src/$f", "$dst/$f");
        }
    } else {
        @mkdir(dirname($dst), 0755, true);
        copy($src, $dst);
    }
};

$rrmdir($dist);

/* ---- public_html: static frontend ---- */
$pub = "$dist/public_html";
$frontend = ['index.html', 'portal.html', 'login.html', 'admin.html', 'cashier.html', 'superadmin.html', '404.html',
    'manifest.webmanifest', 'service-worker.js', '.nojekyll', 'css', 'js', 'assets', 'data'];
foreach ($frontend as $item) {
    if (file_exists("$root/$item")) {
        $copy("$root/$item", "$pub/$item");
    }
}

/* inject the rest-mode env into every HTML entry point */
$env = json_encode(['APP_DATA_MODE' => 'rest', 'APP_API_BASE_URL' => '/api', 'APP_ENABLE_PWA' => 'false']);
$tag = "<script>window.__AFIA_ENV__=$env;</script>";
foreach (glob("$pub/*.html") as $html) {
    $c = file_get_contents($html);
    if (str_contains($c, '__AFIA_ENV__')) {
        continue;
    }
    $c = preg_replace('/<head(\s[^>]*)?>/i', "$0\n  $tag", $c, 1);
    file_put_contents($html, $c);
}

/* ---- public_html/api + .htaccess ---- */
$copy("$server/public", $pub);   // merges api/ + .htaccess into public_html

/* ---- app / config / storage (upload ABOVE public_html) ---- */
$copy("$server/app", "$dist/app");
$copy("$server/migrations", "$dist/migrations");
$copy("$server/bin", "$dist/bin");
@mkdir("$dist/config", 0755, true);
copy("$server/config/config.sample.php", "$dist/config/config.sample.php");
@mkdir("$dist/storage/backups", 0775, true);
@mkdir("$dist/storage/logs", 0775, true);

echo "Built $dist\n";
echo "  dist/public_html/  -> upload contents into public_html/\n";
echo "  dist/app  dist/config  dist/storage  dist/migrations  dist/bin  -> upload one level ABOVE public_html\n";
