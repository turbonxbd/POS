<?php
/**
 * bin/seed.php - create the first merchant + owner login.
 *
 *   php bin/seed.php "TX Demo" owner@example.com 'a-strong-password'
 *
 * Add a 4th arg "platform" to make this account a Super Admin (platform-wide).
 * With no args it prompts. The password is never echoed back to logs.
 */
declare(strict_types=1);

require __DIR__ . '/../app/bootstrap.php';

$name = $argv[1] ?? readline('Business name: ');
$email = $argv[2] ?? readline('Owner email: ');
$password = $argv[3] ?? null;
$platform = ($argv[4] ?? '') === 'platform';

if ($password === null) {
    echo 'Owner password (min 8 chars): ';
    system('stty -echo 2>/dev/null');
    $password = trim(fgets(STDIN) ?: '');
    system('stty echo 2>/dev/null');
    echo "\n";
}
if (strlen($password) < 8) {
    fwrite(STDERR, "Password must be at least 8 characters.\n");
    exit(1);
}

$db = new \Afia\Database(afia_config()['db']);
\Afia\Support\Provision::ensureDefaultPlans($db);
\Afia\Support\Provision::migratePlanFields($db);
\Afia\Support\Provision::ensurePlatformSettings($db);

try {
    $res = \Afia\Support\Provision::merchant($db, trim($name), trim($email), $password, $platform);
} catch (\Throwable $e) {
    fwrite(STDERR, 'Seed failed: ' . $e->getMessage() . "\n");
    exit(1);
}

echo "\nCreated" . ($platform ? ' PLATFORM ADMIN' : ' merchant') . ":\n";
echo "  business : {$name}\n";
echo "  login    : {$res['ownerEmail']}\n";
echo "  merchant : {$res['merchantId']}\n";
echo "\nSign in, then change the password from your profile.\n";
