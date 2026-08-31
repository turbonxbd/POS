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

/** Branches, business settings, notifications, audit log, per-merchant backup export. */
final class Org
{
    /** Every merchant-scoped table, for backup export. */
    private const TABLES = [
        'businesses', 'branches', 'roles', 'users', 'employees', 'settings', 'subscriptions',
        'categories', 'brands', 'taxes', 'discounts', 'products',
        'customers', 'suppliers', 'stock', 'inventory_transactions',
        'register_sessions', 'register_movements', 'sales', 'sale_items', 'payments', 'sale_returns',
        'held_sales', 'customer_ledger', 'purchases', 'purchase_returns', 'supplier_payments',
        'expenses', 'stock_adjustments', 'stock_transfers', 'audit_logs', 'notifications',
        'subscription_payments', 'branch_requests',
    ];

    public static function register(Router $r, App $app): void
    {
        /* ---- branches ---- */
        $r->get('/branches', fn (Context $c) => self::listBranches($c));
        $r->post('/branches', fn (Context $c) => self::createBranch($c));
        $r->patch('/branches/:id', fn (Context $c, $p) => self::updateBranch($c, $p));
        $r->delete('/branches/:id', fn (Context $c, $p) => self::archiveBranch($c, $p));

        /* ---- settings ---- */
        $r->get('/settings', fn (Context $c) => Response::json(self::settings($c)));
        $r->put('/settings', fn (Context $c) => self::saveSettings($c));

        /* ---- notifications ---- */
        $r->get('/notifications', fn (Context $c) => self::listNotifications($c));
        $r->post('/notifications/:id/read', fn (Context $c, $p) => self::markRead($c, $p));
        $r->post('/notifications/read-all', fn (Context $c) => self::readAll($c));
        $r->delete('/notifications/:id', fn (Context $c, $p) => self::deleteNotification($c, $p));

        /* ---- audit ---- */
        $r->get('/audit-logs', fn (Context $c) => self::auditLogs($c));

        /* ---- backup ---- */
        $r->get('/backup/export', fn (Context $c) => self::backupExport($c));
        $r->get('/backup/stats', fn (Context $c) => self::backupStats($c));
        $r->post('/backup/import', fn (Context $c) => self::backupImport($c));
    }

    /* ------------------------------------------------------------- branches */

    private static function listBranches(Context $ctx): Response
    {
        $ctx->requirePermission('branches.manage');
        $q = $ctx->request->query;
        $where = ($q['includeArchived'] ?? null) === 'true' ? '1=1' : 'archived_at IS NULL';
        $rows = $ctx->repo()->allDocs('branches', $where, [], 'name ASC');
        $data = array_map(function ($b) use ($ctx) {
            $b['employeeCount'] = 0;
            foreach ($ctx->repo()->allDocs('employees', '1=1') as $e) {
                if (in_array($b['id'], $e['branchIds'] ?? [], true)) {
                    $b['employeeCount']++;
                }
            }
            $b['productsInStock'] = $ctx->repo()->count('stock', 'branch_id = :x AND quantity > 0', [':x' => $b['id']]);
            $b['openRegister'] = $ctx->repo()->exists('register_sessions', "branch_id = :x AND status = 'open'", [':x' => $b['id']]);
            return $b;
        }, $rows);
        return Response::json(['data' => $data, 'page' => 1, 'pageSize' => max(1, count($data)), 'total' => count($data), 'totalPages' => 1, 'sort' => 'name', 'dir' => 'asc']);
    }

