<?php
/**
 * Copy this file to  config/config.php  and fill in real values.
 *
 * On Hostinger, place the whole project so that `config/`, `app/` and `storage/`
 * sit in your account home directory (one level ABOVE public_html) - then this
 * file is physically not reachable from a browser. `config/config.php` is
 * gitignored; never commit real credentials.
 */
return [
    'db' => [
        // hPanel -> Databases -> MySQL Databases shows host/name/user.
        // Host is usually 'localhost' on shared hosting.
        'dsn'      => 'mysql:host=localhost;dbname=uXXXXXX_afiapos;charset=utf8mb4',
        'user'     => 'uXXXXXX_afiapos',
        'password' => 'CHANGE_ME',
    ],

    'session' => [
        // Any long random string. Generate: php -r "echo bin2hex(random_bytes(32));"
        'secret'         => 'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
        'idle_minutes'   => 30,
        'absolute_hours' => 12,
        'cookie_secure'  => true,   // keep true - the site must be served over HTTPS
    ],

    'app' => [
        'env'         => 'production',              // 'development' shows error detail
        'storage_dir' => __DIR__ . '/../storage',   // backups + logs (not web-accessible)
    ],

    // Payment-gateway / card SECRET keys live here ONLY (never in the frontend
    // or the platform_settings row). Super Admin -> Payment Settings configures
    // the visible payment methods (bKash/Nagad/bank/card numbers + Bangla
    // instructions) and picks the driver: 'manual' (merchant submits a
    // transaction ID you approve) and 'mock' need no keys. Fill these in when
    // you wire a real bKash / SSLCommerz / card provider — read only by
    // app/Support/Gateway.php.
    'gateway' => [
        'bkash' => [
            'app_key'    => '',
            'app_secret' => '',
            'username'   => '',
            'password'   => '',
            'sandbox'    => true,
        ],
        'sslcommerz' => [
            'store_id'       => '',
            'store_password' => '',
            'sandbox'        => true,
        ],
    ],
];
