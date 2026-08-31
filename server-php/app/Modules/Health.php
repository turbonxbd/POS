<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;

final class Health
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/health', static function (Context $ctx): Response {
            $db = 'ok';
            $merchants = 0;
            try {
                $merchants = (int) $ctx->db->value('SELECT COUNT(*) FROM merchants');
            } catch (\Throwable $e) {
                $db = 'error: ' . $e->getMessage();
            }
            return Response::json([
                'status' => $db === 'ok' ? 'ok' : 'degraded',
                'db' => $db,
                'merchants' => $merchants,
                'time' => \Afia\Support\Clock::now(),
                'php' => PHP_VERSION,
            ]);
        });
    }
}
