<?php
declare(strict_types=1);

namespace Afia;

use Afia\Support\Clock;
use Afia\Support\HttpError;

/**
 * Per-request repository over the hybrid document tables. Bound to one merchant
 * id: every read and write is automatically scoped to that merchant, so a
 * handler physically cannot touch another tenant's rows.
 *
 * Platform-level tables (merchants, sessions, login_attempts) are accessed
 * through $repo->db() directly, not through these helpers.
 */
final class Repo
{
    public function __construct(
        private Database $db,
        private string $merchantId,
    ) {}

    public function db(): Database { return $this->db; }
    public function merchantId(): string { return $this->merchantId; }

    private function scoped(string $where): string
    {
        return "merchant_id = :__mid AND ($where)";
    }
    private function withMid(array $params): array
    {
        $params[':__mid'] = $this->merchantId;
        return $params;
    }

    public function doc(string $table, string $id): ?array
    {
        $row = $this->db->first(
            "SELECT doc FROM {$table} WHERE " . $this->scoped('id = :id'),
            $this->withMid([':id' => $id]),
        );
        return $row ? json_decode($row['doc'], true) : null;
    }

    public function findDoc(string $table, string $where, array $params = []): ?array
    {
        $row = $this->db->first(
            "SELECT doc FROM {$table} WHERE " . $this->scoped($where) . ' LIMIT 1',
            $this->withMid($params),
        );
        return $row ? json_decode($row['doc'], true) : null;
    }

    /** @return array<int,array<string,mixed>> */
    public function allDocs(string $table, string $where = '1=1', array $params = [], string $orderBy = 'created_at ASC'): array
    {
        $rows = $this->db->all(
            "SELECT doc FROM {$table} WHERE " . $this->scoped($where) . " ORDER BY {$orderBy}",
            $this->withMid($params),
        );
        return array_map(static fn ($r) => json_decode($r['doc'], true), $rows);
    }

    public function count(string $table, string $where = '1=1', array $params = []): int
    {
        return (int) $this->db->value(
            "SELECT COUNT(*) FROM {$table} WHERE " . $this->scoped($where),
            $this->withMid($params),
        );
    }

    public function exists(string $table, string $where, array $params = []): bool
    {
        return $this->count($table, $where, $params) > 0;
    }

    /** Append-only tables have no `updated_at` column. */
    private const APPEND_ONLY = ['inventory_transactions', 'audit_logs', 'payments', 'customer_ledger'];

    /** Insert a record. $columns maps extracted column => value; merchant_id is added automatically. */
    public function insert(string $table, string $id, array $doc, array $columns = []): array
    {
        $ts = $doc['createdAt'] ?? Clock::now();
        $appendOnly = in_array($table, self::APPEND_ONLY, true);
        $full = array_merge(
            ['id' => $id, 'createdAt' => $ts] + ($appendOnly ? [] : ['updatedAt' => $doc['updatedAt'] ?? $ts]),
            $doc,
        );
        $columns = array_merge(['merchant_id' => $this->merchantId], $columns);

        $cols = array_merge(['id', 'doc', 'created_at'], $appendOnly ? [] : ['updated_at'], array_keys($columns));
        $place = array_map(static fn ($c) => ':' . $c, $cols);
        $params = array_merge(
            [':id' => $id, ':doc' => json_encode($full, JSON_UNESCAPED_UNICODE), ':created_at' => $ts],
            $appendOnly ? [] : [':updated_at' => $full['updatedAt'] ?? $ts],
            self::prefix($columns),
        );
        try {
            $this->db->run(
                "INSERT INTO {$table} (" . implode(',', $cols) . ') VALUES (' . implode(',', $place) . ')',
                $params,
            );
        } catch (\PDOException $e) {
            throw self::translate($e);
        }
        return $full;
    }

