<?php
/**
 * bin/backup.php - write a full database dump to storage/backups/.
 *
 *   php bin/backup.php
 *
 * Uses `mysqldump` when available (Hostinger provides it). Falls back to a
 * portable SQL dump generated in PHP if it is not on PATH. Keep the last 14
 * dumps. Wire this to a Hostinger cron job (hPanel -> Advanced -> Cron Jobs),
 * e.g. daily at 02:00:  php /home/uXXXX/bin/backup.php
 */
declare(strict_types=1);

require __DIR__ . '/../app/bootstrap.php';

$cfg = afia_config();
$dir = rtrim($cfg['app']['storage_dir'], '/') . '/backups';
@mkdir($dir, 0775, true);
$stamp = date('Y-m-d_His');
$file = "$dir/afia-pos_{$stamp}.sql";

if (preg_match('/mysql:host=([^;]+);dbname=([^;]+)/', $cfg['db']['dsn'], $m) && trim((string) shell_exec('command -v mysqldump')) !== '') {
    [$all, $host, $dbname] = $m;
    $cmd = sprintf(
        'mysqldump --single-transaction --host=%s --user=%s --password=%s %s > %s 2>&1',
        escapeshellarg($host), escapeshellarg($cfg['db']['user']), escapeshellarg($cfg['db']['password']),
        escapeshellarg($dbname), escapeshellarg($file),
    );
    exec($cmd, $out, $code);
    if ($code !== 0) {
        fwrite(STDERR, "mysqldump failed: " . implode("\n", $out) . "\n");
        exit(1);
    }
} else {
    // portable PHP dump (INSERT statements per table)
    $db = new \Afia\Database($cfg['db']);
    $tables = $db->driver() === 'mysql'
        ? array_map(static fn ($r) => array_values($r)[0], $db->all('SHOW TABLES'))
        : array_column($db->all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"), 'name');
    $fh = fopen($file, 'w');
    fwrite($fh, "-- POS TXbd portable dump {$stamp}\n");
    foreach ($tables as $t) {
        foreach ($db->all("SELECT * FROM {$t}") as $row) {
            $cols = implode(',', array_keys($row));
            $vals = implode(',', array_map(static fn ($v) => $v === null ? 'NULL' : "'" . str_replace("'", "''", (string) $v) . "'", array_values($row)));
            fwrite($fh, "INSERT INTO {$t} ({$cols}) VALUES ({$vals});\n");
        }
    }
    fclose($fh);
}

// retain the newest 14
$dumps = glob("$dir/afia-pos_*.sql");
rsort($dumps);
foreach (array_slice($dumps, 14) as $old) {
    unlink($old);
}

echo 'Backup written: ' . $file . ' (' . number_format(filesize($file) / 1024, 1) . " KB)\n";
