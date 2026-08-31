<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\Context;

final class Settings
{
    public static function get(Context $ctx): array
    {
        $repo = $ctx->repo();
        $doc = $repo->doc('settings', 'settings_' . $repo->merchantId());
        if ($doc === null) {
            $doc = $repo->allDocs('settings', '1=1')[0] ?? [];
        }
        return $doc;
    }
}
