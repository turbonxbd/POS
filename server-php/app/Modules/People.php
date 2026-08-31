<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Branch;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Password;
use Afia\Support\Resource;
use Afia\Support\Uuid;

/** Customers, roles & permissions, employees (users). Ported from people.routes.js. */
final class People
{
    public static function register(Router $r, App $app): void
    {
        /* ---- customers ---- */
        Resource::register($r, $app, [
            'base' => '/customers', 'table' => 'customers', 'entity' => 'customer',
            'perms' => ['view' => 'customers.view', 'create' => 'customers.create', 'edit' => 'customers.edit'],
            'list' => [
                'searchCols' => ['name', 'phone'],
                'sortMap' => ['name' => 'name', 'createdAt' => 'created_at'],
                'defaultSort' => 'createdAt', 'defaultDir' => 'desc', 'filters' => ['status' => 'status'],
            ],
            'columns' => static fn (array $d) => ['name' => $d['name'] ?? '', 'phone' => $d['phone'] ?? null, 'status' => $d['status'] ?? 'active'],
            'normalize' => static function (array $b, ?array $e) {
                $phone = trim((string) ($b['phone'] ?? ''));
                if ($e === null) {
                    return [
                        'name' => trim((string) ($b['name'] ?? '')) ?: 'Unnamed Customer', 'phone' => $phone,
                        'email' => $b['email'] ?? '', 'address' => $b['address'] ?? '', 'district' => $b['district'] ?? '', 'upazila' => $b['upazila'] ?? '',
                        'openingBalance' => (int) ($b['openingBalance'] ?? 0), 'outstandingBalance' => (int) ($b['openingBalance'] ?? 0),
                        'totalOrders' => 0, 'totalPurchases' => 0, 'loyaltyPoints' => (int) ($b['loyaltyPoints'] ?? 0),
                        'note' => $b['note'] ?? '', 'status' => $b['status'] ?? 'active', 'lastPurchaseAt' => null,
                    ];
                }
                return array_merge($e, array_filter([
                    'name' => isset($b['name']) ? trim((string) $b['name']) : null, 'phone' => $b['phone'] ?? null,
                    'email' => $b['email'] ?? null, 'address' => $b['address'] ?? null, 'note' => $b['note'] ?? null, 'status' => $b['status'] ?? null,
                ], static fn ($v) => $v !== null));
            },
        ]);

        $r->get('/customers/:id/history', fn (Context $c, $p) => self::history($c, $p));
        $r->post('/customers/:id/balance', fn (Context $c, $p) => self::balance($c, $p));

        /* ---- roles ---- */
        $r->get('/roles', fn (Context $c) => self::listRoles($c));
        $r->post('/roles', fn (Context $c) => self::createRole($c));
        $r->patch('/roles/:id', fn (Context $c, $p) => self::updateRole($c, $p));
        $r->delete('/roles/:id', fn (Context $c, $p) => self::deleteRole($c, $p));

        /* ---- employees ---- */
        $r->get('/employees', fn (Context $c) => self::listEmployees($c));
        $r->get('/employees/:id', fn (Context $c, $p) => self::getEmployee($c, $p));
        $r->post('/employees', fn (Context $c) => self::createEmployee($c));
        $r->patch('/employees/:id', fn (Context $c, $p) => self::updateEmployee($c, $p));
        $r->delete('/employees/:id', fn (Context $c, $p) => self::archiveEmployee($c, $p));
        $r->post('/employees/:id/restore', fn (Context $c, $p) => self::restoreEmployee($c, $p));
    }

    /* ------------------------------------------------------------ customers */

    private static function history(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('customers.view');
        $customer = $ctx->repo()->doc('customers', $p['id']) ?? throw HttpError::notFound('Customer');
        return Response::json([
            'customer' => $customer,
            'sales' => $ctx->repo()->allDocs('sales', 'customer_id = :c', [':c' => $p['id']], 'created_at DESC'),
            'returns' => $ctx->repo()->allDocs('sale_returns', 'customer_id = :c', [':c' => $p['id']], 'at DESC'),
            'ledger' => $ctx->repo()->allDocs('customer_ledger', 'customer_id = :c', [':c' => $p['id']], 'at DESC'),
        ]);
    }

