<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Repo;

/**
 * Formatted, gap-tolerant document numbers (invoice / PO / adjustment / ...).
 * Ported from js/utils/id.js formatDocNo(). The running number comes from the
 * per-merchant `sequences` table so two terminals never collide.
 */
final class DocNo
{
    public static function format(string $template, array $o = []): string
    {
        $date = $o['date'] ?? new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $seq = str_pad((string) ($o['seq'] ?? 1), (int) ($o['seqWidth'] ?? 5), '0', STR_PAD_LEFT);
        $out = strtr($template, [
            '{PREFIX}' => $o['prefix'] ?? '',
            '{BR}' => $o['branchCode'] ?? '',
            '{YYYY}' => $date->format('Y'),
            '{YY}' => $date->format('y'),
            '{MM}' => $date->format('m'),
            '{DD}' => $date->format('d'),
            '{SEQ}' => $seq,
        ]);
        return trim(preg_replace('/-+/', '-', $out), '-');
    }

    /** Allocate the next number for $key and render it with $template. */
    public static function next(Repo $repo, string $key, string $template, array $opts = []): string
    {
        $opts['seq'] = $repo->nextSeq($key);
        return self::format($template, $opts);
    }
}