    private static function createBranch(Context $ctx): Response
    {
        $ctx->requirePermission('branches.manage');
        $b = $ctx->body();
        if (empty($b['name'])) {
            throw HttpError::badRequest('Branch name is required', ['name' => 'Required']);
        }
        // Plan entitlement: extra branches beyond the plan's included count must
        // be purchased first (POST /billing/branch-request).
        if (empty($b['__branchPurchase'])) {
            $subRow = $ctx->db->first('SELECT doc FROM subscriptions WHERE merchant_id = :m', [':m' => $ctx->merchantId]);
            $sub = $subRow ? json_decode($subRow['doc'], true) : null;
            if ($sub) {
                $used = 0;
                foreach ($ctx->db->all('SELECT doc FROM branches WHERE merchant_id = :m', [':m' => $ctx->merchantId]) as $br) {
                    if (empty(json_decode($br['doc'], true)['archivedAt'])) {
                        $used++;
                    }
                }
                if ($used >= \Afia\Support\Provision::branchLimit($sub)) {
                    throw new HttpError(402, 'Additional branch required', [
                        'message' => 'Additional branch required',
                        'requiresPurchase' => true,
                        'price' => \Afia\Support\Provision::extraBranchPrice($ctx->db, $sub),
                        'included' => (int) ($sub['includedBranches'] ?? 1),
                        'used' => $used,
                    ]);
                }
            }
        }
        $code = strtoupper(preg_replace('/[^A-Z0-9]/', '', strtoupper((string) ($b['code'] ?: $b['name']))));
        $code = substr($code, 0, 6) ?: 'BR';
        if ($ctx->repo()->exists('branches', 'code = :c', [':c' => $code])) {
            throw HttpError::conflict('That branch code is already in use.');
        }
        return $ctx->db->transaction(function () use ($ctx, $b, $code) {
            $id = Uuid::v4();
            $isFirst = $ctx->repo()->count('branches') === 0;
            $doc = ['id' => $id, 'name' => trim((string) $b['name']), 'code' => $code, 'address' => $b['address'] ?? '', 'phone' => $b['phone'] ?? '', 'email' => $b['email'] ?? '', 'isDefault' => $isFirst, 'status' => 'active'];
            $row = $ctx->repo()->insert('branches', $id, $doc, ['code' => $code, 'name' => $doc['name'], 'status' => 'active', 'is_default' => $isFirst ? 1 : 0]);
            Audit::record($ctx, 'create', 'branch', $id, ['after' => $row]);
            return Response::json($row, 201);
        });
    }

    private static function updateBranch(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('branches.manage');
        $existing = $ctx->repo()->doc('branches', $p['id']) ?? throw HttpError::notFound('Branch');
        $b = $ctx->body();
        return $ctx->db->transaction(function () use ($ctx, $p, $existing, $b) {
            $patch = [
                'name' => $b['name'] ?? $existing['name'], 'address' => $b['address'] ?? $existing['address'] ?? '',
                'phone' => $b['phone'] ?? $existing['phone'] ?? '', 'email' => $b['email'] ?? $existing['email'] ?? '',
                'status' => $b['status'] ?? $existing['status'] ?? 'active',
            ];
            $row = $ctx->repo()->update('branches', $p['id'], $patch, ['name' => $patch['name'], 'status' => $patch['status']]);
            Audit::record($ctx, 'update', 'branch', $p['id'], ['before' => $existing, 'after' => $row]);
            return Response::json($row);
        });
    }

    private static function archiveBranch(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('branches.manage');
        $existing = $ctx->repo()->doc('branches', $p['id']) ?? throw HttpError::notFound('Branch');
        if ($existing['isDefault'] ?? false) {
            throw HttpError::conflict('The default branch cannot be archived.');
        }
        if ($ctx->repo()->exists('stock', 'branch_id = :x AND quantity > 0', [':x' => $p['id']])) {
            throw HttpError::conflict('Transfer out remaining stock before archiving this branch.');
        }
        return $ctx->db->transaction(function () use ($ctx, $p, $existing) {
            $row = $ctx->repo()->update('branches', $p['id'], ['archivedAt' => Clock::now(), 'status' => 'archived'], ['status' => 'archived', 'archived_at' => Clock::now()]);
            Audit::record($ctx, 'archive', 'branch', $p['id'], ['before' => $existing]);
            return Response::json(['archived' => true, 'id' => $p['id']]);
        });
    }

    /* ------------------------------------------------------------- settings */

    private static function settingsId(Context $ctx): string
    {
        return 'settings_' . $ctx->repo()->merchantId();
    }

    private static function settings(Context $ctx): array
    {
        $ctx->requireActor();
        return $ctx->repo()->doc('settings', self::settingsId($ctx)) ?? ['id' => self::settingsId($ctx)];
    }