    private static function balance(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('customers.balance');
        $customer = $ctx->repo()->doc('customers', $p['id']) ?? throw HttpError::notFound('Customer');
        $b = $ctx->body();
        $delta = (int) ($b['amount'] ?? 0);
        if ($delta <= 0) {
            throw HttpError::badRequest('Enter an amount greater than zero.');
        }
        $isPayment = ($b['type'] ?? null) === 'payment';
        $signed = $isPayment ? -$delta : $delta;
        return $ctx->db->transaction(function () use ($ctx, $p, $customer, $b, $delta, $signed, $isPayment) {
            $lid = Uuid::v4();
            $now = Clock::now();
            $type = $b['type'] ?? 'adjustment';
            $ctx->repo()->insert('customer_ledger', $lid, [
                'id' => $lid, 'customerId' => $p['id'], 'type' => $type, 'refType' => 'manual', 'refId' => null,
                'amount' => $delta, 'balanceDelta' => $signed,
                'note' => $b['note'] ?? ($isPayment ? 'Payment received' : 'Balance adjustment'), 'at' => $now,
            ], ['customer_id' => $p['id'], 'type' => $type, 'ref_type' => 'manual', 'ref_id' => null, 'amount' => $delta, 'at' => $now]);
            // a payment against outstanding balance is cash in — record it for the register + reports
            if ($isPayment) {
                $branch = Branch::require($ctx, null);
                $reg = $ctx->repo()->findDoc('register_sessions', "branch_id = :b AND status = 'open'", [':b' => $branch['id']]);
                $pid = Uuid::v4();
                $ctx->repo()->insert('payments', $pid, [
                    'id' => $pid, 'saleId' => null, 'branchId' => $branch['id'], 'registerSessionId' => $reg['id'] ?? null,
                    'direction' => 'in', 'method' => $b['method'] ?? 'cash', 'provider' => $b['provider'] ?? null,
                    'amount' => $delta, 'reference' => isset($b['reference']) ? mb_substr((string) $b['reference'], 0, 40) : null,
                    'note' => $b['note'] ?? ('Payment from ' . ($customer['name'] ?? 'customer')), 'refType' => 'customer_payment', 'at' => $now,
                ], ['sale_id' => null, 'branch_id' => $branch['id'], 'register_session_id' => $reg['id'] ?? null, 'direction' => 'in', 'method' => $b['method'] ?? 'cash', 'amount' => $delta, 'at' => $now]);
            }
            $row = $ctx->repo()->update('customers', $p['id'], ['outstandingBalance' => max(0, ($customer['outstandingBalance'] ?? 0) + $signed)]);
            Audit::record($ctx, 'update', 'customer', $p['id'], ['meta' => ['field' => 'balance', 'delta' => $signed, 'kind' => $type]]);
            return Response::json($row);
        });
    }

    /* ------------------------------------------------------------ roles */

    private static function listRoles(Context $ctx): Response
    {
        $ctx->requireActor();
        $rows = $ctx->db->all("SELECT doc FROM roles WHERE merchant_id = :m OR merchant_id = ''", [':m' => $ctx->repo()->merchantId()]);
        $roles = array_map(function ($r) use ($ctx) {
            $d = json_decode($r['doc'], true);
            $d['userCount'] = $ctx->repo()->count('users', 'role_id = :r', [':r' => $d['id']]);
            return $d;
        }, $rows);
        usort($roles, static fn ($a, $b) => strcasecmp($a['name'] ?? '', $b['name'] ?? ''));
        return Response::json(['data' => $roles, 'page' => 1, 'pageSize' => max(1, count($roles)), 'total' => count($roles), 'totalPages' => 1, 'sort' => 'name', 'dir' => 'asc']);
    }

    private static function createRole(Context $ctx): Response
    {
        $ctx->requirePermission('roles.manage');
        $b = $ctx->body();
        if (empty($b['name'])) {
            throw HttpError::badRequest('Role name is required', ['name' => 'Required']);
        }
        return $ctx->db->transaction(function () use ($ctx, $b) {
            $id = Uuid::v4();
            $doc = ['id' => $id, 'name' => trim((string) $b['name']), 'description' => $b['description'] ?? '', 'permissions' => $b['permissions'] ?? [], 'discountLimitPct' => (float) ($b['discountLimitPct'] ?? 0), 'system' => false];
            $now = Clock::now();
            $ctx->db->run('INSERT INTO roles (id, merchant_id, name, is_system, doc, created_at, updated_at) VALUES (:id,:m,:n,0,:d,:c,:c)',
                [':id' => $id, ':m' => $ctx->repo()->merchantId(), ':n' => $doc['name'], ':d' => json_encode(array_merge($doc, ['createdAt' => $now, 'updatedAt' => $now])), ':c' => $now]);
            Audit::record($ctx, 'create', 'role', $id, ['after' => $doc]);
            return Response::json($doc, 201);
        });
    }

