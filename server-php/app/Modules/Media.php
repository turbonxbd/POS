<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Uuid;

/**
 * Product / logo images. Stored per-merchant in the `media` table (out of the
 * JSON docs). The client downscales before upload (js/services/media-service.js).
 *
 *   POST /media   { dataUrl: "data:image/jpeg;base64,..." }  -> { id, url }
 *   GET  /media/:id                                          -> the image bytes
 */
final class Media
{
    private const MAX_BYTES = 3_000_000;
    private const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    public static function register(Router $r, App $app): void
    {
        $r->post('/media', fn (Context $c) => self::upload($c));
        $r->get('/media/:id', fn (Context $c, $p) => self::serve($c, $p));
    }

    private static function upload(Context $ctx): Response
    {
        $ctx->requireActor();
        $dataUrl = (string) ($ctx->body()['dataUrl'] ?? '');
        if (!preg_match('#^data:([\w/+.-]+);base64,(.+)$#s', $dataUrl, $m)) {
            throw HttpError::badRequest('Expected a base64 data URL');
        }
        $type = strtolower($m[1]);
        if (!in_array($type, self::ALLOWED, true)) {
            throw HttpError::badRequest('Unsupported image type');
        }
        $bytes = base64_decode($m[2], true);
        if ($bytes === false || $bytes === '') {
            throw HttpError::badRequest('Corrupt image data');
        }
        if (strlen($bytes) > self::MAX_BYTES) {
            throw HttpError::badRequest('Image is too large. Please use a smaller file.');
        }

        $id = 'img_' . Uuid::v4();
        $ctx->db->run(
            'INSERT INTO media (id, merchant_id, content_type, bytes, size, created_at) VALUES (:id, :m, :ct, :b, :s, :c)',
            [':id' => $id, ':m' => $ctx->repo()->merchantId(), ':ct' => $type, ':b' => $bytes, ':s' => strlen($bytes), ':c' => Clock::now()],
        );
        return Response::json(['id' => $id, 'url' => '/api/media/' . $id], 201);
    }

    private static function serve(Context $ctx, array $p): Response
    {
        // images are not secret, but still scope to the caller's merchant
        $ctx->requireActor();
        $row = $ctx->db->first('SELECT content_type, bytes FROM media WHERE id = :id AND merchant_id = :m', [':id' => $p['id'], ':m' => $ctx->repo()->merchantId()]);
        if (!$row) {
            throw HttpError::notFound('Image');
        }
        $res = new Response(200, null, ['Content-Type' => $row['content_type'], 'Cache-Control' => 'private, max-age=86400']);
        $res->raw = $row['bytes'];
        return $res;
    }
}
