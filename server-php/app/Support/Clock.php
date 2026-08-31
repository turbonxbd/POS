<?php
declare(strict_types=1);

namespace Afia\Support;

final class Clock
{
    /** ISO-8601 UTC with milliseconds, matching js `new Date().toISOString()`. */
    public static function now(): string
    {
        return (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
    }

    public static function addMinutes(string $iso, int $minutes): string
    {
        return (new \DateTimeImmutable($iso))->modify("+{$minutes} minutes")->format('Y-m-d\TH:i:s.v\Z');
    }

    public static function addHours(string $iso, int $hours): string
    {
        return (new \DateTimeImmutable($iso))->modify("+{$hours} hours")->format('Y-m-d\TH:i:s.v\Z');
    }

    public static function isPast(string $iso): bool
    {
        return strtotime($iso) < time();
    }

    public static function min(string $a, string $b): string
    {
        return strtotime($a) <= strtotime($b) ? $a : $b;
    }
}