    private static function roleRow(Context $ctx, string $id): ?array
    {
        $row = $ctx->db->first("SELECT * FROM roles WHERE id = :id AND (merchant_id = :m OR merchant_id = '')", [':id' => $id, ':m' => $ctx->repo()->merchantId()]);
        return $row ?: null;
    }

    private static function updateRole(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('roles.manage');
        $row = self::roleRow($ctx, $p['id']) ?? throw HttpError::notFound('Role');
        $existing = json_decode($row['doc'], true);
        $b = $ctx->body();
        if (($row['is_system'] ?? 0) && isset($b['permissions']) && json_encode($b['permissions']) !== json_encode($existing['permissions'] ?? [])) {
            throw HttpError::conflict('Built-in role permissions are locked. Duplicate it to customise.');
        }
        return $ctx->db->transaction(function () use ($ctx, $p, $row, $existing, $b) {
            $merged = array_merge($existing, [
                'name' => $b['name'] ?? $existing['name'], 'description' => $b['description'] ?? ($existing['description'] ?? ''),
                'permissions' => $b['permissions'] ?? $existing['permissions'], 'discountLimitPct' => $b['discountLimitPct'] ?? ($existing['discountLimitPct'] ?? 0),
                'updatedAt' => Clock::now(),
            ]);
            $ctx->db->run('UPDATE roles SET name = :n, doc = :d, updated_at = :u WHERE id = :id', [':n' => $merged['name'], ':d' => json_encode($merged), ':u' => $merged['updatedAt'], ':id' => $p['id']]);
            Audit::record($ctx, 'update', 'role', $p['id'], ['before' => $existing, 'after' => $merged]);
            return Response::json($merged);
        });
    }

    private static function deleteRole(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('roles.manage');
        $row = self::roleRow($ctx, $p['id']) ?? throw HttpError::notFound('Role');
        if ($row['is_system'] ?? 0) {
            throw HttpError::conflict('Built-in roles cannot be deleted.');
        }
        if ($ctx->repo()->exists('users', 'role_id = :r', [':r' => $p['id']])) {
            throw HttpError::conflict('Reassign users before deleting this role.');
        }
        return $ctx->db->transaction(function () use ($ctx, $p) {
            $ctx->db->run('DELETE FROM roles WHERE id = :id AND merchant_id = :m', [':id' => $p['id'], ':m' => $ctx->repo()->merchantId()]);
            Audit::record($ctx, 'delete', 'role', $p['id']);
            return Response::json(['deleted' => true]);
        });
    }

    /* ------------------------------------------------------------ employees */

    private static function employeeView(Context $ctx, array $userRow): array
    {
        $u = json_decode($userRow['doc'], true);
        $emp = $ctx->repo()->findDoc('employees', 'user_id = :u', [':u' => $u['id']]) ?? [];
        $role = $u['roleId'] ? (self::roleRow($ctx, $u['roleId']) ?: null) : null;
        return [
            'id' => $u['id'], 'name' => $u['name'], 'email' => $u['email'], 'phone' => $u['phone'] ?? ($emp['phone'] ?? ''),
            'roleId' => $u['roleId'] ?? null, 'roleName' => $role ? ($role['name'] ?? '-') : '-', 'status' => $u['status'],
            'branchIds' => $emp['branchIds'] ?? [], 'joinDate' => $emp['joinDate'] ?? ($u['createdAt'] ?? null),
            'lastLoginAt' => $u['lastLoginAt'] ?? null, 'avatar' => $u['avatar'] ?? null,
            'permissionGrants' => $u['permissionGrants'] ?? [], 'permissionRevokes' => $u['permissionRevokes'] ?? [],
            'archivedAt' => $u['archivedAt'] ?? null,
        ];
    }

    private static function listEmployees(Context $ctx): Response
    {
        $ctx->requirePermission('employees.view');
        $q = $ctx->request->query;
        $rows = $ctx->db->all('SELECT doc FROM users WHERE merchant_id = :m', [':m' => $ctx->repo()->merchantId()]);
        $emps = [];
        foreach ($rows as $r) {
            $v = self::employeeView($ctx, $r);
            if (($q['includeArchived'] ?? null) !== 'true' && $v['archivedAt']) {
                continue;
            }
            if (!empty($q['roleId']) && $v['roleId'] !== $q['roleId']) {
                continue;
            }
            if (!empty($q['branchId']) && !in_array($q['branchId'], $v['branchIds'], true)) {
                continue;
            }
            if (!empty($q['status']) && $q['status'] !== 'all' && $v['status'] !== $q['status']) {
                continue;
            }
            $emps[] = $v;
        }
        $search = mb_strtolower(trim((string) ($q['search'] ?? '')));
        if ($search !== '') {
            $emps = array_values(array_filter($emps, static fn ($e) => str_contains(mb_strtolower($e['name'] . ' ' . $e['email'] . ' ' . $e['phone']), $search)));
        }
        usort($emps, static fn ($a, $b) => strcasecmp($a['name'], $b['name']));
        return Response::json(['data' => $emps, 'page' => 1, 'pageSize' => max(1, count($emps)), 'total' => count($emps), 'totalPages' => 1, 'sort' => 'name', 'dir' => 'asc']);
    }

