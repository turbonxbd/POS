<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Uuid;

/**
 * Subscription plans. Platform-wide (one source of truth for pricing):
 *   GET  /plans                 - PUBLIC, active plans for the Live panel
 *   GET  /platform/plans        - Super Admin, all plans
 *   POST /platform/plans        - Super Admin
 *   PATCH  /platform/plans/:id
 *   DELETE /platform/plans/:id  - archive (never hard-deleted; subscriptions reference it)
 */
final class Plans
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/plans', fn (Context $c) => self::publicList($c));
        $r->get('/platform/plans', fn (Context $c) => self::adminList($c));
        $r->post('/platform/plans', fn (Context $c) => self::create($c));
        $r->patch('/platform/plans/:id', fn (Context $c, $p) => self::update($c, $p));
        $r->delete('/platform/plans/:id', fn (Context $c, $p) => self::archive($c, $p));
    }

    /** @return list<array> */
    public static function all(Context $ctx, bool $activeOnly): array
    {
        $where = $activeOnly ? "status = 'active' AND archived_at IS NULL" : '1=1';
        $rows = $ctx->db->all("SELECT doc FROM plans WHERE {$where} ORDER BY sort_order ASC, price ASC");
        return array_map(static fn ($x) => json_decode($x['doc'], true), $rows);
    }

    private static function publicList(Context $ctx): Response
    {
        // no auth: this is the shop window
        return Response::json(['data' => self::all($ctx, true)]);
    }

    private static function adminList(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        return Response::json(['data' => self::all($ctx, false)]);
    }

    private static function normalize(array $b, ?array $e): array
    {
        $monthly = null;
        if (isset($b['monthlyPrice'])) {
            $monthly = max(0, (int) $b['monthlyPrice']);
        } elseif (isset($b['price'])) {
            $monthly = max(0, (int) $b['price']);
        }
        $extra = null;
        if (array_key_exists('extraBranchPrice', $b)) {
            $extra = ($b['extraBranchPrice'] === '' || $b['extraBranchPrice'] === null) ? null : max(0, (int) $b['extraBranchPrice']);
        }
        $d = array_merge($e ?? [
            'features' => [], 'limits' => new \stdClass(), 'popular' => false, 'status' => 'active', 'sortOrder' => 0,
        ], array_filter([
            'name' => isset($b['name']) ? trim((string) $b['name']) : null,
            'description' => $b['description'] ?? null,
            'monthlyPrice' => $monthly,
            'setupPrice' => isset($b['setupPrice']) ? max(0, (int) $b['setupPrice']) : null,
            'includedBranches' => isset($b['includedBranches']) ? max(0, (int) $b['includedBranches']) : null,
            'billingPeriod' => in_array($b['billingPeriod'] ?? null, ['monthly', 'yearly'], true) ? $b['billingPeriod'] : null,
            'currency' => $b['currency'] ?? null,
            'currencySymbol' => $b['currencySymbol'] ?? null,
            'features' => is_array($b['features'] ?? null) ? array_values($b['features']) : null,
            'limits' => is_array($b['limits'] ?? null) ? $b['limits'] : null,
            'popular' => isset($b['popular']) ? (bool) $b['popular'] : null,
            'status' => in_array($b['status'] ?? null, ['active', 'archived'], true) ? $b['status'] : null,
            'sortOrder' => isset($b['sortOrder']) ? (int) $b['sortOrder'] : null,
        ], static fn ($v) => $v !== null));
        if (array_key_exists('extraBranchPrice', $b)) {
            $d['extraBranchPrice'] = $extra;
        }
        $d += ['currency' => 'BDT', 'currencySymbol' => '৳', 'description' => ''];
        // setting a plan back to Active un-archives it (else the active list still hides it)
        if (($d['status'] ?? null) === 'active') {
            $d['archivedAt'] = null;
        } elseif (($d['status'] ?? null) === 'archived' && empty($d['archivedAt'])) {
            $d['archivedAt'] = Clock::now();
        }
        $d['monthlyPrice'] = max(0, (int) ($d['monthlyPrice'] ?? $d['price'] ?? 0));
        $d['price'] = $d['monthlyPrice']; // mirror
        $d['setupPrice'] = max(0, (int) ($d['setupPrice'] ?? 0));
        $d['includedBranches'] = (int) ($d['includedBranches'] ?? (is_array($d['limits'] ?? null) ? ($d['limits']['branches'] ?? 1) : 1) ?: 1);
        $d['extraBranchPrice'] = $d['extraBranchPrice'] ?? null;
        return $d;
    }

    private static function create(Context $ctx): Response
    {
        $ctx->requirePlatformAdmin();
        $b = $ctx->body();
        $priceGiven = isset($b['price']) || isset($b['monthlyPrice']);
        if (trim((string) ($b['name'] ?? '')) === '' || !$priceGiven) {
            throw HttpError::badRequest('Plan name and monthly price are required', [
                'name' => empty($b['name']) ? 'Required' : null, 'monthlyPrice' => !$priceGiven ? 'Required' : null,
            ]);
        }
        $id = Uuid::v4();
        $now = Clock::now();
        $doc = self::normalize($b, null) + ['id' => $id, 'createdAt' => $now, 'updatedAt' => $now];
        $ctx->db->run(
            'INSERT INTO plans (id, merchant_id, name, price, billing_period, status, sort_order, doc, created_at, updated_at)
             VALUES (:id, \'\', :n, :p, :bp, :s, :o, :d, :c, :c)',
            [':id' => $id, ':n' => $doc['name'], ':p' => $doc['price'], ':bp' => $doc['billingPeriod'] ?? 'monthly',
             ':s' => $doc['status'], ':o' => $doc['sortOrder'] ?? 0, ':d' => json_encode($doc), ':c' => $now],
        );
        Audit::record($ctx, 'create', 'plan', $id, ['after' => $doc]);
        return Response::json($doc, 201);
    }

    private static function update(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        $row = $ctx->db->first('SELECT doc FROM plans WHERE id = :id', [':id' => $p['id']]) ?? throw HttpError::notFound('Plan');
        $existing = json_decode($row['doc'], true);
        $doc = self::normalize($ctx->body(), $existing);
        $doc['id'] = $p['id'];
        $doc['updatedAt'] = Clock::now();
        $ctx->db->run(
            'UPDATE plans SET name = :n, price = :p, billing_period = :bp, status = :s, sort_order = :o, archived_at = :ar, doc = :d, updated_at = :u WHERE id = :id',
            [':n' => $doc['name'], ':p' => $doc['price'], ':bp' => $doc['billingPeriod'] ?? 'monthly', ':s' => $doc['status'],
             ':o' => $doc['sortOrder'] ?? 0, ':ar' => $doc['archivedAt'] ?? null, ':d' => json_encode($doc), ':u' => $doc['updatedAt'], ':id' => $p['id']],
        );
        Audit::record($ctx, 'update', 'plan', $p['id'], ['before' => $existing, 'after' => $doc]);
        return Response::json($doc);
    }

    private static function archive(Context $ctx, array $p): Response
    {
        $ctx->requirePlatformAdmin();
        if (!$ctx->db->first('SELECT 1 FROM plans WHERE id = :id', [':id' => $p['id']])) {
            throw HttpError::notFound('Plan');
        }
        $ctx->db->run("UPDATE plans SET status = 'archived', archived_at = :a, updated_at = :a WHERE id = :id", [':a' => Clock::now(), ':id' => $p['id']]);
        Audit::record($ctx, 'archive', 'plan', $p['id']);
        return Response::json(['archived' => true, 'id' => $p['id']]);
    }
}
