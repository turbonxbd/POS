<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Context;

/**
 * Append-only audit trail (js/core/mock/helpers.js audit()). Write-once:
 * there is no update or delete path for audit_logs anywhere in the API.
 */
final class Audit
{
    public static function record(Context $ctx, string $action, string $entity, ?string $entityId, array $opts = []): array
    {
        $actor = $opts['actor'] ?? $ctx->actor;
        $id = Uuid::v4();
        $at = Clock::now();

        $branchId = $opts['meta']['branchId'] ?? null;
        if (!$branchId && $ctx->actor) {
            try {
                $branchId = Branch::resolveId($ctx);
            } catch (\Throwable) {
                $branchId = null;
            }
        }
        $meta = $opts['meta'] ?? [];
        if ($branchId) {
            $meta['branchId'] = $branchId;
        }

        $doc = [
            'id' => $id, 'action' => $action, 'entity' => $entity, 'entityId' => $entityId,
            'actorId' => $actor['id'] ?? null,
            'actorName' => $actor['name'] ?? 'system',
            'before' => $opts['before'] ?? null,
            'after' => $opts['after'] ?? null,
            'meta' => $meta,
            'ip' => $ctx->request->ip ?? 'client',
            'device' => $ctx->request->header('user-agent'),
            'at' => $at, 'createdAt' => $at,
        ];
        $ctx->db->run(
            'INSERT INTO audit_logs (id, merchant_id, action, entity, entity_id, actor_id, branch_id, at, doc)
             VALUES (:id, :m, :a, :e, :eid, :actor, :branch, :at, :doc)',
            [
                ':id' => $id, ':m' => $ctx->merchantId ?? '', ':a' => $action, ':e' => $entity,
                ':eid' => $entityId, ':actor' => $doc['actorId'], ':branch' => $branchId, ':at' => $at,
                ':doc' => json_encode($doc, JSON_UNESCAPED_UNICODE),
            ],
        );
        return $doc;
    }
}