    private static function getEmployee(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('employees.view');
        $row = $ctx->db->first('SELECT doc FROM users WHERE id = :id AND merchant_id = :m', [':id' => $p['id'], ':m' => $ctx->repo()->merchantId()]) ?? throw HttpError::notFound('Employee');
        $view = self::employeeView($ctx, $row);
        $view['salesCount'] = $ctx->repo()->count('sales', 'cashier_id = :c', [':c' => $p['id']]);
        return Response::json($view);
    }

    private static function createEmployee(Context $ctx): Response
    {
        $ctx->requirePermission('employees.manage');
        $b = $ctx->body();
        $email = strtolower(trim((string) ($b['email'] ?? '')));
        if (empty($b['name'])) {
            throw HttpError::badRequest('Name is required', ['name' => 'Required']);
        }
        if ($email === '') {
            throw HttpError::badRequest('Email is required', ['email' => 'Required']);
        }
        if ($ctx->db->first('SELECT 1 FROM users WHERE email = :e', [':e' => $email])) {
            throw HttpError::conflict('An account with this email already exists.');
        }
        if (empty($b['roleId']) || !self::roleRow($ctx, $b['roleId'])) {
            throw HttpError::badRequest('Select a valid role', ['roleId' => 'Required']);
        }
        return $ctx->db->transaction(function () use ($ctx, $b, $email) {
            $uid = Uuid::v4();
            $now = Clock::now();
            $doc = [
                'id' => $uid, 'name' => trim((string) $b['name']), 'email' => $email, 'phone' => $b['phone'] ?? '',
                'roleId' => $b['roleId'], 'status' => $b['status'] ?? 'active',
                'permissionGrants' => $b['permissionGrants'] ?? [], 'permissionRevokes' => $b['permissionRevokes'] ?? [],
                'avatar' => $b['avatar'] ?? null, 'lastLoginAt' => null,
            ];
            $ctx->db->run('INSERT INTO users (id, merchant_id, email, password_hash, role_id, status, is_platform_admin, doc, created_at, updated_at) VALUES (:id,:m,:e,:h,:r,:s,0,:d,:c,:c)',
                [':id' => $uid, ':m' => $ctx->repo()->merchantId(), ':e' => $email, ':h' => Password::hash($b['password'] ?? 'changeme123'), ':r' => $b['roleId'], ':s' => $doc['status'], ':d' => json_encode(array_merge($doc, ['createdAt' => $now, 'updatedAt' => $now])), ':c' => $now]);
            $eid = Uuid::v4();
            $ctx->repo()->insert('employees', $eid, ['id' => $eid, 'userId' => $uid, 'branchIds' => $b['branchIds'] ?? [], 'joinDate' => $b['joinDate'] ?? $now, 'phone' => $b['phone'] ?? ''], ['user_id' => $uid]);
            Audit::record($ctx, 'create', 'employee', $uid, ['after' => ['name' => $doc['name'], 'email' => $email, 'roleId' => $b['roleId']]]);
            return Response::json(['id' => $uid, 'name' => $doc['name'], 'email' => $email, 'roleId' => $b['roleId']], 201);
        });
    }

