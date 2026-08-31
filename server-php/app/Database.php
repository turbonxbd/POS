<?php
declare(strict_types=1);

namespace Afia;

/**
 * Thin PDO wrapper. Targets MySQL/MariaDB in production; the test suite passes a
 * SQLite DSN so every query runs in-process. SQL across the app is kept to the
 * portable subset (no RETURNING, no vendor JSON funcs in WHERE/ORDER, no partial
 * indexes) so both engines behave the same.
 */
final class Database
{
    private \PDO $pdo;
    private string $driver;
    private int $txDepth = 0;

    public function __construct(array $cfg)
    {
        $dsn = $cfg['dsn'] ?? '';
        if ($dsn === '') {
            throw new \RuntimeException('Database DSN is not configured (config/config.php).');
        }
        $this->pdo = new \PDO($dsn, $cfg['user'] ?? null, $cfg['password'] ?? null, [
            \PDO::ATTR_ERRMODE            => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        $this->driver = (string) $this->pdo->getAttribute(\PDO::ATTR_DRIVER_NAME);
        if ($this->driver === 'sqlite') {
            $this->pdo->exec('PRAGMA foreign_keys = ON');
            $this->pdo->exec('PRAGMA journal_mode = WAL');
        }
    }

    public function driver(): string
    {
        return $this->driver;
    }

    public function pdo(): \PDO
    {
        return $this->pdo;
    }

    /** @return array<int,array<string,mixed>> */
    public function all(string $sql, array $params = []): array
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    /** @return array<string,mixed>|null */
    public function first(string $sql, array $params = []): ?array
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    public function value(string $sql, array $params = []): mixed
    {
        $row = $this->first($sql, $params);
        return $row ? array_values($row)[0] : null;
    }

    public function run(string $sql, array $params = []): int
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount();
    }

    /** Nestable transaction (savepoints not needed - single level is enough). */
    public function transaction(callable $fn): mixed
    {
        if ($this->txDepth === 0) {
            $this->pdo->beginTransaction();
        }
        $this->txDepth++;
        try {
            $result = $fn($this);
            $this->txDepth--;
            if ($this->txDepth === 0) {
                $this->pdo->commit();
            }
            return $result;
        } catch (\Throwable $e) {
            $this->txDepth--;
            if ($this->txDepth === 0 && $this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        }
    }

    public function inTransaction(): bool
    {
        return $this->pdo->inTransaction();
    }

    /** Row-lock clause for counter allocation (MySQL). No-op on SQLite (whole-db lock). */
    public function forUpdate(): string
    {
        return $this->driver === 'mysql' ? ' FOR UPDATE' : '';
    }

    /** @return list<string> column names of a table */
    public function columns(string $table): array
    {
        if ($this->driver === 'mysql') {
            return array_column($this->all("SHOW COLUMNS FROM {$table}"), 'Field');
        }
        return array_column($this->all("PRAGMA table_info({$table})"), 'name');
    }

    public function tables(): array
    {
        return $this->driver === 'mysql'
            ? array_map(static fn ($r) => array_values($r)[0], $this->all('SHOW TABLES'))
            : array_column($this->all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"), 'name');
    }

    /** Load a schema file, splitting on ";" at line ends (portable enough for our DDL). */
    public function executeScript(string $sql): void
    {
        foreach (array_filter(array_map('trim', preg_split('/;\s*\n/', $sql))) as $statement) {
            $statement = trim(preg_replace('/^--.*$/m', '', $statement));
            if ($statement === '') {
                continue;
            }
            $this->pdo->exec($statement);
        }
    }
}
