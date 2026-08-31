<?php
declare(strict_types=1);

namespace Afia\Support;

/**
 * Currency math in INTEGER MINOR UNITS (paisa). Ported from js/utils/money.js.
 * Never use floats for money. 2 minor digits (config.locale.currencyMinorUnits).
 */
final class Money
{
    private const MINOR = 2;
    private const FACTOR = 100;

    public static function toMinor(mixed $value): int
    {
        if ($value === null || $value === '') {
            return 0;
        }
        if (is_int($value) || is_float($value)) {
            return (int) round($value * self::FACTOR);
        }
        $cleaned = preg_replace('/[^0-9.\-]/', '', (string) $value);
        if ($cleaned === '' || $cleaned === '-' || $cleaned === '.') {
            return 0;
        }
        return (int) round((float) $cleaned * self::FACTOR);
    }

    public static function toMajor(int $minor): float
    {
        return $minor / self::FACTOR;
    }

    public static function add(int ...$vals): int
    {
        return array_sum(array_map('intval', $vals));
    }

    public static function mul(int $minor, int|float $factor): int
    {
        return (int) round($minor * $factor);
    }

    public static function percent(int $minor, int|float $pct): int
    {
        return (int) round($minor * $pct / 100);
    }

    /**
     * Largest-remainder split of $total across $weights so the parts sum to $total.
     * @param list<int> $weights
     * @return list<int>
     */
    public static function distribute(int $total, array $weights): array
    {
        $sumW = array_sum(array_map(static fn ($w) => max(0, $w), $weights));
        if ($sumW <= 0) {
            return array_fill(0, count($weights), 0);
        }
        $raw = array_map(static fn ($w) => ($total * max(0, $w)) / $sumW, $weights);
        $floored = array_map('floor', $raw);
        $left = $total - array_sum($floored);
        $order = [];
        foreach ($raw as $i => $r) {
            $order[] = ['i' => $i, 'frac' => $r - floor($r)];
        }
        usort($order, static fn ($a, $b) => $b['frac'] <=> $a['frac']);
        for ($k = 0; $k < count($order) && $left > 0; $k++, $left--) {
            $floored[$order[$k]['i']] += 1;
        }
        return array_map('intval', $floored);
    }

    public static function format(int $minor, string $symbol = '৳', bool $withSymbol = true): string
    {
        $neg = $minor < 0;
        $abs = abs($minor);
        $major = intdiv($abs, self::FACTOR);
        $frac = str_pad((string) ($abs % self::FACTOR), self::MINOR, '0', STR_PAD_LEFT);
        $grouped = number_format($major, 0, '.', ',');
        return ($neg ? '-' : '') . ($withSymbol ? $symbol . ' ' : '') . "{$grouped}.{$frac}";
    }
}