    private static function updateEmployee(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('employees.manage');
        $row = $ctx->db->first('SELECT doc FROM users WHERE id = :id AND merchant_id = :m', [':id' => $p['id'], ':m' => $ctx->repo()->merchantId()]) ?? throw HttpError::notFound('Employee');
        $user = json_decode($row['doc'], true);
        $b = $ctx->body();

        if ((($b['status'] ?? null) === 'inactive' || !empty($b['roleId'])) && self::isLastOwner($ctx, $user)) {
            throw HttpError::conflict('You are the only Branch Owner. Assign another owner before changing this account.');
        }

        return $ctx->db->transaction(function () use ($ctx, $p, $user, $b) {
            $patch = [];
            foreach (['name', 'phone', 'roleId', 'status', 'avatar', 'permissionGrants', 'permissionRevokes'] as $k) {
                if (array_key_exists($k, $b)) {
                    $patch[$k] = $k === 'name' ? trim((string) $b[$k]) : $b[$k];
                }
            }
            $merged = array_merge($user, $patch, ['updatedAt' => Clock::now()]);
            $hash = !empty($b['password']) ? Password::hash($b['password']) : null;
            $sql = 'UPDATE users SET doc = :d, updated_at = :u, role_id = :r, status = :s' . ($hash ? ', password_hash = :h' : '') . ' WHERE id = :id';
            $params = [':d' => json_encode($merged), ':u' => $merged['updatedAt'], ':r' => $merged['roleId'] ?? null, ':s' => $merged['status'], ':id' => $p['id']];
            if ($hash) {
                $params[':h'] = $hash;
            }
            $ctx->db->run($sql, $params);
            $emp = $ctx->repo()->findDoc('employees', 'user_id = :u', [':u' => $p['id']]);
            if ($emp && (isset($b['branchIds']) || isset($b['joinDate']))) {
                $ctx->repo()->update('employees', $emp['id'], array_filter(['branchIds' => $b['branchIds'] ?? null, 'joinDate' => $b['joinDate'] ?? null], static fn ($v) => $v !== null));
            }
            Audit::record($ctx, 'update', 'employee', $p['id'], ['before' => ['roleId' => $user['roleId'] ?? null, 'status' => $user['status']], 'after' => $patch]);
            return Response::json(['id' => $p['id'], 'name' => $merged['name'], 'roleId' => $merged['roleId'] ?? null, 'status' => $merged['status']]);
        });
    }

    private static function archiveEmployee(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('employees.manage');
        $row = $ctx->db->first('SELECT doc FROM users WHERE id = :id AND merchant_id = :m', [':id' => $p['id'], ':m' => $ctx->repo()->merchantId()]) ?? throw HttpError::notFound('Employee');
        $user = json_decode($row['doc'], true);
        if (($ctx->actor['id'] ?? null) === $p['id']) {
            throw HttpError::conflict('You cannot deactivate your own account.');
        }
        if (self::isLastOwner($ctx, $user)) {
            throw HttpError::conflict('Cannot deactivate the only Branch Owner.');
        }
        return $ctx->db->transaction(function () use ($ctx, $p, $user) {
            $merged = array_merge($user, ['status' => 'inactive', 'archivedAt' => Clock::now(), 'updatedAt' => Clock::now()]);
            $ctx->db->run('UPDATE users SET doc = :d, status = :s, updated_at = :u, archived_at = :a WHERE id = :id',
                [':d' => json_encode($merged), ':s' => 'inactive', ':u' => $merged['updatedAt'], ':a' => $merged['archivedAt'], ':id' => $p['id']]);
            $ctx->db->run('UPDATE sessions SET revoked_at = :n WHERE user_id = :u AND revoked_at IS NULL', [':n' => Clock::now(), ':u' => $p['id']]);
            Audit::record($ctx, 'archive', 'employee', $p['id'], ['before' => $user]);
            return Response::json(['archived' => true, 'id' => $p['id']]);
        });
    }

    private static function restoreEmployee(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('employees.manage');
        $row = $ctx->db->first('SELECT doc FROM users WHERE id = :id AND merchant_id = :m', [':id' => $p['id'], ':m' => $ctx->repo()->merchantId()]) ?? throw HttpError::notFound('Employee');
        $user = json_decode($row['doc'], true);
        return $ctx->db->transaction(function () use ($ctx, $p, $user) {
            $merged = array_merge($user, ['status' => 'active', 'archivedAt' => null, 'updatedAt' => Clock::now()]);
            $ctx->db->run('UPDATE users SET doc = :d, status = :s, updated_at = :u, archived_at = NULL WHERE id = :id',
                [':d' => json_encode($merged), ':s' => 'active', ':u' => $merged['updatedAt'], ':id' => $p['id']]);
            Audit::record($ctx, 'update', 'employee', $p['id'], ['meta' => ['action' => 'restore']]);
            return Response::json(['id' => $p['id'], 'status' => 'active']);
        });
    }

    private static function isLastOwner(Context $ctx, array $user): bool
    {
        if (($user['roleId'] ?? null) !== 'role_owner') {
            return false;
        }
        return $ctx->repo()->count('users', "role_id = 'role_owner' AND status = 'active'") <= 1;
    }
}
