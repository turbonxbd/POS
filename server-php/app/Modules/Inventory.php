<?php
declare(strict_types=1);

namespace Afia\Modules;

use Afia\App;
use Afia\Context;
use Afia\Domain\Inventory as Ledger;
use Afia\Http\Response;
use Afia\Http\Router;
use Afia\Support\Audit;
use Afia\Support\Branch;
use Afia\Support\Clock;
use Afia\Support\DocNo;
use Afia\Support\HttpError;
use Afia\Support\Money;
use Afia\Support\Notify;
use Afia\Support\Uuid;

/** Stock overview, movement ledger, adjustments, transfers, valuation. */
final class Inventory
{
    public static function register(Router $r, App $app): void
    {
        $r->get('/inventory', fn (Context $c) => self::overview($c));
        $r->get('/inventory/movements', fn (Context $c) => self::movements($c));
        $r->get('/inventory/adjustments', fn (Context $c) => self::listAdjustments($c));
        $r->post('/inventory/adjustments', fn (Context $c) => self::createAdjustment($c));
        $r->get('/inventory/transfers', fn (Context $c) => self::listTransfers($c));
        $r->post('/inventory/transfers', fn (Context $c) => self::createTransfer($c));
        $r->get('/inventory/reorder', fn (Context $c) => self::reorder($c));
        $r->get('/inventory/valuation', fn (Context $c) => self::valuation($c));
    }

    private static function reorder(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.view');
        $q = $ctx->request->query;
        $branches = $ctx->repo()->allDocs('branches', 'archived_at IS NULL', [], 'name ASC');
        $scope = !empty($q['branchId']) && $q['branchId'] !== 'all' ? $q['branchId'] : null;
        $branchList = $scope ? array_values(array_filter($branches, static fn ($b) => $b['id'] === $scope)) : $branches;
        $products = $ctx->repo()->allDocs('products', "archived_at IS NULL AND track_inventory = 1", [], 'name ASC');

        $rows = [];
        foreach ($products as $p) {
            $supplierName = !empty($p['supplierId']) ? ($ctx->repo()->doc('suppliers', $p['supplierId'])['name'] ?? null) : null;
            $targets = !empty($p['variants'])
                ? array_map(static fn ($v) => ['variantId' => $v['id'], 'label' => $v['name'] ?: $v['sku'], 'sku' => $v['sku'], 'min' => (int) ($v['minStock'] ?? $p['minStock'] ?? 0), 'cost' => (int) ($v['costPrice'] ?? 0)], $p['variants'])
                : [['variantId' => null, 'label' => null, 'sku' => $p['sku'] ?? null, 'min' => (int) ($p['minStock'] ?? 0), 'cost' => (int) ($p['costPrice'] ?? 0)]];
            foreach ($targets as $t) {
                if ($t['min'] <= 0) {
                    continue;
                }
                $onHand = 0;
                $avgCost = $t['cost'];
                $byBranch = [];
                foreach ($branchList as $b) {
                    $s = $ctx->repo()->doc('stock', Ledger::stockId($b['id'], $p['id'], $t['variantId']));
                    $qq = (int) ($s['quantity'] ?? 0);
                    $onHand += $qq;
                    if (!empty($s['avgCost'])) {
                        $avgCost = (int) $s['avgCost'];
                    }
                    $byBranch[] = ['branchId' => $b['id'], 'branchName' => $b['name'], 'quantity' => $qq];
                }
                if ($onHand > $t['min']) {
                    continue;
                }
                $target = !empty($p['maxStock']) && $p['maxStock'] > $t['min'] ? (int) $p['maxStock'] : $t['min'] * 2;
                $suggested = max(0, $target - $onHand);
                $rows[] = [
                    'id' => $p['id'] . ':' . ($t['variantId'] ?: 'base'),
                    'productId' => $p['id'], 'variantId' => $t['variantId'],
                    'name' => $p['name'], 'variantLabel' => $t['label'], 'sku' => $t['sku'],
                    'supplierId' => $p['supplierId'] ?? null, 'supplierName' => $supplierName,
                    'reorderLevel' => $t['min'], 'onHand' => $onHand, 'byBranch' => $byBranch,
                    'avgCost' => $avgCost, 'suggestedQty' => $suggested,
                    'restockCost' => Money::mul($avgCost, $suggested),
                    'status' => $onHand <= 0 ? 'out_of_stock' : 'low_stock',
                ];
            }
        }

        $filtered = $rows;
        if (!empty($q['supplierId']) && $q['supplierId'] !== 'all') {
            $filtered = array_values(array_filter($filtered, static fn ($r) => $q['supplierId'] === 'none' ? empty($r['supplierId']) : $r['supplierId'] === $q['supplierId']));
        }
        if (!empty($q['status']) && $q['status'] !== 'all') {
            $filtered = array_values(array_filter($filtered, static fn ($r) => $r['status'] === $q['status']));
        }
        $result = self::paginate($filtered, $q, ['name', 'sku', 'variantLabel', 'supplierName'], ['name', 'onHand', 'reorderLevel', 'suggestedQty', 'restockCost', 'supplierName'], 'restockCost', 'desc');

        $suppliers = [];
        foreach ($rows as $r) {
            $key = $r['supplierId'] ?: 'none';
            $acc = $suppliers[$key] ?? ['supplierId' => $r['supplierId'] ?: null, 'supplierName' => $r['supplierName'] ?: 'No supplier', 'lines' => 0, 'cost' => 0];
            $acc['lines']++;
            $acc['cost'] += $r['restockCost'];
            $suppliers[$key] = $acc;
        }
        usort($suppliers, static fn ($a, $b) => $b['cost'] <=> $a['cost']);
        $result['summary'] = [
            'itemsToReorder' => count($rows),
            'outOfStock' => count(array_filter($rows, static fn ($r) => $r['status'] === 'out_of_stock')),
            'estimatedCost' => array_sum(array_column($rows, 'restockCost')),
            'suppliers' => array_values($suppliers),
        ];
        return Response::json($result);
    }

