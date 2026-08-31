<?php
/**
 * Test harness - runs the real App in-process against an in-memory SQLite DB.
 * No PHPUnit, no Composer. `php tests/run.php` executes every *_test.php file.
 */
declare(strict_types=1);

require __DIR__ . '/../app/bootstrap.php';

use Afia\App;
use Afia\Database;
use Afia\Http\Request;
use Afia\Support\Clock;
use Afia\Support\Password;
use Afia\Support\Uuid;

final class TestKit
{
    public App $app;
    public Database $db;
    public string $merchantId;
    public string $ownerId;
    public string $branchId;

    public function __construct()
    {
        $config = [
            'db' => ['dsn' => 'sqlite::memory:', 'user' => null, 'password' => null],
            'session' => ['secret' => 'test-secret', 'idle_minutes' => 30, 'absolute_hours' => 12, 'cookie_secure' => false],
            'app' => ['env' => 'development', 'storage_dir' => sys_get_temp_dir()],
        ];
        $this->db = new Database($config['db']);
        $this->db->executeScript(file_get_contents(__DIR__ . '/../migrations/schema.sql'));
        $this->app = new App($this->db, $config);
        $this->seed();
    }

    private function seed(): void
    {
        $now = Clock::now();
        $this->merchantId = Uuid::v4();
        $put = function (string $table, string $id, array $doc, array $cols = []) use ($now) {
            $full = array_merge(['id' => $id, 'createdAt' => $now, 'updatedAt' => $now], $doc);
            $cols = array_merge(['merchant_id' => $this->merchantId], $cols);
            $names = array_merge(['id', 'doc', 'created_at', 'updated_at'], array_keys($cols));
            $ph = array_map(fn ($n) => ':' . $n, $names);
            $params = array_merge([':id' => $id, ':doc' => json_encode($full), ':created_at' => $now, ':updated_at' => $now], self::pfx($cols));
            $this->db->run("INSERT INTO {$table} (" . implode(',', $names) . ') VALUES (' . implode(',', $ph) . ')', $params);
        };

        $this->db->run('INSERT INTO merchants (id, name, status, doc, created_at, updated_at) VALUES (:id,:n,:s,:d,:c,:c)',
            [':id' => $this->merchantId, ':n' => 'Test Shop', ':s' => 'active',
             ':d' => json_encode(['id' => $this->merchantId, 'name' => 'Test Shop', 'status' => 'active']), ':c' => $now]);

        $put('businesses', Uuid::v4(), ['name' => 'Test Shop', 'currency' => 'BDT', 'currencySymbol' => '৳']);
        $this->branchId = Uuid::v4();
        $put('branches', $this->branchId, ['name' => 'Main', 'code' => 'MAIN', 'isDefault' => true, 'status' => 'active'],
            ['code' => 'MAIN', 'name' => 'Main', 'status' => 'active', 'is_default' => 1]);

        foreach (self::rolePresets() as $role) {
            $this->db->run("INSERT INTO roles (id, merchant_id, name, is_system, doc, created_at, updated_at) VALUES (:id,'',:n,1,:d,:c,:c)",
                [':id' => $role['id'], ':n' => $role['name'], ':d' => json_encode($role), ':c' => $now]);
        }

        $this->ownerId = Uuid::v4();
        $put('users', $this->ownerId, [
            'name' => 'Owner', 'email' => 'owner@test.shop', 'roleId' => 'role_owner', 'status' => 'active',
            'permissionGrants' => [], 'permissionRevokes' => [], 'lastLoginAt' => null,
        ], ['email' => 'owner@test.shop', 'password_hash' => Password::hash('sup3rsecret'), 'role_id' => 'role_owner', 'status' => 'active']);
        $put('employees', Uuid::v4(), ['userId' => $this->ownerId, 'branchIds' => []], ['user_id' => $this->ownerId]);

        \Afia\Support\Provision::ensureDefaultPlans($this->db);
        \Afia\Support\Provision::ensurePlatformSettings($this->db);
    }

    public string $platformAdminId = '';

    /** Create + sign in a platform Super Admin. */
    public function loginPlatform(): array
    {
        if ($this->platformAdminId === '') {
            $now = Clock::now();
            $this->platformAdminId = Uuid::v4();
            $this->db->run("INSERT INTO users (id,merchant_id,email,password_hash,role_id,status,is_platform_admin,doc,created_at,updated_at) VALUES (:i,:m,:e,:h,'role_super_admin','active',1,:d,:c,:c)",
                [':i' => $this->platformAdminId, ':m' => $this->merchantId, ':e' => 'root@postxbd.io',
                 ':h' => Password::hash('rootpass123'), ':d' => json_encode(['id' => $this->platformAdminId, 'name' => 'Root Admin', 'email' => 'root@postxbd.io', 'roleId' => 'role_super_admin', 'status' => 'active', 'permissionGrants' => [], 'permissionRevokes' => []]), ':c' => $now]);
        }
        return $this->loginAs('root@postxbd.io', 'rootpass123');
    }

    public function planId(string $name = 'Business'): string
    {
        foreach ($this->db->all('SELECT doc FROM plans') as $r) {
            $d = json_decode($r['doc'], true);
            if ($d['name'] === $name) {
                return $d['id'];
            }
        }
        return '';
    }