    /** Merge $patch into the stored doc; refresh extracted $columns. */
    public function update(string $table, string $id, array $patch = [], array $columns = []): ?array
    {
        $current = $this->doc($table, $id);
        if ($current === null) {
            return null;
        }
        $merged = array_merge($current, $patch, [
            'id' => $current['id'],
            'createdAt' => $current['createdAt'] ?? Clock::now(),
            'updatedAt' => Clock::now(),
        ]);
        $sets = ['doc = :doc', 'updated_at = :updated_at'];
        foreach (array_keys($columns) as $c) {
            $sets[] = "{$c} = :{$c}";
        }
        $params = array_merge(
            [':doc' => json_encode($merged, JSON_UNESCAPED_UNICODE), ':updated_at' => $merged['updatedAt'], ':id' => $id, ':__mid' => $this->merchantId],
            self::prefix($columns),
        );
        try {
            $this->db->run(
                "UPDATE {$table} SET " . implode(', ', $sets) . ' WHERE merchant_id = :__mid AND id = :id',
                $params,
            );
        } catch (\PDOException $e) {
            throw self::translate($e);
        }
        return $merged;
    }

    public function delete(string $table, string $id): void
    {
        $this->db->run(
            "DELETE FROM {$table} WHERE " . $this->scoped('id = :id'),
            $this->withMid([':id' => $id]),
        );
    }

    /** Atomic per-merchant counter. Returns the new value. */
    public function nextSeq(string $key): int
    {
        return $this->db->transaction(function () use ($key) {
            $row = $this->db->first(
                'SELECT v FROM sequences WHERE merchant_id = :m AND k = :k' . $this->db->forUpdate(),
                [':m' => $this->merchantId, ':k' => $key],
            );
            if ($row === null) {
                $this->db->run('INSERT INTO sequences (merchant_id, k, v) VALUES (:m, :k, 1)', [':m' => $this->merchantId, ':k' => $key]);
                return 1;
            }
            $next = (int) $row['v'] + 1;
            $this->db->run('UPDATE sequences SET v = :v WHERE merchant_id = :m AND k = :k', [':v' => $next, ':m' => $this->merchantId, ':k' => $key]);
            return $next;
        });
    }

    public function peekSeq(string $key): int
    {
        return (int) ($this->db->value('SELECT v FROM sequences WHERE merchant_id = :m AND k = :k', [':m' => $this->merchantId, ':k' => $key]) ?? 0);
    }

    public function setSeqFloor(string $key, int $value): void
    {
        $cur = $this->peekSeq($key);
        if ($value <= $cur) {
            return;
        }
        if ($this->db->value('SELECT 1 FROM sequences WHERE merchant_id = :m AND k = :k', [':m' => $this->merchantId, ':k' => $key])) {
            $this->db->run('UPDATE sequences SET v = :v WHERE merchant_id = :m AND k = :k', [':v' => $value, ':m' => $this->merchantId, ':k' => $key]);
        } else {
            $this->db->run('INSERT INTO sequences (merchant_id, k, v) VALUES (:m, :k, :v)', [':m' => $this->merchantId, ':k' => $key, ':v' => $value]);
        }
    }