    private static function overview(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.view');
        $q = $ctx->request->query;
        $branchId = Branch::resolveId($ctx, $q['branchId'] ?? null);
        $products = $ctx->repo()->allDocs('products', "archived_at IS NULL AND track_inventory = 1", [], 'name ASC');

        $rows = [];
        foreach ($products as $p) {
            $targets = !empty($p['variants'])
                ? array_map(static fn ($v) => ['variantId' => $v['id'], 'label' => $v['name'] ?: $v['sku'], 'min' => $v['minStock'] ?? $p['minStock'], 'cost' => $v['costPrice'], 'sku' => $v['sku']], $p['variants'])
                : [['variantId' => null, 'label' => null, 'min' => $p['minStock'] ?? 0, 'cost' => $p['costPrice'] ?? 0, 'sku' => $p['sku'] ?? null]];
            foreach ($targets as $t) {
                $srow = $ctx->repo()->doc('stock', Ledger::stockId($branchId, $p['id'], $t['variantId']));
                $qty = (int) ($srow['quantity'] ?? 0);
                $avg = (int) ($srow['avgCost'] ?? $t['cost'] ?? 0);
                $min = (int) ($t['min'] ?? 0);
                $rows[] = [
                    'id' => $p['id'] . ':' . ($t['variantId'] ?: 'base'),
                    'productId' => $p['id'], 'variantId' => $t['variantId'],
                    'name' => $p['name'], 'variantLabel' => $t['label'], 'sku' => $t['sku'],
                    'categoryName' => !empty($p['categoryId']) ? ($ctx->repo()->doc('categories', $p['categoryId'])['name'] ?? null) : null,
                    'quantity' => $qty, 'reserved' => (int) ($srow['reserved'] ?? 0),
                    'available' => $qty - (int) ($srow['reserved'] ?? 0),
                    'minStock' => $min, 'avgCost' => $avg, 'stockValue' => Money::mul($avg, $qty),
                    'status' => $qty <= 0 ? 'out_of_stock' : ($min > 0 && $qty <= $min ? 'low_stock' : 'in_stock'),
                    'lastMovementAt' => $srow['lastMovementAt'] ?? null,
                ];
            }
        }

        if (!empty($q['status']) && $q['status'] !== 'all') {
            $rows = array_values(array_filter($rows, static fn ($x) => $x['status'] === $q['status']));
        }
        if (!empty($q['product'])) {
            $rows = array_values(array_filter($rows, static fn ($x) => $x['productId'] === $q['product']));
        }

        $result = self::paginate($rows, $q, ['name', 'sku', 'variantLabel'], ['name', 'quantity', 'available', 'stockValue', 'lastMovementAt'], 'name', 'asc');
        $result['summary'] = [
            'totalSkus' => count($rows),
            'inStock' => count(array_filter($rows, static fn ($r) => $r['status'] === 'in_stock')),
            'lowStock' => count(array_filter($rows, static fn ($r) => $r['status'] === 'low_stock')),
            'outOfStock' => count(array_filter($rows, static fn ($r) => $r['status'] === 'out_of_stock')),
            'totalValue' => array_sum(array_column($rows, 'stockValue')),
            'totalUnits' => array_sum(array_column($rows, 'quantity')),
        ];
        return Response::json($result);
    }

