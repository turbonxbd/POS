<?php
declare(strict_types=1);

namespace Afia\Support;

/** Named date-range presets -> {from,to} ISO. Ported from js/utils/date.js resolveRange(). */
final class Range
{
    public static function resolve(?string $preset, ?string $from = null, ?string $to = null): array
    {
        if ($from || $to) {
            return [
                'from' => $from ? (new \DateTimeImmutable($from))->setTime(0, 0, 0)->format(self::F) : '1970-01-01T00:00:00.000Z',
                'to' => $to ? (new \DateTimeImmutable($to))->setTime(23, 59, 59)->format(self::F) : (new \DateTimeImmutable('now', self::utc()))->format(self::F),
            ];
        }
        $now = new \DateTimeImmutable('now', self::utc());
        $wrap = static fn (\DateTimeInterface $a, \DateTimeInterface $b) => ['from' => $a->format(self::F), 'to' => $b->format(self::F)];
        $sod = static fn (\DateTimeImmutable $d) => $d->setTime(0, 0, 0);
        $eod = static fn (\DateTimeImmutable $d) => $d->setTime(23, 59, 59, 999999);

        return match ($preset) {
            'today' => $wrap($sod($now), $eod($now)),
            'yesterday' => $wrap($sod($now->modify('-1 day')), $eod($now->modify('-1 day'))),
            'this_week' => $wrap($sod($now->modify('monday this week')), $eod($now)),
            'last_week' => $wrap($sod($now->modify('monday last week')), $eod($now->modify('sunday last week'))),
            'this_month' => $wrap($sod($now->modify('first day of this month')), $eod($now)),
            'last_month' => $wrap($sod($now->modify('first day of last month')), $eod($now->modify('last day of last month'))),
            'this_year' => $wrap($sod($now->modify('first day of january this year')), $eod($now)),
            'last_7' => $wrap($sod($now->modify('-6 days')), $eod($now)),
            'last_30' => $wrap($sod($now->modify('-29 days')), $eod($now)),
            default => $wrap(new \DateTimeImmutable('@0'), $eod($now->modify('+1 day'))),
        };
    }

    private const F = 'Y-m-d\TH:i:s.v\Z';

    private static function utc(): \DateTimeZone
    {
        return new \DateTimeZone('UTC');
    }
}