    public function request(string $method, string $path, array $opts = []): array
    {
        $headers = array_change_key_case($opts['headers'] ?? [], CASE_LOWER);
        $cookies = $opts['cookies'] ?? [];
        $body = '';
        if (isset($opts['json'])) {
            $body = json_encode($opts['json']);
            $headers['content-type'] = 'application/json';
        }
        $req = new Request(strtoupper($method), $path, $opts['query'] ?? [], $headers, $body, $cookies, '203.0.113.7');
        $res = $this->app->handle($req);
        return [
            'status' => $res->status,
            'body' => $res->data,
            'raw' => $res->raw,
            'headers' => $res->headers,
            'cookies' => $res->cookies,
        ];
    }

    /** Log in and return a cookie jar + csrf token. */
    public function loginAs(string $email = 'owner@test.shop', string $password = 'sup3rsecret'): array
    {
        $res = $this->request('POST', '/api/auth/login', ['json' => ['email' => $email, 'password' => $password]]);
        $jar = [];
        $csrf = '';
        foreach ($res['cookies'] as $c) {
            [$pair] = explode(';', $c, 2);
            [$k, $v] = explode('=', $pair, 2);
            $jar[$k] = rawurldecode($v);
            if ($k === 'csrf_token') {
                $csrf = rawurldecode($v);
            }
        }
        return ['jar' => $jar, 'csrf' => $csrf, 'login' => $res];
    }

    private static function pfx(array $c): array
    {
        $o = [];
        foreach ($c as $k => $v) {
            $o[':' . $k] = is_bool($v) ? (int) $v : $v;
        }
        return $o;
    }

    private static function rolePresets(): array
    {
        // condensed from js/data/permissions.js ROLE_PRESETS
        return [
            ['id' => 'role_super_admin', 'name' => 'Super Admin', 'system' => true, 'permissions' => ['*'], 'discountLimitPct' => 100],
            ['id' => 'role_owner', 'name' => 'Branch Owner', 'system' => true, 'permissions' => ['*'], 'discountLimitPct' => 100],
            ['id' => 'role_cashier', 'name' => 'Cashier', 'system' => true, 'permissions' => ['pos.operate', 'sales.create', 'sales.view', 'products.view', 'inventory.view', 'customers.view', 'customers.create'], 'discountLimitPct' => 10],
        ];
    }
}

/* ---- assertions ---- */
$GLOBALS['__afia_tests'] = ['pass' => 0, 'fail' => 0, 'fails' => []];

function test(string $name, callable $fn): void
{
    try {
        $fn();
        $GLOBALS['__afia_tests']['pass']++;
        fwrite(STDOUT, "  ok   $name\n");
    } catch (\Throwable $e) {
        $GLOBALS['__afia_tests']['fail']++;
        $GLOBALS['__afia_tests']['fails'][] = "$name :: {$e->getMessage()}";
        fwrite(STDOUT, "  FAIL $name :: {$e->getMessage()}\n");
    }
}

function expect($cond, string $msg = 'assertion failed'): void
{
    if (!$cond) {
        throw new \RuntimeException($msg);
    }
}

function expect_eq($actual, $expected, string $msg = ''): void
{
    if ($actual !== $expected) {
        throw new \RuntimeException(($msg ?: 'not equal') . ' - expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

/* ---- shared request helpers ---- */

function authed(TestKit $kit, array $s, string $method, string $path, array $opts = []): array
{
    $opts['cookies'] = $s['jar'];
    $opts['headers'] = array_merge($opts['headers'] ?? [], ['x-csrf-token' => $s['csrf']]);
    return $kit->request($method, $path, $opts);
}

/** create a stocked product via the API, return its decorated body */
function mkProduct(TestKit $kit, array $s, string $name, string $sku, string $bc, int $cost, int $sell, int $qty, ?int $taxRate = null): array
{
    $taxId = null;
    if ($taxRate !== null) {
        $taxId = \Afia\Support\Uuid::v4();
        $now = \Afia\Support\Clock::now();
        $kit->db->run("INSERT INTO taxes (id, merchant_id, name, is_default, status, doc, created_at, updated_at) VALUES (:id,:m,:n,0,'active',:d,:c,:c)",
            [':id' => $taxId, ':m' => $kit->merchantId, ':n' => "VAT {$taxRate}", ':d' => json_encode(['id' => $taxId, 'name' => "VAT {$taxRate}", 'rate' => $taxRate, 'inclusive' => false, 'status' => 'active']), ':c' => $now]);
    }
    return authed($kit, $s, 'POST', '/api/products', ['json' => array_filter([
        'name' => $name, 'sku' => $sku, 'barcode' => $bc, 'costPrice' => $cost, 'sellingPrice' => $sell, 'taxId' => $taxId,
        'branchStock' => [['branchId' => $kit->branchId, 'qty' => $qty]],
    ], static fn ($v) => $v !== null)])['body'];
}

function stockNow(TestKit $kit, array $s, string $productId): int
{
    $inv = authed($kit, $s, 'GET', '/api/inventory', ['query' => ['branchId' => $kit->branchId, 'product' => $productId]]);
    return $inv['body']['data'][0]['quantity'] ?? -999;
}