    private static function movements(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.view');
        $q = $ctx->request->query;
        $branchId = Branch::resolveId($ctx, $q['branchId'] ?? null);
        $where = ['branch_id = :b'];
        $params = [':b' => $branchId];
        if (!empty($q['product'])) {
            $where[] = 'product_id = :p';
            $params[':p'] = $q['product'];
        }
        if (!empty($q['type']) && $q['type'] !== 'all') {
            $where[] = 'type = :t';
            $params[':t'] = $q['type'];
        }
        $result = $ctx->repo()->list([
            'table' => 'inventory_transactions', 'query' => $q,
            'baseWhere' => implode(' AND ', $where), 'params' => $params,
            'sortMap' => ['at' => 'at', 'type' => 'type'], 'defaultSort' => 'at', 'defaultDir' => 'desc',
            'dateColumn' => 'at',
        ]);
        $result['data'] = array_map(function ($t) use ($ctx) {
            $p = $ctx->repo()->doc('products', $t['productId']);
            $t['productName'] = $p['name'] ?? $t['productId'];
            $t['sku'] = $p['sku'] ?? null;
            return $t;
        }, $result['data']);
        return Response::json($result);
    }

    private static function listAdjustments(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.view');
        $q = $ctx->request->query;
        $branchId = Branch::resolveId($ctx, $q['branchId'] ?? null);
        return Response::json($ctx->repo()->list([
            'table' => 'stock_adjustments', 'query' => $q,
            'baseWhere' => 'branch_id = :b', 'params' => [':b' => $branchId],
            'sortMap' => ['at' => 'at', 'reference' => 'reference', 'type' => 'type'],
            'defaultSort' => 'at', 'defaultDir' => 'desc',
            'filters' => ['type' => 'type', 'reason' => 'reason'], 'dateColumn' => 'at',
        ]));
    }

    private static function createAdjustment(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.adjust');
        $b = $ctx->body();
        $branch = Branch::require($ctx, $b['branchId'] ?? null);
        $lines = $b['lines'] ?? [];
        if (!$lines) {
            throw HttpError::badRequest('Add at least one product line to adjust');
        }
        $reason = $b['reason'] ?? 'manual';
        $valid = ['manual', 'damage', 'lost', 'expiry', 'theft', 'correction', 'recount'];
        if (!in_array($reason, $valid, true)) {
            throw HttpError::badRequest('Invalid adjustment reason');
        }

        return $ctx->db->transaction(function () use ($ctx, $b, $branch, $lines, $reason) {
            $ref = DocNo::next($ctx->repo(), 'stock_adjustment', 'ADJ-{YY}{MM}-{SEQ}', ['seqWidth' => 4]);
            $netUnits = 0;
            $valueImpact = 0;
            $ledgerIds = [];
            foreach ($lines as $line) {
                $product = $ctx->repo()->doc('products', $line['productId'] ?? '') ?? throw HttpError::notFound('Product in adjustment');
                $delta = (int) ($line['deltaQty'] ?? 0);
                if ($delta === 0) {
                    throw HttpError::badRequest("Invalid quantity for {$product['name']}");
                }
                $type = $delta > 0 ? 'adjustment' : (in_array($reason, ['damage', 'lost', 'expiry', 'theft'], true) ? $reason : 'adjustment');
                $unitCost = Ledger::avgCost($ctx, $branch['id'], $line['productId'], $line['variantId'] ?? null) ?: (int) ($product['costPrice'] ?? 0);
                $res = Ledger::post($ctx, [
                    'branchId' => $branch['id'], 'productId' => $line['productId'], 'variantId' => $line['variantId'] ?? null,
                    'type' => $type, 'qtyDelta' => $delta, 'unitCost' => $unitCost,
                    'refType' => 'stock_adjustment', 'refId' => $ref, 'note' => $line['note'] ?? $reason,
                ]);
                $ledgerIds[] = $res['ledger']['id'];
                $netUnits += $delta;
                $valueImpact += Money::mul($unitCost, $delta);
            }
            $id = Uuid::v4();
            $doc = [
                'id' => $id, 'reference' => $ref, 'branchId' => $branch['id'],
                'type' => $netUnits >= 0 ? 'increase' : 'decrease', 'reason' => $reason,
                'note' => $b['note'] ?? '', 'lines' => $lines, 'ledgerIds' => $ledgerIds,
                'netUnits' => $netUnits, 'valueImpact' => $valueImpact, 'at' => Clock::now(),
            ];
            $row = $ctx->repo()->insert('stock_adjustments', $id, $doc, [
                'reference' => $ref, 'branch_id' => $branch['id'], 'type' => $doc['type'], 'reason' => $reason, 'at' => $doc['at'],
            ]);
            Audit::record($ctx, 'adjust', 'stock_adjustment', $id, ['after' => $row, 'meta' => ['reference' => $ref, 'netUnits' => $netUnits]]);
            Notify::push($ctx, 'system', 'Stock adjusted', "{$ref}: " . ($netUnits >= 0 ? '+' : '') . "{$netUnits} units ({$reason}).", ['link' => '#/stock-adjustments']);
            return Response::json($row, 201);
        });
    }

