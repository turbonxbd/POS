<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Context;

final class Branch
{
    /**
     * Resolve the branch for this request. Precedence: explicit id (from query
     * or body) -> the actor's first assigned branch -> the merchant's default
     * branch. The id is always re-checked against the caller's merchant, so a
     * forged branchId from another tenant resolves to null and is rejected.
     */
    public static function resolveId(Context $ctx, ?string $explicit = null): ?string
    {
        $repo = $ctx->repo();
        if ($explicit) {
            return $repo->doc('branches', $explicit) ? $explicit : null;
        }
        foreach ($ctx->actor['branchIds'] ?? [] as $bid) {
            if ($repo->doc('branches', $bid)) {
                return $bid;
            }
        }
        $branches = $repo->allDocs('branches', 'archived_at IS NULL', [], 'is_default DESC, created_at ASC');
        return $branches[0]['id'] ?? null;
    }

    public static function require(Context $ctx, ?string $explicit = null): array
    {
        $id = self::resolveId($ctx, $explicit);
        $branch = $id ? $ctx->repo()->doc('branches', $id) : null;
        if (!$branch) {
            throw HttpError::notFound('Branch');
        }
        return $branch;
    }
}
