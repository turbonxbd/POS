<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Database;

/**
 * Payment-gateway driver abstraction.
 *
 *   manual - merchant enters a transaction reference; POS TXbd confirms it from
 *            Super Admin -> Payments. charge() returns 'pending'.
 *   mock   - test gateway, always succeeds instantly ('paid').
 *
 * A real driver (bKash, SSLCommerz, ...) implements charge() with the same
 * shape and reads its SECRET keys from config/ (server-side, above webroot) -
 * never from the request or the client.
 */
final class Gateway
{
    /** @return array{driver:string, displayName:string, instructions:string} */
    public static function active(Database $db): array
    {
        $g = Provision::platformSettings($db)['gateway'] ?? [];
        $driver = in_array($g['driver'] ?? null, ['manual', 'mock'], true) ? $g['driver'] : 'manual';
        return [
            'driver' => $driver,
            'displayName' => $g['displayName'] ?? ($driver === 'mock' ? 'Test gateway' : 'Manual / bank transfer'),
            'instructions' => $g['instructions'] ?? '',
        ];
    }

    /**
     * @return array{status:string, gatewayRef:?string, driver:string}
     */
    public static function charge(Database $db, array $input): array
    {
        $driver = self::active($db)['driver'];
        if ($driver === 'mock') {
            return ['status' => 'paid', 'gatewayRef' => 'MOCK-' . strtoupper(substr(Uuid::v4(), 0, 8)), 'driver' => 'mock'];
        }
        return ['status' => 'pending', 'gatewayRef' => null, 'driver' => 'manual'];
    }
}