    private static function listTransfers(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.view');
        $result = $ctx->repo()->list([
            'table' => 'stock_transfers', 'query' => $ctx->request->query,
            'sortMap' => ['at' => 'at', 'reference' => 'reference'], 'defaultSort' => 'at', 'defaultDir' => 'desc', 'dateColumn' => 'at',
        ]);
        $result['data'] = array_map(function ($t) use ($ctx) {
            $t['fromName'] = $ctx->repo()->doc('branches', $t['fromBranchId'] ?? '')['name'] ?? null;
            $t['toName'] = $ctx->repo()->doc('branches', $t['toBranchId'] ?? '')['name'] ?? null;
            return $t;
        }, $result['data']);
        return Response::json($result);
    }

    private static function createTransfer(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.transfer');
        $b = $ctx->body();
        $fromId = $b['fromBranchId'] ?? null;
        $toId = $b['toBranchId'] ?? null;
        if (!$fromId || !$toId || $fromId === $toId) {
            throw HttpError::badRequest('Choose two different branches');
        }
        $lines = $b['lines'] ?? [];
        if (!$lines) {
            throw HttpError::badRequest('Add at least one product line');
        }
        $from = $ctx->repo()->doc('branches', $fromId) ?? throw HttpError::notFound('Branch');
        $to = $ctx->repo()->doc('branches', $toId) ?? throw HttpError::notFound('Branch');

        return $ctx->db->transaction(function () use ($ctx, $b, $from, $to, $fromId, $toId, $lines) {
            $ref = DocNo::next($ctx->repo(), 'stock_transfer', 'TRF-{YY}{MM}-{SEQ}', ['seqWidth' => 4]);
            foreach ($lines as $line) {
                $qty = abs((int) ($line['qty'] ?? 0));
                if ($qty === 0) {
                    throw HttpError::badRequest('Transfer quantity must be greater than zero');
                }
                $avg = Ledger::avgCost($ctx, $fromId, $line['productId'], $line['variantId'] ?? null);
                Ledger::post($ctx, ['branchId' => $fromId, 'productId' => $line['productId'], 'variantId' => $line['variantId'] ?? null, 'type' => 'transfer_out', 'qtyDelta' => -$qty, 'unitCost' => $avg, 'refType' => 'stock_transfer', 'refId' => $ref, 'note' => "Transfer to {$to['name']}"]);
                Ledger::post($ctx, ['branchId' => $toId, 'productId' => $line['productId'], 'variantId' => $line['variantId'] ?? null, 'type' => 'transfer_in', 'qtyDelta' => $qty, 'unitCost' => $avg, 'refType' => 'stock_transfer', 'refId' => $ref, 'note' => "Transfer from {$from['name']}"]);
            }
            $id = Uuid::v4();
            $doc = ['id' => $id, 'reference' => $ref, 'fromBranchId' => $fromId, 'toBranchId' => $toId, 'lines' => $lines, 'note' => $b['note'] ?? '', 'status' => 'completed', 'at' => Clock::now()];
            $row = $ctx->repo()->insert('stock_transfers', $id, $doc, ['reference' => $ref, 'from_branch_id' => $fromId, 'to_branch_id' => $toId, 'status' => 'completed', 'at' => $doc['at']]);
            Audit::record($ctx, 'transfer', 'stock_transfer', $id, ['after' => $row, 'meta' => ['reference' => $ref]]);
            return Response::json($row, 201);
        });
    }

