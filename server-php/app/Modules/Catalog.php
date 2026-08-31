<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Domain\Inventory;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Branch;
use Afia\Support\Clock;
use Afia\Support\HttpError;
use Afia\Support\Money;
use Afia\Support\Resource;
use Afia\Support\Uuid;

/**
 * Products (+ variants + branch stock), categories, brands, barcodes.
 * Ported from js/core/mock/catalog.routes.js. Products are SAFE-ARCHIVED, never
 * hard-deleted, so historical sale line snapshots stay valid.
 */
final class Catalog
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/products', fn (Context $c) => self::listProducts($c));
        $r->get('/products/lookup', fn (Context $c) => self::lookup($c));
        $r->get('/products/:id', fn (Context $c, $p) => self::getProduct($c, $p));
        $r->post('/products', fn (Context $c) => self::createProduct($c));
        $r->patch('/products/:id', fn (Context $c, $p) => self::updateProduct($c, $p));
        $r->delete('/products/:id', fn (Context $c, $p) => self::archiveProduct($c, $p));
        $r->post('/products/:id/restore', fn (Context $c, $p) => self::restoreProduct($c, $p));

        $r->post('/barcode/generate', fn (Context $c) => self::barcodeGenerate($c));
        $r->post('/barcode/assign', fn (Context $c) => self::barcodeAssign($c));

        Resource::register($r, $app, [
            'base' => '/categories', 'table' => 'categories', 'entity' => 'category',
            'perms' => ['view' => 'products.view', 'create' => 'categories.manage', 'edit' => 'categories.manage'],
            'list' => ['searchCols' => ['name'], 'sortMap' => ['name' => 'name', 'order' => 'sort_order', 'createdAt' => 'created_at'], 'defaultSort' => 'sort_order', 'defaultDir' => 'asc', 'filters' => ['parentId' => 'parent_id', 'status' => 'status']],
            'columns' => static fn (array $d) => ['parent_id' => $d['parentId'] ?? null, 'name' => $d['name'] ?? '', 'status' => $d['status'] ?? 'active', 'sort_order' => (int) ($d['order'] ?? 0)],
            'normalize' => static fn (array $b, ?array $e) => [
                'name' => trim((string) ($b['name'] ?? '')), 'parentId' => $b['parentId'] ?? null,
                'imageId' => $b['imageId'] ?? null, 'description' => $b['description'] ?? '',
                'order' => (int) ($b['order'] ?? 0), 'status' => $b['status'] ?? 'active',
            ],
            'decorate' => static function (Context $ctx, array $c) {
                $c['parentName'] = !empty($c['parentId']) ? ($ctx->repo()->doc('categories', $c['parentId'])['name'] ?? null) : null;
                $c['productCount'] = $ctx->repo()->count('products', "archived_at IS NULL AND (category_id = :cid OR subcategory_id = :cid)", [':cid' => $c['id']]);
                return $c;
            },
        ]);

        Resource::register($r, $app, [
            'base' => '/brands', 'table' => 'brands', 'entity' => 'brand',
            'perms' => ['view' => 'products.view', 'create' => 'brands.manage', 'edit' => 'brands.manage'],
            'list' => ['searchCols' => ['name'], 'sortMap' => ['name' => 'name', 'createdAt' => 'created_at'], 'defaultSort' => 'name', 'defaultDir' => 'asc'],
            'columns' => static fn (array $d) => ['name' => $d['name'] ?? '', 'status' => $d['status'] ?? 'active'],
            'normalize' => static fn (array $b, ?array $e) => [
                'name' => trim((string) ($b['name'] ?? '')), 'imageId' => $b['imageId'] ?? null,
                'description' => $b['description'] ?? '', 'status' => $b['status'] ?? 'active',
            ],
            'decorate' => static function (Context $ctx, array $b) {
                $b['productCount'] = $ctx->repo()->count('products', 'archived_at IS NULL AND brand_id = :b', [':b' => $b['id']]);
                return $b;
            },
        ]);
    }

    /* ------------------------------------------------------------ products */

    private static function listProducts(Context $ctx): Response
    {
        $ctx->requirePermission('products.view');
        $q = $ctx->request->query;
        $branchId = Branch::resolveId($ctx, $q['branchId'] ?? null);

        $where = [];
        $params = [];
        if (($q['includeArchived'] ?? null) !== 'true') {
            $where[] = 'archived_at IS NULL';
        }
        foreach (['categoryId' => 'category_id', 'brandId' => 'brand_id', 'supplierId' => 'supplier_id'] as $qk => $col) {
            if (!empty($q[$qk])) {
                if ($qk === 'categoryId') {
                    $where[] = '(category_id = :cat OR subcategory_id = :cat)';
                    $params[':cat'] = $q[$qk];
                } else {
                    $where[] = "{$col} = :{$col}";
                    $params[":{$col}"] = $q[$qk];
                }
            }
        }
        if (!empty($q['barcode'])) {
            $hit = self::codeLookup($ctx, (string) $q['barcode']);
            $where[] = 'id = :pcp';
            $params[':pcp'] = $hit['product_id'] ?? '__none__';
        }

        $result = $ctx->repo()->list([
            'table' => 'products',
            'query' => $q,
            'baseWhere' => $where ? implode(' AND ', $where) : '1=1',
            'params' => $params,
            'searchCols' => ['name', 'sku', 'barcode'],
            'sortMap' => ['name' => 'name', 'sku' => 'sku', 'sellingPrice' => 'selling_price', 'costPrice' => 'cost_price', 'createdAt' => 'created_at'],
            'defaultSort' => 'name', 'defaultDir' => 'asc',
        ]);

        $status = $q['status'] ?? null;
        $data = [];
        foreach ($result['data'] as $p) {
            $dec = self::decorate($ctx, $p, $branchId);
            if ($status && $status !== 'all' && $dec['computedStatus'] !== $status) {
                continue;
            }
            $data[] = $dec;
        }
        $result['data'] = $data;
        return Response::json($result);
    }

    private static function getProduct(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('products.view');
        $doc = $ctx->repo()->doc('products', $p['id']) ?? throw HttpError::notFound('Product');
        $all = in_array($ctx->request->query['allBranches'] ?? null, ['true', '1', true], true);
        return Response::json(self::decorate($ctx, $doc, Branch::resolveId($ctx, $ctx->request->query['branchId'] ?? null), $all));
    }

    private static function lookup(Context $ctx): Response
    {
        $ctx->requirePermission('products.view');
        $q = $ctx->request->query;
        $branchId = Branch::resolveId($ctx, $q['branchId'] ?? null);
        $code = trim((string) ($q['code'] ?? $q['barcode'] ?? ''));
        $term = mb_strtolower(trim((string) ($q['q'] ?? '')));

        if ($code !== '') {
            $hit = self::codeLookup($ctx, $code);
            if ($hit) {
                $product = $ctx->repo()->doc('products', $hit['product_id']);
                if ($product && empty($product['archivedAt']) && ($product['status'] ?? '') === 'active') {
                    return Response::json([
                        'match' => $hit['kind'] === 'sku' ? 'sku' : ($hit['variant_id'] ? 'variant' : 'product'),
                        'product' => self::decorate($ctx, $product, $branchId),
                        'variantId' => $hit['variant_id'] ?? null,
                    ]);
                }
            }
            return Response::json(['match' => null]);
        }

        $limit = min(50, max(1, (int) ($q['limit'] ?? 20)));
        $rows = $ctx->repo()->allDocs('products', "archived_at IS NULL AND status = 'active' AND (LOWER(name) LIKE :t OR LOWER(sku) LIKE :t)", [':t' => "%{$term}%"], 'name ASC');
        $hits = array_map(fn ($p) => self::decorate($ctx, $p, $branchId), array_slice($rows, 0, $limit));
        return Response::json(['match' => 'list', 'results' => $hits]);
    }

    private static function createProduct(Context $ctx): Response
    {
        $ctx->requirePermission('products.create');
        $body = $ctx->body();
        self::validate($ctx, $body, null);
        $doc = self::normalize($body, null);
        $branchId = Branch::resolveId($ctx, $body['branchId'] ?? null);

        return $ctx->db->transaction(function () use ($ctx, $doc, $body, $branchId) {
            $id = Uuid::v4();
            $doc = self::ensureUniqueBarcodes($ctx, $doc, null);
            $row = $ctx->repo()->insert('products', $id, $doc, self::columns($doc));
            self::syncCodes($ctx, $id, $doc);

            if (($doc['trackInventory'] ?? true)) {
                self::postOpeningStock($ctx, $id, $doc, $body, $branchId);
            }
            Audit::record($ctx, 'create', 'product', $id, ['after' => $row]);
            return Response::json(self::decorate($ctx, $ctx->repo()->doc('products', $id), $branchId, true), 201);
        });
    }

    private static function updateProduct(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('products.edit');
        $existing = $ctx->repo()->doc('products', $p['id']) ?? throw HttpError::notFound('Product');
        $body = $ctx->body();
        // validate the merged result so a partial PATCH (e.g. just { minStock }) is allowed
        self::validate($ctx, array_merge($existing, $body), $p['id']);
        $doc = self::normalize(array_merge($existing, $body), $existing);

        return $ctx->db->transaction(function () use ($ctx, $p, $doc, $existing) {
            $doc = self::ensureUniqueBarcodes($ctx, $doc, $p['id']);
            $row = $ctx->repo()->update('products', $p['id'], $doc, self::columns($doc));
            self::syncCodes($ctx, $p['id'], $doc);
            Audit::record($ctx, 'update', 'product', $p['id'], ['before' => $existing, 'after' => $row]);
            return Response::json(self::decorate($ctx, $row, Branch::resolveId($ctx, null)));
        });
    }

    private static function archiveProduct(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('products.archive');
        $existing = $ctx->repo()->doc('products', $p['id']) ?? throw HttpError::notFound('Product');
        return $ctx->db->transaction(function () use ($ctx, $p, $existing) {
            $row = $ctx->repo()->update('products', $p['id'], ['archivedAt' => Clock::now(), 'status' => 'archived'], ['status' => 'archived', 'archived_at' => Clock::now()]);
            Audit::record($ctx, 'archive', 'product', $p['id'], ['before' => $existing, 'after' => $row]);
            return Response::json(['archived' => true, 'id' => $p['id']]);
        });
    }

    private static function restoreProduct(Context $ctx, array $p): Response
    {
        $ctx->requirePermission('products.archive');
        $existing = $ctx->repo()->doc('products', $p['id']) ?? throw HttpError::notFound('Product');
        return $ctx->db->transaction(function () use ($ctx, $p, $existing) {
            $row = $ctx->repo()->update('products', $p['id'], ['archivedAt' => null, 'status' => 'active'], ['status' => 'active', 'archived_at' => null]);
            Audit::record($ctx, 'update', 'product', $p['id'], ['meta' => ['action' => 'restore']]);
            return Response::json(self::decorate($ctx, $row, Branch::resolveId($ctx, null)));
        });
    }

    /* ------------------------------------------------------------ barcode */

    private static function barcodeGenerate(Context $ctx): Response
    {
        $ctx->requirePermission('barcode.manage');
        $count = min(500, max(1, (int) ($ctx->body()['count'] ?? 1)));
        $taken = array_flip(self::usedBarcodes($ctx, null));
        $codes = [];
        for ($i = 0; $i < $count; $i++) {
            do {
                $c = Uuid::ean13();
            } while (isset($taken[$c]));
            $taken[$c] = true;
            $codes[] = $c;
        }
        return Response::json(['codes' => $codes]);
    }

    private static function barcodeAssign(Context $ctx): Response
    {
        $ctx->requirePermission('barcode.manage');
        $b = $ctx->body();
        $product = $ctx->repo()->doc('products', $b['productId'] ?? '') ?? throw HttpError::notFound('Product');
        $variantId = $b['variantId'] ?? null;
        $barcode = trim((string) ($b['barcode'] ?? ''));
        if ($barcode === '') {
            throw HttpError::badRequest('Barcode is required');
        }

        return $ctx->db->transaction(function () use ($ctx, $product, $variantId, $barcode) {
            if ($variantId) {
                $product['variants'] = array_map(
                    static fn ($v) => $v['id'] === $variantId ? array_merge($v, ['barcode' => $barcode]) : $v,
                    $product['variants'] ?? [],
                );
            } else {
                $product['barcode'] = $barcode;
            }
            $ctx->repo()->update('products', $product['id'], $product, self::columns($product));
            self::syncCodes($ctx, $product['id'], $product);
            Audit::record($ctx, 'update', 'product', $product['id'], ['meta' => ['field' => 'barcode', 'barcode' => $barcode]]);
            return Response::json(['ok' => true]);
        });
    }

    /* ------------------------------------------------------------ helpers */

    private static function validate(Context $ctx, array $body, ?string $existingId): void
    {
        $errors = [];
        if (trim((string) ($body['name'] ?? '')) === '') {
            $errors['name'] = 'Product name is required';
        }
        if (!isset($body['sellingPrice']) || (float) $body['sellingPrice'] < 0) {
            $errors['sellingPrice'] = 'Selling price is required';
        }
        if (isset($body['costPrice']) && (float) $body['costPrice'] < 0) {
            $errors['costPrice'] = 'Cost price cannot be negative';
        }
        $mrp = $body['mrp'] ?? null;
        if ($mrp !== null && $mrp !== '' && (float) $mrp < 0) {
            $errors['mrp'] = 'MRP cannot be negative';
        }
        if ($mrp !== null && $mrp !== '' && (float) $mrp > 0 && isset($body['sellingPrice']) && (float) $body['sellingPrice'] > (float) $mrp) {
            $errors['sellingPrice'] = 'Selling price cannot exceed the MRP';
        }
        if (is_array($body['branchStock'] ?? null)) {
            foreach ($body['branchStock'] as $i => $row) {
                if (empty($row['branchId']) || !$ctx->repo()->doc('branches', $row['branchId'])) {
                    $errors["branchStock.{$i}.branchId"] = 'Select a branch';
                }
                $qv = $row['qty'] ?? null;
                if (!is_numeric($qv) || $qv < 0 || (int) $qv != $qv) {
                    $errors["branchStock.{$i}.qty"] = 'Quantity must be a whole number (0 or more)';
                }
            }
        }
        if ($errors) {
            throw HttpError::badRequest('Please fix the highlighted fields', $errors);
        }
        // SKU/barcode clashes are caught by the product_codes unique index in syncCodes().
    }

    private static function normalize(array $b, ?array $existing): array
    {
        $b += [
            'name' => '', 'sku' => '', 'barcode' => '', 'description' => '', 'imageId' => null,
            'categoryId' => null, 'subcategoryId' => null, 'brandId' => null, 'supplierId' => null,
            'unit' => 'pcs', 'costPrice' => 0, 'sellingPrice' => 0, 'mrp' => null, 'wholesalePrice' => 0,
            'discountPrice' => null, 'taxId' => null, 'attributes' => [], 'minStock' => 0, 'maxStock' => 0,
            'trackInventory' => true, 'variants' => [], 'status' => null, 'tags' => [],
        ];
        $name = trim((string) $b['name']);
        $mk = static fn ($v) => max(0, (int) ($v ?? 0));
        $variants = array_map(static function ($v) use ($name, $b, $mk) {
            $opts = $v['options'] ?? [];
            return [
                'id' => $v['id'] ?? Uuid::v4(),
                'name' => $v['name'] ?? ($opts ? implode(' / ', array_values($opts)) : ''),
                'options' => $opts,
                'sku' => $v['sku'] ?? Uuid::suggestSku($name, array_values($opts)),
                'barcode' => trim((string) ($v['barcode'] ?? '')), // filled by ensureUniqueBarcodes()
                'costPrice' => $mk($v['costPrice'] ?? $b['costPrice'] ?? 0),
                'sellingPrice' => $mk($v['sellingPrice'] ?? $b['sellingPrice'] ?? 0),
                'wholesalePrice' => $mk($v['wholesalePrice'] ?? $b['wholesalePrice'] ?? 0),
                'minStock' => $mk($v['minStock'] ?? $b['minStock'] ?? 0),
                'imageId' => $v['imageId'] ?? null,
                'openingStock' => $mk($v['openingStock'] ?? 0),
            ];
        }, $b['variants'] ?? []);

        $attrs = [];
        foreach (['color', 'size', 'variant'] as $k) {
            $val = trim((string) (($b['attributes'][$k] ?? $existing['attributes'][$k] ?? '')));
            if ($val !== '') {
                $attrs[$k] = $val;
            }
        }

        return [
            'name' => $name,
            'sku' => $b['sku'] ?: ($existing['sku'] ?? Uuid::suggestSku($name)),
            'barcode' => trim((string) ($b['barcode'] ?: ($existing['barcode'] ?? ''))), // filled by ensureUniqueBarcodes()
            'description' => $b['description'] ?? '',
            'imageId' => $b['imageId'] ?? $existing['imageId'] ?? null,
            'categoryId' => $b['categoryId'] ?: null,
            'subcategoryId' => $b['subcategoryId'] ?: null,
            'brandId' => $b['brandId'] ?: null,
            'supplierId' => $b['supplierId'] ?: null,
            'unit' => $b['unit'] ?: 'pcs',
            'costPrice' => $mk($b['costPrice'] ?? 0),
            'sellingPrice' => $mk($b['sellingPrice'] ?? 0),
            'mrp' => ($b['mrp'] ?? null) !== null && $b['mrp'] !== '' ? $mk($b['mrp']) : ($existing['mrp'] ?? null),
            'wholesalePrice' => $mk($b['wholesalePrice'] ?? 0),
            'discountPrice' => isset($b['discountPrice']) && $b['discountPrice'] !== null ? $mk($b['discountPrice']) : null,
            'taxId' => $b['taxId'] ?: null,
            'attributes' => $attrs,
            'minStock' => $mk($b['minStock'] ?? 0),
            'maxStock' => $mk($b['maxStock'] ?? 0),
            'trackInventory' => ($b['trackInventory'] ?? true) !== false,
            'hasVariants' => count($variants) > 0,
            'variants' => $variants,
            'status' => $b['status'] ?? $existing['status'] ?? 'active',
            'tags' => $b['tags'] ?? [],
        ];
    }

    private static function columns(array $d): array
    {
        return [
            'name' => $d['name'] ?? '', 'sku' => $d['sku'] ?? null, 'barcode' => $d['barcode'] ?? null,
            'category_id' => $d['categoryId'] ?? null, 'subcategory_id' => $d['subcategoryId'] ?? null,
            'brand_id' => $d['brandId'] ?? null, 'supplier_id' => $d['supplierId'] ?? null, 'tax_id' => $d['taxId'] ?? null,
            'selling_price' => (int) ($d['sellingPrice'] ?? 0), 'cost_price' => (int) ($d['costPrice'] ?? 0),
            'has_variants' => !empty($d['hasVariants']) ? 1 : 0,
            'track_inventory' => ($d['trackInventory'] ?? true) ? 1 : 0,
            'status' => $d['status'] ?? 'active',
        ];
    }

    /** @return array{product_id:string,variant_id:?string,kind:string}|null */
    private static function codeLookup(Context $ctx, string $code): ?array
    {
        return $ctx->repo()->db()->first(
            'SELECT product_id, variant_id, kind FROM product_codes WHERE merchant_id = :m AND code = :c LIMIT 1',
            [':m' => $ctx->repo()->merchantId(), ':c' => trim($code)],
        );
    }

    /** Barcodes already used by OTHER products of this merchant. */
    private static function usedBarcodes(Context $ctx, ?string $exceptProductId): array
    {
        $rows = $ctx->db->all(
            "SELECT code FROM product_codes WHERE merchant_id = :m AND kind = 'barcode'" . ($exceptProductId ? ' AND product_id <> :p' : ''),
            $exceptProductId ? [':m' => $ctx->repo()->merchantId(), ':p' => $exceptProductId] : [':m' => $ctx->repo()->merchantId()],
        );
        return array_column($rows, 'code');
    }

    /**
     * Fill in / replace any barcode that is missing or already used by another
     * product of THIS merchant, so syncCodes() never rejects an auto-generated
     * code. Barcodes may still repeat across merchants (a shared EAN).
     */
    private static function ensureUniqueBarcodes(Context $ctx, array $doc, ?string $exceptProductId): array
    {
        $taken = array_flip(self::usedBarcodes($ctx, $exceptProductId));
        $fresh = static function () use (&$taken) {
            do {
                $c = Uuid::ean13();
            } while (isset($taken[$c]));
            $taken[$c] = true;
            return $c;
        };
        // only auto-fill EMPTY barcodes; an explicit duplicate is left for
        // validate() / the product_codes unique index to reject.
        $doc['barcode'] = trim((string) ($doc['barcode'] ?? '')) ?: $fresh();
        if (!empty($doc['variants'])) {
            $doc['variants'] = array_map(static function ($v) use ($fresh) {
                $v['barcode'] = trim((string) ($v['barcode'] ?? '')) ?: $fresh();
                return $v;
            }, $doc['variants']);
        }
        return $doc;
    }

    /** Rebuild product_codes for a product; unique index enforces per-merchant uniqueness. */
    private static function syncCodes(Context $ctx, string $productId, array $doc): void
    {
        $repo = $ctx->repo();
        $repo->db()->run('DELETE FROM product_codes WHERE merchant_id = :m AND product_id = :p', [':m' => $repo->merchantId(), ':p' => $productId]);
        $insert = function (?string $variantId, string $kind, ?string $code) use ($repo, $productId) {
            $code = trim((string) $code);
            if ($code === '') {
                return;
            }
            try {
                $repo->db()->run(
                    'INSERT INTO product_codes (id, merchant_id, product_id, variant_id, kind, code) VALUES (:id,:m,:p,:v,:k,:c)',
                    [':id' => Uuid::v4(), ':m' => $repo->merchantId(), ':p' => $productId, ':v' => $variantId, ':k' => $kind, ':c' => $code],
                );
            } catch (\PDOException $e) {
                $field = $kind === 'sku' ? 'sku' : 'barcode';
                throw HttpError::badRequest('Please fix the highlighted fields', [$field => ucfirst($field) . ' is already used by another product']);
            }
        };
        $insert(null, 'sku', $doc['sku'] ?? null);
        $insert(null, 'barcode', $doc['barcode'] ?? null);
        foreach ($doc['variants'] ?? [] as $v) {
            $insert($v['id'], 'sku', $v['sku'] ?? null);
            $insert($v['id'], 'barcode', $v['barcode'] ?? null);
        }
    }

    private static function postOpeningStock(Context $ctx, string $productId, array $doc, array $body, ?string $branchId): void
    {
        if (!empty($doc['variants'])) {
            foreach ($doc['variants'] as $v) {
                if (($v['openingStock'] ?? 0) > 0 && $branchId) {
                    Inventory::post($ctx, [
                        'branchId' => $branchId, 'productId' => $productId, 'variantId' => $v['id'], 'type' => 'opening',
                        'qtyDelta' => (int) $v['openingStock'], 'unitCost' => (int) $v['costPrice'],
                        'refType' => 'product', 'refId' => $productId, 'note' => 'Opening stock',
                    ]);
                }
            }
            return;
        }
        if (is_array($body['branchStock'] ?? null) && $body['branchStock']) {
            $merged = [];
            foreach ($body['branchStock'] as $rw) {
                $qv = max(0, (int) ($rw['qty'] ?? 0));
                $merged[$rw['branchId']] = ($merged[$rw['branchId']] ?? 0) + $qv;
            }
            foreach ($merged as $bId => $qty) {
                if ($qty > 0 && $ctx->repo()->doc('branches', $bId)) {
                    Inventory::post($ctx, [
                        'branchId' => $bId, 'productId' => $productId, 'variantId' => null, 'type' => 'opening',
                        'qtyDelta' => $qty, 'unitCost' => (int) $doc['costPrice'],
                        'refType' => 'product', 'refId' => $productId, 'note' => 'Opening stock',
                    ]);
                }
            }
            return;
        }
        if ((int) ($body['openingStock'] ?? 0) > 0 && $branchId) {
            Inventory::post($ctx, [
                'branchId' => $branchId, 'productId' => $productId, 'variantId' => null, 'type' => 'opening',
                'qtyDelta' => (int) $body['openingStock'], 'unitCost' => (int) $doc['costPrice'],
                'refType' => 'product', 'refId' => $productId, 'note' => 'Opening stock',
            ]);
        }
    }

    private static function totalStock(Context $ctx, array $p, ?string $branchId): int
    {
        if (!$branchId) {
            return 0;
        }
        if (!empty($p['variants'])) {
            $sum = 0;
            foreach ($p['variants'] as $v) {
                $sum += Inventory::qty($ctx, $branchId, $p['id'], $v['id']);
            }
            return $sum;
        }
        return Inventory::qty($ctx, $branchId, $p['id'], null);
    }

    private static function computedStatus(Context $ctx, array $p, ?string $branchId): string
    {
        if (!empty($p['archivedAt'])) {
            return 'archived';
        }
        if (($p['status'] ?? '') === 'inactive') {
            return 'inactive';
        }
        $qty = self::totalStock($ctx, $p, $branchId);
        if ($qty <= 0) {
            return 'out_of_stock';
        }
        if (($p['minStock'] ?? 0) > 0 && $qty <= $p['minStock']) {
            return 'low_stock';
        }
        return 'active';
    }

    private static function decorate(Context $ctx, array $p, ?string $branchId, bool $allBranches = false): array
    {
        $repo = $ctx->repo();
        $stock = self::totalStock($ctx, $p, $branchId);
        $avg = $branchId ? Inventory::avgCost($ctx, $branchId, $p['id'], null) : 0;

        $out = array_merge($p, [
            'stock' => $stock,
            'computedStatus' => self::computedStatus($ctx, $p, $branchId),
            'categoryName' => !empty($p['categoryId']) ? ($repo->doc('categories', $p['categoryId'])['name'] ?? null) : null,
            'subcategoryName' => !empty($p['subcategoryId']) ? ($repo->doc('categories', $p['subcategoryId'])['name'] ?? null) : null,
            'brandName' => !empty($p['brandId']) ? ($repo->doc('brands', $p['brandId'])['name'] ?? null) : null,
            'supplierName' => !empty($p['supplierId']) ? ($repo->doc('suppliers', $p['supplierId'])['name'] ?? null) : null,
            'variantStock' => array_map(
                static fn ($v) => ['id' => $v['id'], 'stock' => $branchId ? Inventory::qty($ctx, $branchId, $p['id'], $v['id']) : 0],
                $p['variants'] ?? [],
            ),
            'stockValue' => Money::mul($avg ?: ($p['costPrice'] ?? 0), $stock),
        ]);

        if ($allBranches) {
            $branches = $repo->allDocs('branches', 'archived_at IS NULL');
            $out['branchStock'] = array_map(
                fn ($b) => ['branchId' => $b['id'], 'branchName' => $b['name'], 'qty' => self::totalStock($ctx, $p, $b['id'])],
                $branches,
            );
            $out['totalStockAllBranches'] = array_sum(array_column($out['branchStock'], 'qty'));
        }
        return $out;
    }
}
