<?php
declare(strict_types=1);

namespace Afia\Support;

use Afia\App;
use Afia\Context;
use Afia\Http\Response;
use Afia\Http\Router;

/**
 * Generic CRUD resource over a hybrid-doc table, ported from
 * js/core/mock/resource.js defineResource(). Soft-delete (archivedAt + status),
 * audit on every mutation, list()/get()/create()/patch()/delete()/restore().
 *
 * $opts keys:
 *   base, table, entity,
 *   columns: fn(array $doc): array   - extracted column map for insert/update
 *   list:    array passed to Repo::list (searchCols, filters, sortMap, ...)
 *   normalize: fn(array $body, ?array $existing): array   - build the doc to store
 *   decorate:  fn(Context, array $doc): array
 *   perms: ['view'=>?, 'create'=>?, 'edit'=>?, 'archive'=>?]
 *   hardDelete: bool
 */
final class Resource
{
    public static function register(Router $r, App $app, array $opts): void
    {
        $base = $opts['base'];
        $table = $opts['table'];
        $entity = $opts['entity'];
        $cols = $opts['columns'] ?? static fn (array $d) => [];
        $normalize = $opts['normalize'] ?? static fn (array $b, ?array $e) => array_merge($e ?? [], $b);
        $decorate = $opts['decorate'] ?? static fn (Context $c, array $d) => $d;
        $perms = $opts['perms'] ?? [];
        $except = $opts['except'] ?? [];
        $softDelete = $opts['softDelete'] ?? true;
        $listOpts = $opts['list'] ?? [];
        $forcePageSize = $listOpts['pageSize'] ?? null;
        unset($listOpts['pageSize']);

        $r->get($base, static function (Context $ctx) use ($listOpts, $table, $decorate, $perms, $forcePageSize, $softDelete): Response {
            if (!empty($perms['view'])) {
                $ctx->requirePermission($perms['view']);
            }
            $q = $ctx->request->query;
            if ($forcePageSize !== null && !isset($q['pageSize'])) {
                $q['pageSize'] = $forcePageSize;
            }
            $baseWhere = (!$softDelete || ($q['includeArchived'] ?? null) === 'true' || ($q['status'] ?? null) === 'archived')
                ? '1=1' : 'archived_at IS NULL';
            $result = $ctx->repo()->list(array_merge($listOpts, [
                'table' => $table, 'query' => $q, 'baseWhere' => $baseWhere,
            ]));
            $result['data'] = array_map(static fn ($d) => $decorate($ctx, $d), $result['data']);
            return Response::json($result);
        });

        $r->get("{$base}/:id", static function (Context $ctx, array $p) use ($table, $entity, $decorate, $perms): Response {
            if (!empty($perms['view'])) {
                $ctx->requirePermission($perms['view']);
            }
            $doc = $ctx->repo()->doc($table, $p['id']) ?? throw HttpError::notFound(ucfirst($entity));
            return Response::json($decorate($ctx, $doc));
        });

        if (!in_array('create', $except, true)) {
            $r->post($base, static function (Context $ctx) use ($table, $entity, $cols, $normalize, $decorate, $perms): Response {
                if (!empty($perms['create'])) {
                    $ctx->requirePermission($perms['create']);
                }
                $doc = $normalize($ctx->body(), null);
                return $ctx->db->transaction(function () use ($ctx, $table, $entity, $cols, $decorate, $doc) {
                    $id = Uuid::v4();
                    $row = $ctx->repo()->insert($table, $id, $doc, $cols($doc));
                    Audit::record($ctx, 'create', $entity, $id, ['after' => $row]);
                    return Response::json($decorate($ctx, $row), 201);
                });
            });
        }

        $r->patch("{$base}/:id", static function (Context $ctx, array $p) use ($table, $entity, $cols, $normalize, $decorate, $perms): Response {
            if (!empty($perms['edit'])) {
                $ctx->requirePermission($perms['edit']);
            }
            $existing = $ctx->repo()->doc($table, $p['id']) ?? throw HttpError::notFound(ucfirst($entity));
            $body = $ctx->body();
            unset($body['id'], $body['createdAt']);
            $doc = $normalize(array_merge($existing, $body), $existing);
            return $ctx->db->transaction(function () use ($ctx, $table, $entity, $p, $cols, $decorate, $doc, $existing) {
                $row = $ctx->repo()->update($table, $p['id'], $doc, $cols($doc));
                Audit::record($ctx, 'update', $entity, $p['id'], ['before' => $existing, 'after' => $row]);
                return Response::json($decorate($ctx, $row));
            });
        });

        $r->delete("{$base}/:id", static function (Context $ctx, array $p) use ($table, $entity, $perms, $opts, $softDelete): Response {
            if (!empty($perms['archive'] ?? $perms['edit'] ?? null)) {
                $ctx->requirePermission($perms['archive'] ?? $perms['edit']);
            }
            $existing = $ctx->repo()->doc($table, $p['id']) ?? throw HttpError::notFound(ucfirst($entity));
            $hard = !$softDelete || ($ctx->request->query['hard'] ?? null) === 'true';
            return $ctx->db->transaction(function () use ($ctx, $table, $entity, $p, $existing, $hard, $opts, $softDelete) {
                if ($hard && $softDelete && empty($opts['hardDelete'])) {
                    throw HttpError::badRequest('This record cannot be permanently deleted; it is archived instead to protect history.');
                }
                if ($hard) {
                    $ctx->repo()->delete($table, $p['id']);
                    Audit::record($ctx, 'delete', $entity, $p['id'], ['before' => $existing]);
                    return Response::json(['deleted' => true, 'id' => $p['id']]);
                }
                $row = $ctx->repo()->update($table, $p['id'], ['archivedAt' => Clock::now(), 'status' => 'archived'], ['status' => 'archived', 'archived_at' => Clock::now()]);
                Audit::record($ctx, 'archive', $entity, $p['id'], ['before' => $existing, 'after' => $row]);
                return Response::json(['archived' => true, 'id' => $p['id']]);
            });
        });

        if (!$softDelete) {
            return;
        }

        $r->post("{$base}/:id/restore", static function (Context $ctx, array $p) use ($table, $entity, $decorate, $perms): Response {
            if (!empty($perms['archive'] ?? $perms['edit'] ?? null)) {
                $ctx->requirePermission($perms['archive'] ?? $perms['edit']);
            }
            $existing = $ctx->repo()->doc($table, $p['id']) ?? throw HttpError::notFound(ucfirst($entity));
            return $ctx->db->transaction(function () use ($ctx, $table, $entity, $p, $decorate, $existing) {
                $row = $ctx->repo()->update($table, $p['id'], ['archivedAt' => null, 'status' => 'active'], ['status' => 'active', 'archived_at' => null]);
                Audit::record($ctx, 'update', $entity, $p['id'], ['before' => $existing, 'after' => $row, 'meta' => ['action' => 'restore']]);
                return Response::json($decorate($ctx, $row));
            });
        });
    }
}
