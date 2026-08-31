<?php
declare(strict_types=1);

namespace Afia\Support;

/**
 * Password hashing via PHP's native password_hash().
 * Uses Argon2id when the PHP build supports it (Hostinger's PHP 8.x does),
 * otherwise bcrypt. Never stores plaintext; verify() is constant-time.
 */
final class Password
{
    public static function algo(): string|int
    {
        return defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT;
    }

    public static function hash(string $plain): string
    {
        return password_hash($plain, self::algo());
    }

    public static function verify(string $plain, string $hash): bool
    {
        if ($hash === '' || !str_starts_with($hash, '$')) {
            return false;
        }
        return password_verify($plain, $hash);
    }

    public static function needsRehash(string $hash): bool
    {
        return password_needs_rehash($hash, self::algo());
    }
}
