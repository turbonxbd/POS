<?php
declare(strict_types=1);

namespace Afia\Support;

final class Uuid
{
    /** RFC-4122 v4, matches js/utils/id.js uuid(). */
    public static function v4(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        $h = bin2hex($b);
        return sprintf('%s-%s-%s-%s-%s', substr($h, 0, 8), substr($h, 8, 4), substr($h, 12, 4), substr($h, 16, 4), substr($h, 20, 12));
    }

    private const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

    public static function short(int $len = 8): string
    {
        $out = '';
        $bytes = random_bytes($len);
        for ($i = 0; $i < $len; $i++) {
            $out .= self::ALPHABET[ord($bytes[$i]) % strlen(self::ALPHABET)];
        }
        return $out;
    }

    /** Deterministic SKU suggestion from a name + optional variant tokens (js/utils/id.js suggestSku). */
    public static function suggestSku(string $name, array $tokens = []): string
    {
        $words = array_slice(array_filter(preg_split('/\s+/', preg_replace('/[^A-Z0-9\s]/', '', strtoupper($name)))), 0, 3);
        $base = implode('-', array_map(static fn ($w) => substr($w, 0, 3), $words));
        $tail = implode('-', array_map(
            static fn ($t) => substr(preg_replace('/[^A-Z0-9]/', '', strtoupper((string) $t)), 0, 4),
            array_filter($tokens),
        ));
        return implode('-', array_filter([$base ?: 'ITEM', $tail, self::short(4)]));
    }

    public static function token(int $bytes = 32): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }

    /**
     * EAN-13 in the "200" in-store range with a valid check digit
     * (mirrors js/utils/id.js). Uses real entropy so two products created
     * seconds apart never collide - callers still retry against a
     * per-merchant uniqueness check.
     */
    public static function ean13(?int $seed = null): string
    {
        $rnd = random_int(0, 999999999);
        if ($seed !== null) {
            $s = preg_replace('/\D/', '', (string) abs($seed));
            $n = substr(substr($s, -6) . str_pad((string) ($rnd % 1000), 3, '0', STR_PAD_LEFT), -9);
        } else {
            $n = (string) $rnd;
        }
        $base = substr('200' . str_pad($n, 9, '0', STR_PAD_LEFT), 0, 12);
        $sum = 0;
        for ($i = 0; $i < 12; $i++) {
            $sum += (int) $base[$i] * ($i % 2 === 0 ? 1 : 3);
        }
        return $base . ((10 - ($sum % 10)) % 10);
    }
}