    private static function saveSettings(Context $ctx): Response
    {
        $ctx->requirePermission('settings.manage');
        $body = $ctx->body();
        return $ctx->db->transaction(function () use ($ctx, $body) {
            $id = self::settingsId($ctx);
            $existing = $ctx->repo()->doc('settings', $id);
            $merged = self::deepMerge($existing ?? ['id' => $id], $body);
            $merged['id'] = $id;
            if ($existing) {
                $row = $ctx->repo()->update('settings', $id, $merged);
            } else {
                $row = $ctx->repo()->insert('settings', $id, $merged);
            }

            // Mirror settings.business onto the `businesses` row (read by every
            // panel via /auth/me) and the `merchants` row (read by Super Admin)
            // so the merchant's identity stays consistent everywhere.
            $bp = $body['business'] ?? [];
            $bizPatch = [];
            foreach (['name', 'legalName', 'address', 'phone', 'email', 'website', 'vatNo', 'currency', 'currencySymbol', 'logoId'] as $f) {
                if (array_key_exists($f, $bp)) {
                    $bizPatch[$f] = $bp[$f];
                }
            }
            if ($bizPatch) {
                $bizRow = $ctx->db->first('SELECT id FROM businesses WHERE merchant_id = :m', [':m' => $ctx->merchantId]);
                if ($bizRow) {
                    $nextBiz = $ctx->repo()->update('businesses', $bizRow['id'], $bizPatch);
                    if (isset($bizPatch['name']) && $bizPatch['name'] !== null && ($ctx->merchantId ?? '') !== '') {
                        $mrow = $ctx->db->first('SELECT doc FROM merchants WHERE id = :id', [':id' => $ctx->merchantId]);
                        if ($mrow) {
                            $mdoc = json_decode($mrow['doc'], true);
                            $mdoc['name'] = $nextBiz['name'];
                            $mdoc['updatedAt'] = Clock::now();
                            $ctx->db->run('UPDATE merchants SET name = :n, doc = :d, updated_at = :u WHERE id = :id',
                                [':n' => $nextBiz['name'], ':d' => json_encode($mdoc), ':u' => $mdoc['updatedAt'], ':id' => $ctx->merchantId]);
                        }
                    }
                    Audit::record($ctx, 'settings', 'business', $bizRow['id'], ['after' => $nextBiz]);
                }
            }

            Audit::record($ctx, 'settings', 'settings', $id, ['before' => $existing, 'after' => $row]);
            return Response::json($row);
        });
    }

    /* -------------------------------------------------------- notifications */

    private static function listNotifications(Context $ctx): Response
    {
        $ctx->requireActor();
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        if (($q['unread'] ?? null) === 'true') {
            $where[] = 'is_read = 0';
        }
        if (!empty($q['type']) && $q['type'] !== 'all') {
            $where[] = 'type = :t';
            $params[':t'] = $q['type'];
        }
        $result = $ctx->repo()->list([
            'table' => 'notifications', 'query' => $q, 'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'sortMap' => ['at' => 'at'], 'defaultSort' => 'at', 'defaultDir' => 'desc',
        ]);
        $result['unreadCount'] = $ctx->repo()->count('notifications', 'is_read = 0');
        return Response::json($result);
    }

    private static function markRead(Context $ctx, array $p): Response
    {
        $ctx->requireActor();
        if (!$ctx->repo()->doc('notifications', $p['id'])) {
            throw HttpError::notFound('Notification');
        }
        $ctx->repo()->update('notifications', $p['id'], ['read' => true, 'readAt' => Clock::now()], ['is_read' => 1]);
        return Response::json(['ok' => true]);
    }

    private static function readAll(Context $ctx): Response
    {
        $ctx->requireActor();
        $unread = $ctx->repo()->allDocs('notifications', 'is_read = 0');
        $ctx->db->transaction(function () use ($ctx, $unread) {
            foreach ($unread as $n) {
                $ctx->repo()->update('notifications', $n['id'], ['read' => true, 'readAt' => Clock::now()], ['is_read' => 1]);
            }
        });
        return Response::json(['ok' => true]);
    }

    private static function deleteNotification(Context $ctx, array $p): Response
    {
        $ctx->requireActor();
        $ctx->repo()->delete('notifications', $p['id']);
        return Response::json(['deleted' => true]);
    }

    /* ----------------------------------------------------------- audit logs */

    private static function auditLogs(Context $ctx): Response
    {
        $ctx->requirePermission('audit.view');
        $q = $ctx->request->query;
        $where = ['1=1'];
        $params = [];
        foreach (['entity' => 'entity', 'action' => 'action', 'actorId' => 'actor_id'] as $k => $col) {
            if (!empty($q[$k]) && $q[$k] !== 'all') {
                $where[] = "{$col} = :{$col}";
                $params[":{$col}"] = $q[$k];
            }
        }
        return Response::json($ctx->repo()->list([
            'table' => 'audit_logs', 'query' => $q, 'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'sortMap' => ['at' => 'at', 'action' => 'action', 'entity' => 'entity'],
            'defaultSort' => 'at', 'defaultDir' => 'desc', 'dateColumn' => 'at',
        ]));
    }

    /* -------------------------------------------------------------- backup */

    /** Tables that store binary and need base64 in the JSON backup. */
    private const BLOB_TABLES = ['media'];

