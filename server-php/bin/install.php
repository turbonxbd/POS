<?php
/**
 * bin/install.php - create all tables in the configured database.
 * Safe to run once on a fresh database. Use phpMyAdmin -> Import for Hostinger
 * if you prefer a GUI; this is the CLI equivalent.
 *
 *   php bin/install.php
 */
declare(strict_types=1);

require __DIR__ . '/../app/bootstrap.php';

$cfg = afia_config();
$db = new \Afia\Database($cfg['db']);

$existing = $db->driver() === 'mysql'
    ? $db->all('SHOW TABLES')
    : $db->all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
if ($existing) {
    fwrite(STDERR, "Refusing to install: the database already has " . count($existing) . " tables.\n");
    fwrite(STDERR, "Drop them first if you really want a clean install.\n");
    exit(1);
}

$db->executeScript(file_get_contents(__DIR__ . '/../migrations/schema.sql'));
\Afia\Support\Provision::ensureSystemRoles($db);
\Afia\Support\Provision::ensureDefaultPlans($db);
\Afia\Support\Provision::migratePlanFields($db);
\Afia\Support\Provision::ensurePlatformSettings($db);

echo "Schema installed (" . $db->driver() . ") with 7 system roles + 3 default plans.\n";
echo "Next: php bin/seed.php \"Your Business\" you@example.com 'password' platform\n";
