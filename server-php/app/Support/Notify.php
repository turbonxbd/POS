<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Context;

final class Notify
{
    public static function push(Context $ctx, string $type, string $title, string $message, array $opts = []): array
    {
        $id = Uuid::v4();
        $doc = [
            'id' => $id, 'type' => $type, 'title' => $title, 'message' => $message,
            'level' => $opts['level'] ?? 'info',
            'link' => $opts['link'] ?? null,
            'read' => false,
            'meta' => $opts['meta'] ?? [],
            'at' => Clock::now(),
        ];
        return $ctx->repo()->insert('notifications', $id, $doc, [
            'type' => $type, 'is_read' => 0, 'at' => $doc['at'],
        ]);
    }

    /** True if a same-type notification with this dedupe key fired in the last 6h. */
    public static function recent(Context $ctx, string $type, string $dupeKey): bool
    {
        $cutoff = Clock::addHours(Clock::now(), -6);
        $rows = $ctx->repo()->allDocs('notifications', "type = :t AND at > :c", [':t' => $type, ':c' => $cutoff]);
        foreach ($rows as $n) {
            if (($n['meta']['dupeKey'] ?? null) === $dupeKey) {
                return true;
            }
        }
        return false;
    }
}
