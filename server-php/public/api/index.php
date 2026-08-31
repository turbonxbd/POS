<?php
/**
 * API front controller - the ONLY PHP file the web server exposes.
 *
 * The whole application lives in ../../app (one level ABOVE public_html on
 * Hostinger, so it is never web-accessible). This file just boots it and
 * dispatches the current request.
 */
declare(strict_types=1);

$appDir = getenv('AFIA_APP_DIR')
    ?: (is_dir(__DIR__ . '/../../app') ? __DIR__ . '/../../app' : __DIR__ . '/../app');

require $appDir . '/bootstrap.php';

use Afia\Http\Request;

try {
    $app = afia_app();
    $response = $app->handle(Request::fromGlobals());
} catch (\Throwable $e) {
    error_log('[afia:boot] ' . $e->getMessage());
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['message' => 'Server is not configured correctly.']);
    exit;
}

$response->send();
