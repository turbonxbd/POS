<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Database;
use Afia\Http\Request;

/**
 * Server-side login sessions. The browser holds ONE opaque, HMAC-signed,
 * httpOnly cookie carrying the session id; all state lives in the `sessions`
 * table. A separate readable `csrf_token` cookie is matched against the
 * X-CSRF-Token header on unsafe requests (js/core/http.js already sends it).
 */
final class Session
{
    public const COOKIE = 'afia_sid';
    public const CSRF_COOKIE = 'csrf_token';

    public function __construct(private Database $db, private array $cfg) {}

    private function secret(): string
    {
        $s = (string) ($this->cfg['secret'] ?? '');
        if ($s === '') {
            throw new \RuntimeException('AFIA_SESSION_SECRET is not configured.');
        }
        return $s;
    }

    private function sign(string $id): string
    {
        return rtrim(strtr(base64_encode(hash_hmac('sha256', $id, $this->secret(), true)), '+/', '-_'), '=');
    }

    /** @return list<string> Set-Cookie header values */
    public function start(array $user, Request $req): array
    {
        $id = Uuid::v4() . Uuid::v4();
        $id = str_replace('-', '', $id);
        $csrf = Uuid::token();
        $now = Clock::now();
        $idle = (int) ($this->cfg['idle_minutes'] ?? 30);
        $abs = (int) ($this->cfg['absolute_hours'] ?? 12);
        $hard = Clock::addHours($now, $abs);
        $expires = Clock::min(Clock::addMinutes($now, $idle), $hard);

        $this->db->run(
            'INSERT INTO sessions (id, user_id, merchant_id, csrf, created_at, last_seen_at, expires_at, hard_expires_at, user_agent, ip)
             VALUES (:id, :uid, :mid, :csrf, :c, :c, :exp, :hard, :ua, :ip)',
            [
                ':id' => $id, ':uid' => $user['id'], ':mid' => $user['merchantId'] ?? '',
                ':csrf' => $csrf, ':c' => $now, ':exp' => $expires, ':hard' => $hard,
                ':ua' => mb_substr((string) $req->header('user-agent', ''), 0, 255) ?: null,
                ':ip' => $req->ip,
            ],
        );

        $value = $id . '.' . $this->sign($id);
        $maxAge = $abs * 3600;
        return [
            self::cookie(self::COOKIE, $value, true, $maxAge),
            self::cookie(self::CSRF_COOKIE, $csrf, false, $maxAge),
        ];
    }

    /** @return array{session:array,user_row:array,csrf:string}|null */
    public function read(Request $req): ?array
    {
        $raw = $req->cookie(self::COOKIE);
        if (!$raw || !str_contains($raw, '.')) {
            return null;
        }
        [$id, $sig] = explode('.', $raw, 2);
        if (!hash_equals($this->sign($id), $sig)) {
            return null;
        }
        $row = $this->db->first('SELECT * FROM sessions WHERE id = :id', [':id' => $id]);
        if (!$row || $row['revoked_at'] || Clock::isPast($row['expires_at']) || Clock::isPast($row['hard_expires_at'])) {
            return null;
        }
        $userRow = $this->db->first('SELECT * FROM users WHERE id = :id', [':id' => $row['user_id']]);
        if (!$userRow || $userRow['status'] !== 'active') {
            return null;
        }
        // slide the idle window, capped by the absolute expiry
        $idle = (int) ($this->cfg['idle_minutes'] ?? 30);
        $slid = Clock::min(Clock::addMinutes(Clock::now(), $idle), $row['hard_expires_at']);
        $this->db->run('UPDATE sessions SET last_seen_at = :n, expires_at = :e WHERE id = :id', [':n' => Clock::now(), ':e' => $slid, ':id' => $id]);

        return ['session' => $row, 'user_row' => $userRow, 'csrf' => $row['csrf']];
    }

    /** @return list<string> */
    public function destroy(Request $req): array
    {
        $raw = $req->cookie(self::COOKIE);
        if ($raw && str_contains($raw, '.')) {
            $this->db->run('UPDATE sessions SET revoked_at = :n WHERE id = :id', [':n' => Clock::now(), ':id' => explode('.', $raw)[0]]);
        }
        return [
            self::cookie(self::COOKIE, '', true, 0),
            self::cookie(self::CSRF_COOKIE, '', false, 0),
        ];
    }

    public function revokeOtherSessions(string $userId, string $keepSessionId): void
    {
        $this->db->run('UPDATE sessions SET revoked_at = :n WHERE user_id = :u AND id <> :k AND revoked_at IS NULL',
            [':n' => Clock::now(), ':u' => $userId, ':k' => $keepSessionId]);
    }

    public function assertCsrf(Request $req, string $csrf): void
    {
        $header = (string) $req->header('x-csrf-token', '');
        if ($csrf === '' || !hash_equals($csrf, $header)) {
            throw HttpError::forbidden('Invalid or missing CSRF token');
        }
    }

    private function cookie(string $name, string $value, bool $httpOnly, int $maxAge): string
    {
        $secure = ($this->cfg['cookie_secure'] ?? true) ? '; Secure' : '';
        $ho = $httpOnly ? '; HttpOnly' : '';
        return sprintf('%s=%s; Max-Age=%d; Path=/; SameSite=Lax%s%s', $name, rawurlencode($value), $maxAge, $secure, $ho);
    }
}