    /**
     * Paginated list mirroring js/core/mock/router.js applyListQuery.
     * $opts: table, query, searchCols[], filters{param=>col}, sortMap{key=>col},
     *        defaultSort, defaultDir, dateColumn, baseWhere, params[], transform(fn)
     * Returns { data, page, pageSize, total, totalPages, sort, dir }.
     */
    public function list(array $opts): array
    {
        $q = $opts['query'] ?? [];
        $where = ['(' . ($opts['baseWhere'] ?? '1=1') . ')'];
        $params = $opts['params'] ?? [];
        $n = 0;

        $search = trim((string) ($q['search'] ?? $q['q'] ?? ''));
        $searchCols = $opts['searchCols'] ?? [];
        if ($search !== '' && $searchCols) {
            $ors = [];
            foreach ($searchCols as $col) {
                $p = ':s' . $n++;
                $ors[] = "LOWER({$col}) LIKE {$p}";
                $params[$p] = '%' . mb_strtolower($search) . '%';
            }
            $where[] = '(' . implode(' OR ', $ors) . ')';
        }

        foreach (($opts['filters'] ?? []) as $param => $col) {
            $raw = $q[$param] ?? null;
            if ($raw === null || $raw === '' || $raw === 'all') {
                continue;
            }
            $values = explode(',', (string) $raw);
            $ins = [];
            foreach ($values as $v) {
                $p = ':f' . $n++;
                $ins[] = $p;
                $params[$p] = $v;
            }
            $where[] = "{$col} IN (" . implode(',', $ins) . ')';
        }

        $dateColumn = $opts['dateColumn'] ?? null;
        if ($dateColumn && (!empty($q['from']) || !empty($q['to']))) {
            if (!empty($q['from'])) {
                $params[':dfrom'] = self::isoDate((string) $q['from']);
                $where[] = "{$dateColumn} >= :dfrom";
            }
            if (!empty($q['to'])) {
                $params[':dto'] = self::isoDate((string) $q['to']);
                $where[] = "{$dateColumn} <= :dto";
            }
        }

        $whereSql = $this->scoped(implode(' AND ', $where));
        $params[':__mid'] = $this->merchantId;

        $total = (int) $this->db->value("SELECT COUNT(*) FROM {$opts['table']} WHERE {$whereSql}", $params);

        $sortMap = $opts['sortMap'] ?? [];
        $sortKey = (isset($q['sort']) && isset($sortMap[$q['sort']])) ? $q['sort'] : ($opts['defaultSort'] ?? 'created_at');
        $sortCol = $sortMap[$sortKey] ?? ($opts['defaultSort'] ?? 'created_at');
        $dir = (($q['dir'] ?? ($opts['defaultDir'] ?? 'desc')) === 'asc') ? 'ASC' : 'DESC';

        $pageSize = ($q['pageSize'] ?? null) === 'all'
            ? max($total, 1)
            : min(500, max(1, (int) ($q['pageSize'] ?? 20)));
        $totalPages = max(1, (int) ceil($total / $pageSize));
        $page = min(max(1, (int) ($q['page'] ?? 1)), $totalPages);
        $offset = ($page - 1) * $pageSize;

        $rows = $this->db->all(
            "SELECT doc FROM {$opts['table']} WHERE {$whereSql} ORDER BY {$sortCol} {$dir}, id {$dir} LIMIT {$pageSize} OFFSET {$offset}",
            $params,
        );
        $data = array_map(static fn ($r) => json_decode($r['doc'], true), $rows);
        if (!empty($opts['transform'])) {
            $data = array_map($opts['transform'], $data);
        }

        return [
            'data' => $data, 'page' => $page, 'pageSize' => $pageSize,
            'total' => $total, 'totalPages' => $totalPages,
            'sort' => $sortKey, 'dir' => strtolower($dir),
        ];
    }

    private static function prefix(array $columns): array
    {
        $out = [];
        foreach ($columns as $k => $v) {
            $out[':' . $k] = is_bool($v) ? ($v ? 1 : 0) : $v;
        }
        return $out;
    }

    private static function isoDate(string $s): string
    {
        return (new \DateTimeImmutable($s))->format('Y-m-d\TH:i:s.v\Z');
    }

    private static function translate(\PDOException $e): HttpError
    {
        $msg = $e->getMessage();
        if (preg_match('/(?:UNIQUE constraint failed:|Duplicate entry .* for key)\s*[\'"]?[\w.]*?([a-z_]+)/i', $msg, $m)) {
            $labels = [
                'sku' => 'SKU', 'barcode' => 'Barcode', 'email' => 'Email', 'code' => 'Code',
                'invoice_no' => 'Invoice number', 'reference' => 'Reference', 'product_codes' => 'SKU or barcode',
            ];
            $field = strtolower($m[1]);
            return HttpError::conflict(($labels[$field] ?? ucfirst($field)) . ' is already in use');
        }
        return new HttpError(500, 'Database error');
    }
}