    private static function valuation(Context $ctx): Response
    {
        $ctx->requirePermission('inventory.valuation');
        $branchId = Branch::resolveId($ctx, $ctx->request->query['branchId'] ?? null);
        $stockRows = $ctx->repo()->allDocs('stock', 'branch_id = :b AND quantity <> 0', [':b' => $branchId]);
        $byCat = [];
        $cost = 0;
        $retail = 0;
        $units = 0;
        foreach ($stockRows as $s) {
            $p = $ctx->repo()->doc('products', $s['productId']);
            if (!$p) {
                continue;
            }
            $sell = $p['sellingPrice'] ?? 0;
            if (!empty($s['variantId'])) {
                foreach ($p['variants'] ?? [] as $v) {
                    if ($v['id'] === $s['variantId']) {
                        $sell = $v['sellingPrice'] ?? $sell;
                    }
                }
            }
            $cv = Money::mul((int) $s['avgCost'], (int) $s['quantity']);
            $rv = Money::mul((int) $sell, (int) $s['quantity']);
            $cost += $cv;
            $retail += $rv;
            $units += (int) $s['quantity'];
            $cat = !empty($p['categoryId']) ? ($ctx->repo()->doc('categories', $p['categoryId'])['name'] ?? 'Uncategorised') : 'Uncategorised';
            $acc = $byCat[$cat] ?? ['category' => $cat, 'units' => 0, 'costValue' => 0, 'retailValue' => 0];
            $acc['units'] += (int) $s['quantity'];
            $acc['costValue'] += $cv;
            $acc['retailValue'] += $rv;
            $byCat[$cat] = $acc;
        }
        usort($byCat, static fn ($a, $b) => $b['costValue'] <=> $a['costValue']);
        return Response::json([
            'branchId' => $branchId,
            'summary' => [
                'totalUnits' => $units, 'totalCostValue' => $cost, 'totalRetailValue' => $retail,
                'potentialProfit' => $retail - $cost,
                'marginPct' => $retail ? round(($retail - $cost) / $retail * 100, 1) : 0,
            ],
            'byCategory' => array_values($byCat),
        ]);
    }

    /** In-memory pagination for computed row sets, mirroring Repo::list output. */
    private static function paginate(array $rows, array $q, array $searchCols, array $sortCols, string $defSort, string $defDir): array
    {
        $search = mb_strtolower(trim((string) ($q['search'] ?? $q['q'] ?? '')));
        if ($search !== '') {
            $rows = array_values(array_filter($rows, static function ($r) use ($search, $searchCols) {
                foreach ($searchCols as $c) {
                    if (str_contains(mb_strtolower((string) ($r[$c] ?? '')), $search)) {
                        return true;
                    }
                }
                return false;
            }));
        }
        $total = count($rows);
        $sort = in_array($q['sort'] ?? '', $sortCols, true) ? $q['sort'] : $defSort;
        $dir = (($q['dir'] ?? $defDir) === 'asc') ? 1 : -1;
        usort($rows, static function ($a, $b) use ($sort, $dir) {
            $av = $a[$sort] ?? null;
            $bv = $b[$sort] ?? null;
            if (is_numeric($av) && is_numeric($bv)) {
                return ($av <=> $bv) * $dir;
            }
            return strnatcasecmp((string) $av, (string) $bv) * $dir;
        });
        $pageSize = ($q['pageSize'] ?? null) === 'all' ? max($total, 1) : min(500, max(1, (int) ($q['pageSize'] ?? 20)));
        $totalPages = max(1, (int) ceil($total / $pageSize));
        $page = min(max(1, (int) ($q['page'] ?? 1)), $totalPages);
        return [
            'data' => array_slice($rows, ($page - 1) * $pageSize, $pageSize),
            'page' => $page, 'pageSize' => $pageSize, 'total' => $total, 'totalPages' => $totalPages,
            'sort' => $sort, 'dir' => $dir === 1 ? 'asc' : 'desc',
        ];
    }
}
