<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;

/**
 * Cross-device real-time change feed (mirror of js/core/mock/sync.routes.js).
 *
 * GET /sync/changes?since=<cursor> -> { cursor, changed: ["products", ...] }
 *
 * The client polls this every few seconds; the answer is only the names of the
 * merchant's tables that hold a row newer than the cursor, so open tables can
 * re-fetch. No row data crosses the wire, and the whole thing is scoped to the
 * caller's merchant_id. Shared hosting can't hold a WebSocket / SSE connection,
 * so this poll is the real-time transport.
 */
final class Sync
{
    /** table => the column that moves when a row changes */
    private const WATCH = [
        'products' => 'updated_at', 'categories' => 'updated_at', 'brands' => 'updated_at',
        'customers' => 'updated_at', 'branches' => 'updated_at', 'suppliers' => 'updated_at',
        'stock' => 'updated_at', 'taxes' => 'updated_at', 'discounts' => 'updated_at',
        'sales' => 'updated_at', 'sale_items' => 'updated_at', 'sale_returns' => 'updated_at',
        'purchases' => 'updated_at', 'register_sessions' => 'updated_at', 'settings' => 'updated_at',
        'expenses' => 'updated_at', 'notifications' => 'updated_at',
        'stock_adjustments' => 'updated_at', 'stock_transfers' => 'updated_at',
        'inventory_transactions' => 'created_at', 'payments' => 'created_at', 'customer_ledger' => 'created_at',
    ];

    public static function register(Router $r, App $app): void
    {
        $r->get('/sync/changes', static function (Context $ctx): Response {
            $ctx->requireActor();
            $mid = $ctx->merchantId ?? '';
            $since = (string) ($ctx->request->query['since'] ?? '');

            $parts = [];
            foreach (self::WATCH as $table => $col) {
                $parts[] = "SELECT '{$table}' AS t, MAX({$col}) AS m FROM {$table} WHERE merchant_id = :m";
            }
            $rows = $ctx->db->all(implode("\nUNION ALL\n", $parts), [':m' => $mid]);

            $changed = [];
            $cursor = $since;
            foreach ($rows as $row) {
                $m = $row['m'];
                if ($m !== null && $m > $since) {
                    $changed[] = $row['t'];
                    if ($m > $cursor) {
                        $cursor = $m;
                    }
                }
            }
            return Response::json(['cursor' => $cursor !== '' ? $cursor : gmdate('Y-m-d\TH:i:s.v\Z'), 'changed' => $changed]);
        });
    }
}