    private static function backupExport(Context $ctx): Response
    {
        $ctx->requirePermission('backup.manage');
        $mid = $ctx->repo()->merchantId();
        $collections = [];
        foreach (array_merge(self::TABLES, ['product_codes', 'media']) as $t) {
            $rows = $ctx->db->all("SELECT * FROM {$t} WHERE merchant_id = :m", [':m' => $mid]);
            if (in_array($t, self::BLOB_TABLES, true)) {
                foreach ($rows as &$row) {
                    $row['bytes'] = base64_encode((string) $row['bytes']);
                }
                unset($row);
            }
            $collections[$t] = $rows;
        }
        $sequences = $ctx->db->all('SELECT k, v FROM sequences WHERE merchant_id = :m', [':m' => $mid]);

        Audit::record($ctx, 'settings', 'backup', null, ['meta' => ['action' => 'export']]);
        return Response::json([
            'exportedAt' => Clock::now(),
            'app' => 'afia-pos', 'version' => '2.0', 'merchantId' => $mid,
            'data' => ['collections' => $collections, 'sequences' => $sequences],
        ]);
    }

    private static function backupImport(Context $ctx): Response
    {
        $ctx->requirePermission('backup.manage');
        $body = $ctx->body();
        $data = $body['data'] ?? null;
        if (!is_array($data) || !isset($data['collections'])) {
            throw HttpError::badRequest('Invalid backup file');
        }
        $mid = $ctx->repo()->merchantId();
        $collections = $data['collections'];
        $restoreTables = array_merge(self::TABLES, ['product_codes', 'media']);

        $ctx->db->transaction(function () use ($ctx, $mid, $collections, $data, $restoreTables) {
            foreach ($restoreTables as $t) {
                $ctx->db->run("DELETE FROM {$t} WHERE merchant_id = :m", [':m' => $mid]);
            }
            $ctx->db->run('DELETE FROM sequences WHERE merchant_id = :m', [':m' => $mid]);

            foreach ($restoreTables as $t) {
                $rows = $collections[$t] ?? [];
                if (!$rows) {
                    continue;
                }
                $allowed = array_flip($ctx->db->columns($t));
                foreach ($rows as $row) {
                    if (!is_array($row) || empty($row['id'])) {
                        continue;
                    }
                    $row['merchant_id'] = $mid;   // force ownership regardless of file contents
                    if ($t === 'media' && isset($row['bytes'])) {
                        $row['bytes'] = base64_decode((string) $row['bytes']);
                    }
                    $cols = array_intersect_key($row, $allowed);
                    $names = implode(',', array_keys($cols));
                    $ph = implode(',', array_map(static fn ($k) => ':' . $k, array_keys($cols)));
                    $params = [];
                    foreach ($cols as $k => $v) {
                        $params[':' . $k] = is_array($v) ? json_encode($v) : $v;
                    }
                    $ctx->db->run("INSERT INTO {$t} ({$names}) VALUES ({$ph})", $params);
                }
            }
            foreach ($data['sequences'] ?? [] as $seq) {
                $ctx->db->run('INSERT INTO sequences (merchant_id, k, v) VALUES (:m, :k, :v)', [':m' => $mid, ':k' => $seq['k'], ':v' => (int) $seq['v']]);
            }
        });

        Audit::record($ctx, 'settings', 'backup', null, ['meta' => ['action' => 'import']]);
        return Response::json(['ok' => true, 'stats' => self::countRows($ctx)]);
    }

    private static function backupStats(Context $ctx): Response
    {
        $ctx->requirePermission('backup.manage');
        $counts = [];
        $bytes = 0;
        foreach (self::TABLES as $t) {
            $row = $ctx->db->first("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(doc)),0) AS b FROM {$t} WHERE merchant_id = :m", [':m' => $ctx->repo()->merchantId()]);
            $counts[$t] = (int) $row['n'];
            $bytes += (int) $row['b'];
        }
        return Response::json(['collections' => $counts, 'approxBytes' => $bytes]);
    }

    private static function countRows(Context $ctx): array
    {
        $out = [];
        foreach (self::TABLES as $t) {
            $out[$t] = $ctx->repo()->count($t);
        }
        return $out;
    }

    /* -------------------------------------------------------------- helpers */

    public static function deepMerge(array $target, array $source): array
    {
        foreach ($source as $k => $v) {
            if (is_array($v) && !array_is_list($v) && isset($target[$k]) && is_array($target[$k]) && !array_is_list($target[$k])) {
                $target[$k] = self::deepMerge($target[$k], $v);
            } else {
                $target[$k] = $v;
            }
        }
        return $target;
    }
}
