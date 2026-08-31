<?php
/**
 * bootstrap.php - autoloader + configuration + application factory.
 * Kept dependency-free: no Composer, no framework. Hostinger shared hosting
 * runs this as plain PHP 8.x.
 */
declare(strict_types=1);

define('AFIA_APP_DIR', __DIR__);
define('AFIA_ROOT_DIR', dirname(__DIR__));

spl_autoload_register(static function (string $class): void {
    $prefix = 'Afia\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = AFIA_APP_DIR . '/' . $relative . '.php';
    if (is_file($file)) {
        require $file;
    }
});

/**
 * Load config. Precedence:
 *   1. $overrides passed in (tests)
 *   2. config/config.php beside the app  (production - kept outside the web root)
 *   3. environment variables (AFIA_DB_DSN, AFIA_DB_USER, ...)
 *   4. safe defaults
 */
function afia_config(array $overrides = []): array
{
    static $cache = null;
    if ($overrides) {
        $cache = null; // tests reconfigure
    }
    if ($cache !== null) {
        return $cache;
    }

    $defaults = [
        'db' => [
            'dsn'     => getenv('AFIA_DB_DSN') ?: '',
            'user'    => getenv('AFIA_DB_USER') ?: '',
            'password'=> getenv('AFIA_DB_PASSWORD') ?: '',
        ],
        'session' => [
            'secret'             => getenv('AFIA_SESSION_SECRET') ?: '',
            'idle_minutes'       => (int) (getenv('AFIA_SESSION_IDLE_MINUTES') ?: 30),
            'absolute_hours'     => (int) (getenv('AFIA_SESSION_ABSOLUTE_HOURS') ?: 12),
            'cookie_secure'      => (getenv('AFIA_COOKIE_SECURE') ?: 'true') !== 'false',
        ],
        'app' => [
            'env'        => getenv('AFIA_ENV') ?: 'production',
            'storage_dir'=> getenv('AFIA_STORAGE_DIR') ?: (AFIA_ROOT_DIR . '/storage'),
        ],
    ];

    $fileConfig = [];
    $configFile = AFIA_ROOT_DIR . '/config/config.php';
    if (is_file($configFile)) {
        $fileConfig = require $configFile;
    }

    $cache = array_replace_recursive($defaults, is_array($fileConfig) ? $fileConfig : [], $overrides);
    return $cache;
}

function afia_app(array $configOverrides = []): \Afia\App
{
    $config = afia_config($configOverrides);
    $db = new \Afia\Database($config['db']);
    return new \Afia\App($db, $config);
}
